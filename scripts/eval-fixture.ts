import '../src/config/env.js'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/shared/db.js'
import { users } from '../src/modules/auth/auth.schema.js'
import { tenants } from '../src/modules/tenant/tenant.schema.js'
import { memberships } from '../src/modules/membership/membership.schema.js'
import { subjects } from '../src/modules/question-bank/question-bank.schema.js'
import { exams, examStatusHistory, questions } from '../src/modules/exam/exam.schema.js'
import { examSessions, sessionAnswers } from '../src/modules/exam-session/exam-session.schema.js'
import { evaluationJobs } from '../src/modules/evaluation/evaluation.schema.js'
import { enqueueEvaluation } from '../src/modules/evaluation/evaluation.service.js'
import {
  BACKSTOP_AFTER_MS,
  UNGRADEABLE_ATTEMPTS,
} from '../src/modules/evaluation/evaluation.retry.js'

// ─────────────────────────────────────────────────────────────────────────────
// Drops a fully-formed exam straight into `under_evaluation` with submitted
// sessions waiting on the AI, skipping the entire teacher-authors → owner-
// approves → student-attempts → auto-submit chain. That chain is minutes of
// clicking to reach a code path that takes seconds to test.
//
//   npm run eval:fixture                       2 sessions, 2 subjective questions
//   npm run eval:fixture -- --sessions 200     throughput fixture (Phase 5)
//   npm run eval:fixture -- --image <url>      point at a real handwritten answer
//   npm run eval:fixture -- --question "<q>"   the question that answer answers
//   npm run eval:fixture -- --no-enqueue       job rows only, nothing queued
//   npm run eval:fixture -- --stuck            simulate stall path #3 (see below)
//   npm run eval:fixture -- --exam <uuid>      add sessions to an existing exam
//
// Every run builds a NEW exam by default, so runs never interfere with each
// other and you can leave the wreckage of a failed experiment lying around.
//
// ── The two failure fixtures ────────────────────────────────────────────────
//
//   --stuck      Writes job rows as `processing` with an already-expired lease
//                and no BullMQ entry at all. This is stall path #3: a worker
//                that died mid-run. Before Phase 4 nothing could recover it —
//                the tenant-facing retry (deleted in Phase 8) answered 409
//                because the row claimed to be running. It is the fixture the
//                reconciler has to beat, and a running worker clears it.
//
//   --no-enqueue Job rows with no queue entry, still `pending`. Stall path #4,
//                the evicted/forgotten job.
//
//   --exhausted  Job rows already parked at `needs_human` and backdated past
//                BACKSTOP_AFTER_MS. The Phase 6 fixture: the backstop should
//                settle these within a tick, the exam should reach
//                `ready_to_publish`, and publishing should be refused until the
//                flagged answers are scored through /internal/evaluation/*.
//
// ── About the answer image ──────────────────────────────────────────────────
//
// The default is Cloudinary's own demo asset — permanently available, so the
// engine call is real rather than a 404. It is a photograph, not handwriting,
// so OCR returns few or no steps: since Phase 2 that means OCR_EMPTY, retried
// `OCR_EMPTY_ATTEMPTS` times and then parked as `needs_human` (it used to
// silently write score 0 and mark the job completed).
//
// --image also takes a LOCAL ABSOLUTE PATH, not just a URL. The engine
// base64-encodes anything that isn't http(s):// or a data: URI, and
// buildOcrFriendlyUrl leaves non-Cloudinary strings alone — so
// `--image G:/…/AI_Engines/Data/test_image1.jpeg` runs the real pipeline over
// real handwriting without an upload. (Or set EVAL_FIXTURE_IMAGE.)
//
// Engine calls cost money: one run is SESSION_COUNT × QUESTION_COUNT OCR calls
// plus the same number of evaluations. `--sessions 1 --questions 1` is the
// cheapest useful fixture.
//
// Fixture students are created without credential accounts — they exist to own
// sessions, not to log in. The first three are the exception, so you can sign
// in as one and look at the student results screen.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  console.error('\n  ERROR: fixture script is not allowed in production.\n')
  process.exit(1)
}

const argv = process.argv.slice(2)
const args = new Set(argv)

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const SESSION_COUNT = Number(flagValue('--sessions') ?? 2)
const QUESTION_COUNT = Number(flagValue('--questions') ?? 2)
// Pair with --image when testing against the real engine: grading a real answer
// sheet against a placeholder question body produces a real API bill for a
// meaningless result.
const QUESTION_TEXT = flagValue('--question')
const EXISTING_EXAM = flagValue('--exam')
const ANSWER_IMAGE =
  flagValue('--image') ??
  process.env.EVAL_FIXTURE_IMAGE ??
  'https://res.cloudinary.com/demo/image/upload/sample.jpg'
const NO_ENQUEUE = args.has('--no-enqueue')
const STUCK = args.has('--stuck')
const EXHAUSTED = args.has('--exhausted')
const TENANT_SLUG = process.env.EVAL_FIXTURE_TENANT ?? 'dev'
const MARKS_PER_QUESTION = 10

if (!Number.isInteger(SESSION_COUNT) || SESSION_COUNT < 1) {
  console.error('\n  ERROR: --sessions must be a positive integer.\n')
  process.exit(1)
}
if (!Number.isInteger(QUESTION_COUNT) || QUESTION_COUNT < 1) {
  console.error('\n  ERROR: --questions must be a positive integer.\n')
  process.exit(1)
}

// ── Resolve the seeded world ─────────────────────────────────────────────────

const [tenant] = await db
  .select({ id: tenants.id, name: tenants.name, plan: tenants.plan })
  .from(tenants)
  .where(eq(tenants.slug, TENANT_SLUG))
  .limit(1)

if (!tenant) {
  console.error(`\n  ERROR: no tenant with slug '${TENANT_SLUG}'. Run \`npm run db:seed\` first.\n`)
  process.exit(1)
}

const [teacher] = await db
  .select({ id: users.id })
  .from(users)
  .where(and(eq(users.tenantId, tenant.id), eq(users.role, 'teacher')))
  .limit(1)

if (!teacher) {
  console.error(`\n  ERROR: tenant '${TENANT_SLUG}' has no teacher. Run \`npm run db:seed\` first.\n`)
  process.exit(1)
}

const [subject] = await db
  .select({ id: subjects.id, name: subjects.name })
  .from(subjects)
  .where(eq(subjects.tenantId, tenant.id))
  .limit(1)

// ── Exam ─────────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().slice(11, 19)
const totalMarks = QUESTION_COUNT * MARKS_PER_QUESTION
let examId: string
let examTitle: string

if (EXISTING_EXAM) {
  const [existing] = await db
    .select({ id: exams.id, title: exams.title, tenantId: exams.tenantId })
    .from(exams)
    .where(eq(exams.id, EXISTING_EXAM))
    .limit(1)
  if (!existing) {
    console.error(`\n  ERROR: no exam ${EXISTING_EXAM}.\n`)
    process.exit(1)
  }
  if (existing.tenantId !== tenant.id) {
    console.error(`\n  ERROR: exam ${EXISTING_EXAM} belongs to another tenant.\n`)
    process.exit(1)
  }
  examId = existing.id
  examTitle = existing.title
} else {
  examId = crypto.randomUUID()
  examTitle = `[fixture ${stamp}] Subjective Paper`
  const now = new Date()
  await db.insert(exams).values({
    id: examId,
    tenantId: tenant.id,
    createdBy: teacher.id,
    title: examTitle,
    description: 'Generated by eval-fixture. Safe to delete.',
    durationMins: 60,
    gradeLevel: '12',
    subjectId: subject?.id ?? null,
    scopeType: 'custom',
    visibility: 'private',
    maxAttempts: 1,
    // Parked exactly where the AI matters: the window has closed, every session
    // is in, and the exam cannot advance until all of them are settled.
    status: 'under_evaluation',
    totalMarks,
    publishedAt: now,
    scheduledAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() - 60 * 60 * 1000),
  })
  await db.insert(examStatusHistory).values({
    examId,
    fromStatus: null,
    toStatus: 'under_evaluation',
    actorId: null,
    remarks: 'Created by eval-fixture',
  })
}

// ── Questions ────────────────────────────────────────────────────────────────

const questionIds: string[] = []
if (EXISTING_EXAM) {
  const existingQs = await db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.examId, examId), eq(questions.type, 'subjective')))
  questionIds.push(...existingQs.map((q) => q.id))
  if (questionIds.length === 0) {
    console.error(`\n  ERROR: exam ${examId} has no subjective questions to evaluate.\n`)
    process.exit(1)
  }
} else {
  const rows = Array.from({ length: QUESTION_COUNT }, (_, i) => ({
    id: crypto.randomUUID(),
    examId,
    tenantId: tenant.id,
    order: i + 1,
    type: 'subjective' as const,
    difficulty: 'medium',
    body: QUESTION_TEXT ?? `Q${i + 1}. Derive the expression and show every step of your working.`,
    payload: {},
    answerKey: { rubric: 'Award marks per correct step.' },
    marks: MARKS_PER_QUESTION,
    negativeMarks: 0,
  }))
  await db.insert(questions).values(rows)
  questionIds.push(...rows.map((r) => r.id))
}

// ── Students ─────────────────────────────────────────────────────────────────
// Dedicated fixture students rather than the two seeded ones, because
// (exam_id, student_id, attempt_number) is unique — reusing students would cap
// every exam at two sessions and make --sessions 200 impossible.

const [{ existingCount }] = await db
  .select({ existingCount: sql<number>`count(*)::int` })
  .from(users)
  .where(sql`${users.email} like 'evalfixture%@dev.local'`)

const studentIds: string[] = []
const existing = await db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(sql`${users.email} like 'evalfixture%@dev.local'`)
  .orderBy(users.email)

const byEmail = new Map(existing.map((u) => [u.email, u.id]))
const toCreate: { id: string; email: string; name: string; tenantId: string }[] = []

for (let i = 1; i <= SESSION_COUNT; i++) {
  const email = `evalfixture${String(i).padStart(3, '0')}@dev.local`
  const found = byEmail.get(email)
  if (found) {
    studentIds.push(found)
    continue
  }
  const id = crypto.randomUUID()
  toCreate.push({ id, email, name: `Fixture Student ${i}`, tenantId: tenant.id })
  studentIds.push(id)
}

if (toCreate.length) {
  await db.insert(users).values(
    toCreate.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      emailVerified: true,
      isProfileComplete: true,
      role: 'student',
      tenantId: u.tenantId,
    })),
  )
  await db.insert(memberships).values(
    toCreate.map((u) => ({
      id: crypto.randomUUID(),
      userId: u.id,
      tenantId: tenant.id,
      role: 'student',
    })),
  )
}

// ── Sessions + answers ───────────────────────────────────────────────────────

const now = new Date()
const sessionRows = studentIds.map((studentId) => ({
  id: crypto.randomUUID(),
  examId,
  studentId,
  tenantId: tenant.id,
  attemptNumber: 1,
  // `submitted` means "objective marking done, subjective answers with the AI".
  // This is the exact state the lifecycle tick blocks on.
  status: 'submitted',
  startedAt: new Date(now.getTime() - 90 * 60 * 1000),
  expiresAt: new Date(now.getTime() - 30 * 60 * 1000),
  submittedAt: new Date(now.getTime() - 30 * 60 * 1000),
  autoScore: 0,
  manualScore: null,
  totalMarks: questionIds.length * MARKS_PER_QUESTION,
}))

await db.insert(examSessions).values(sessionRows)

await db.insert(sessionAnswers).values(
  sessionRows.flatMap((s) =>
    questionIds.map((questionId) => ({
      id: crypto.randomUUID(),
      sessionId: s.id,
      questionId,
      answer: null,
      imageUrl: ANSWER_IMAGE,
      isCorrect: null,
      awardedMarks: null,
    })),
  ),
)

// ── Hand off to the evaluation pipeline ──────────────────────────────────────

let enqueued = 0
let skipped = 0
const jobIds: string[] = []

if (STUCK) {
  // Straight into the unrecoverable state: claimed, lease already lapsed, and
  // no queue entry behind it. Deliberately bypasses enqueueEvaluation.
  const rows = sessionRows.map((s) => ({
    id: crypto.randomUUID(),
    sessionId: s.id,
    tenantId: tenant.id,
    status: 'processing',
    attempts: 1,
    startedAt: new Date(now.getTime() - 45 * 60 * 1000),
    leaseExpiresAt: new Date(now.getTime() - 35 * 60 * 1000),
  }))
  await db.insert(evaluationJobs).values(rows)
  jobIds.push(...rows.map((r) => r.id))
} else if (NO_ENQUEUE) {
  const rows = sessionRows.map((s) => ({
    id: crypto.randomUUID(),
    sessionId: s.id,
    tenantId: tenant.id,
    status: 'pending',
  }))
  await db.insert(evaluationJobs).values(rows)
  jobIds.push(...rows.map((r) => r.id))
} else if (EXHAUSTED) {
  // The Phase 6 fixture. Backdated past BACKSTOP_AFTER_MS because the bound is
  // six hours and nobody is going to sit through that to test a sweep — the
  // clock is the only thing being faked here, every other field is exactly what
  // a genuinely unreadable paper leaves behind after the ladder gives up.
  const backdated = new Date(now.getTime() - BACKSTOP_AFTER_MS - 60 * 60 * 1000)
  const rows = sessionRows.map((s) => ({
    id: crypto.randomUUID(),
    sessionId: s.id,
    tenantId: tenant.id,
    status: 'failed',
    attempts: UNGRADEABLE_ATTEMPTS,
    startedAt: backdated,
    completedAt: backdated,
    createdAt: backdated,
    error: 'OCR returned no readable text',
    lastErrorCode: 'OCR_EMPTY',
    failureClass: 'needs_human',
    // Terminal — the "do not resurrect" marker the reconciler honours. Without
    // this the reconciler would re-enqueue these before the backstop saw them.
    nextRetryAt: null,
  }))
  await db.insert(evaluationJobs).values(rows)
  jobIds.push(...rows.map((r) => r.id))
} else {
  // The real entry point. Since Phase 2 a null return no longer means "over
  // quota" — quota is metered, not enforced — so it can only mean the session
  // or its exam vanished underneath us, which for a fixture is a script bug.
  for (const s of sessionRows) {
    const result = await enqueueEvaluation(s.id)
    if (result) {
      enqueued++
      jobIds.push(result.jobId)
    } else {
      skipped++
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const divider = '─'.repeat(64)
console.log(`\n${divider}`)
console.log('  Evaluation fixture ready')
console.log(divider)
console.log(`  tenant       ${tenant.name}  (${TENANT_SLUG}, plan: ${tenant.plan})`)
console.log(`  exam         ${examTitle}`)
console.log(`  exam id      ${examId}`)
console.log(`  status       under_evaluation`)
console.log(`  subject      ${subject?.name ?? '(none — engine uses EVAL_DEFAULT_COLLECTION)'}`)
console.log(`  questions    ${questionIds.length} subjective × ${MARKS_PER_QUESTION} marks`)
console.log(`  sessions     ${sessionRows.length} submitted`)
console.log(`  students     ${toCreate.length} created, ${existingCount} reused`)
console.log(`  image        ${ANSWER_IMAGE}`)
console.log(divider)

if (STUCK) {
  console.log('  mode         --stuck: jobs are `processing` with an EXPIRED lease')
  console.log('               and no queue entry. Stall path #3.')
  console.log(`  jobs         ${jobIds.length} written directly`)
  console.log('')
  console.log('  Only the reconciler can clear these — a manual retry never could,')
  console.log('  the rows claim to be running. Start a worker: DRIFT should go to zero.')
} else if (NO_ENQUEUE) {
  console.log('  mode         --no-enqueue: job rows exist, queue is empty. Stall path #4.')
  console.log(`  jobs         ${jobIds.length} written directly`)
} else if (EXHAUSTED) {
  console.log('  mode         --exhausted: jobs parked `needs_human`, backdated past')
  console.log('               BACKSTOP_AFTER_MS. The Phase 6 acceptance fixture.')
  console.log(`  jobs         ${jobIds.length} written directly`)
  console.log('')
  console.log('  Expect, within a tick or two of a running worker:')
  console.log('    · sessions settled `evaluated`, exam reaches ready_to_publish')
  console.log('    · eval:inspect BACKSTOP open = one per answer')
  console.log('    · publishing the exam refused — "still being reviewed by Gyanverse"')
} else {
  console.log(`  enqueued     ${enqueued} of ${sessionRows.length}`)
  console.log(`  engine calls ~${enqueued * questionIds.length} OCR + ${enqueued * questionIds.length} evaluate`)
  if (skipped > 0) {
    console.log('')
    console.log(`  ⚠  ${skipped} session(s) got NO job row — enqueueEvaluation returned null.`)
    console.log('     Since Phase 2 that can only mean the session or exam disappeared;')
    console.log('     an over-quota tenant is evaluated anyway. Treat this as a bug.')
  }
}

console.log(divider)
console.log('  Next:')
console.log('    npm run dev:worker         if it is not already running')
console.log('    npm run eval:inspect       job rows, queue state, and the drift between them')
console.log(`    npm run eval:inspect -- --exam ${examId}`)
console.log(`${divider}\n`)

process.exit(0)
