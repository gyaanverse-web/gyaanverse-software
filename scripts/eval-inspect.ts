import '../src/config/env.js'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../src/shared/db.js'
import { exams } from '../src/modules/exam/exam.schema.js'
import { examSessions } from '../src/modules/exam-session/exam-session.schema.js'
import {
  evaluationJobs,
  ocrCache,
  questionResults,
} from '../src/modules/evaluation/evaluation.schema.js'
import { getEvaluationQueue } from '../src/modules/evaluation/evaluation.service.js'
import {
  findDrift,
  getReconcilerScheduleHealth,
} from '../src/modules/evaluation/evaluation.reconciler.js'
import { findBackstopCandidates } from '../src/modules/evaluation/evaluation.backstop.js'
import { getReviewQueueSummary } from '../src/modules/evaluation/evaluation.review.js'

// ─────────────────────────────────────────────────────────────────────────────
// Reads out the evaluation pipeline: the job rows, the BullMQ queue, and — the
// part that actually matters — the disagreements between them.
//
//   npm run eval:inspect                    last 20 jobs, all exams
//   npm run eval:inspect -- --exam <uuid>   scoped to one exam
//   npm run eval:inspect -- --limit 100
//   npm run eval:inspect -- --watch         re-render every 3s
//
// The database and Redis each hold half the truth and neither notices when the
// other drifts. Every stall in the resilience plan is a specific shape of drift:
//
//   orphan     job row exists, queue has forgotten it   → nothing will run it
//   expired    `processing` past its lease              → the worker died
//   unclaimed  session `submitted`, no job row at all   → quota soft-fail
//
// Since Phase 4 those three buckets come from the reconciler's own `findDrift`,
// so this screen shows exactly the set the next tick will repair — not a second
// opinion about it. With the worker running, a non-zero DRIFT is a *transient*
// reading that should return to zero within a tick or two; one that persists
// means the reconciler itself is stuck, which is worth investigating.
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const args = new Set(argv)

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const EXAM_ID = flagValue('--exam')
const LIMIT = Number(flagValue('--limit') ?? 20)
const WATCH = args.has('--watch')

const divider = '─'.repeat(78)

function age(from: Date | null): string {
  if (!from) return '—'
  const mins = Math.floor((Date.now() - from.getTime()) / 60000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h${mins % 60}m` : `${Math.floor(hrs / 24)}d`
}

function pad(v: unknown, n: number): string {
  const s = v === null || v === undefined ? '—' : String(v)
  return (s.length > n ? s.slice(0, n - 1) + '…' : s).padEnd(n)
}

async function render(): Promise<void> {
  // ── Job rows ──────────────────────────────────────────────────────────────
  const where = EXAM_ID ? eq(examSessions.examId, EXAM_ID) : undefined

  const jobs = await db
    .select({
      id: evaluationJobs.id,
      sessionId: evaluationJobs.sessionId,
      status: evaluationJobs.status,
      attempts: evaluationJobs.attempts,
      lastErrorCode: evaluationJobs.lastErrorCode,
      failureClass: evaluationJobs.failureClass,
      nextRetryAt: evaluationJobs.nextRetryAt,
      leaseExpiresAt: evaluationJobs.leaseExpiresAt,
      startedAt: evaluationJobs.startedAt,
      createdAt: evaluationJobs.createdAt,
      error: evaluationJobs.error,
      examId: examSessions.examId,
      sessionStatus: examSessions.status,
    })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(where)
    .orderBy(desc(evaluationJobs.createdAt))
    .limit(LIMIT)

  // ── Queue state ───────────────────────────────────────────────────────────
  // Headline counts only — the per-job queue lookup that used to live here now
  // happens inside findDrift, against the live states that actually matter.
  const counts = await getEvaluationQueue().getJobCounts()

  // ── Result counts per job ─────────────────────────────────────────────────
  const resultCounts = new Map<string, number>()
  if (jobs.length) {
    const rows = await db
      .select({ jobId: questionResults.jobId, n: sql<number>`count(*)::int` })
      .from(questionResults)
      .where(inArray(questionResults.jobId, jobs.map((j) => j.id)))
      .groupBy(questionResults.jobId)
    for (const r of rows) resultCounts.set(r.jobId, r.n)
  }

  // ── Drift ─────────────────────────────────────────────────────────────────
  //
  // Delegated to the reconciler's own `findDrift` rather than recomputed here.
  // What this screen shows IS the set the reconciler is about to repair, by
  // construction — and the local version used to miss a case the reconciler
  // must not: since Phase 2 a job sits in `failed` *between* attempts, so a
  // `failed` row whose queue entry has been evicted was invisible to a filter
  // that only looked at `pending`/`processing`.
  const nowMs = Date.now()
  const { orphans, expired, unclaimed } = await findDrift(
    EXAM_ID ? { examId: EXAM_ID } : {},
  )

  // ── OCR cache ─────────────────────────────────────────────────────────────
  // Global, not scoped to --exam: the whole point is that a read is paid for
  // once across every job that ever touches the image. `saved` is the count of
  // engine calls the cache avoided — it is what "a retry does not re-OCR" looks
  // like from outside, and it should climb whenever attempts do.
  const [cacheStats] = await db
    .select({
      images: sql<number>`count(*)::int`,
      saved: sql<number>`coalesce(sum(${ocrCache.hits}), 0)::int`,
    })
    .from(ocrCache)

  // ── Backstop / human review ───────────────────────────────────────────────
  //
  // The two ends of Phase 6. `pending` is what the next backstop tick will
  // settle (same function the sweep calls, same reasoning as DRIFT above);
  // `open` is what it already settled and handed to a Gyaanverse operator.
  //
  // Read them together. `pending` climbing means papers are about to be given
  // up on; `open` climbing and not falling means nobody is clearing the review
  // queue, and every exam holding one of those answers has a publish button
  // its teacher cannot press.
  const backstopPending = await findBackstopCandidates(EXAM_ID ? { examId: EXAM_ID } : {})
  const reviewSummary = await getReviewQueueSummary()

  // Whether the sweep is scheduled at all. Read before printing any reassurance
  // about drift clearing itself — see the DRIFT block below.
  const schedule = await getReconcilerScheduleHealth()

  // ── Exam-level view ───────────────────────────────────────────────────────
  const examIds = [...new Set(jobs.map((j) => j.examId))]
  const examRows = examIds.length
    ? await db
        .select({ id: exams.id, title: exams.title, status: exams.status })
        .from(exams)
        .where(inArray(exams.id, examIds))
    : []
  const examById = new Map(examRows.map((e) => [e.id, e]))

  // ── Render ────────────────────────────────────────────────────────────────
  if (WATCH) console.clear()

  console.log(`\n${divider}`)
  console.log(`  Evaluation pipeline${EXAM_ID ? `  ·  exam ${EXAM_ID.slice(0, 8)}` : ''}`)
  console.log(divider)
  console.log(
    `  queue   waiting ${counts.waiting}   active ${counts.active}   delayed ${counts.delayed}` +
      `   failed ${counts.failed}   completed ${counts.completed}`,
  )
  console.log(divider)

  if (jobs.length === 0) {
    console.log('  No evaluation jobs. Run `npm run eval:fixture` to make some.')
  } else {
    console.log(
      `  ${pad('job', 10)}${pad('status', 11)}${pad('att', 4)}${pad('res', 4)}` +
        `${pad('error code', 20)}${pad('class', 11)}${pad('lease', 8)}${pad('age', 6)}`,
    )
    console.log(`  ${'─'.repeat(74)}`)
    for (const j of jobs) {
      const lease =
        j.status !== 'processing' || !j.leaseExpiresAt
          ? '—'
          : j.leaseExpiresAt.getTime() < nowMs
            ? 'EXPIRED'
            : 'held'
      console.log(
        `  ${pad(j.id.slice(0, 8), 10)}${pad(j.status, 11)}${pad(j.attempts, 4)}` +
          `${pad(resultCounts.get(j.id) ?? 0, 4)}${pad(j.lastErrorCode, 20)}` +
          `${pad(j.failureClass, 11)}${pad(lease, 8)}${pad(age(j.createdAt), 6)}`,
      )
    }
  }

  console.log(divider)
  console.log('  DRIFT')
  console.log(`    orphan     ${orphans.length}\tjob row exists, queue has forgotten it`)
  console.log(`    expired    ${expired.length}\t\`processing\` past its lease — worker died`)
  console.log(`    unclaimed  ${unclaimed.length}\tsession submitted, no job row ever created`)

  // `findDrift` puts each job in exactly one bucket (an expired lease is graded
  // as `expired`, not double-counted as an orphan), so these do add up.
  const stuckTotal = orphans.length + expired.length + unclaimed.length
  if (stuckTotal > 0) {
    console.log('')
    console.log(`    ${stuckTotal} session(s) awaiting repair.`)
    console.log('    Any exam holding one cannot reach ready_to_publish until the')
    console.log('    reconciler clears it.')
    // Never tell the operator "this will clear itself if the worker is running"
    // without checking whether the sweep is actually scheduled. Phase 9 printed
    // exactly that line at a worker that was running and a schedule that had
    // been deleted by a Redis flush, and the number never moved.
    if (schedule.scheduled) {
      const due = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null
      const overdue = due !== null && due.getTime() < nowMs - 2 * schedule.everyMs
      console.log(
        overdue
          ? `    ⚠ tick was due at ${due!.toISOString()} and has not run — the` +
              ' reconciler is scheduled but not firing.'
          : '    Expect 0 within ~2 ticks (reconciler scheduled every' +
              ` ${Math.round(schedule.everyMs / 1000)}s).`,
      )
    } else {
      console.log('    ⚠ THE RECONCILER IS NOT SCHEDULED. Nothing will repair these.')
      console.log('      A Redis flush/failover deletes the repeat entry. Restarting')
      console.log('      the worker re-registers it (npm run dev:worker).')
    }
  }

  console.log(divider)
  console.log('  BACKSTOP')
  console.log(
    `    pending    ${backstopPending.length}\tpast N attempts / T hours — next tick settles these`,
  )
  console.log(
    `    open       ${reviewSummary.open}\tanswer(s) flagged, waiting on a Gyaanverse operator`,
  )
  if (reviewSummary.open > 0) {
    for (const c of reviewSummary.byCode) {
      console.log(`      ${pad(c.lastErrorCode ?? 'none', 20)}${c.n}`)
    }
    console.log('')
    console.log('    Every exam holding one of these has a publish button its teacher')
    console.log('    cannot press. Clear them: GET /internal/evaluation/review-queue')
    console.log('    then POST /internal/evaluation/results/:resultId/override.')
  }

  console.log(divider)
  console.log(
    `  OCR CACHE   ${cacheStats?.images ?? 0} image(s) read   ` +
      `${cacheStats?.saved ?? 0} engine call(s) saved`,
  )

  if (examRows.length) {
    console.log(divider)
    console.log('  EXAMS')
    for (const [id, e] of examById) {
      const mine = jobs.filter((j) => j.examId === id)
      const done = mine.filter((j) => j.status === 'completed').length
      console.log(`    ${pad(e.status, 18)}${pad(`${done}/${mine.length} evaluated`, 18)}${e.title}`)
      console.log(`    ${' '.repeat(18)}${id}`)
    }
  }

  const withErrors = jobs.filter((j) => j.error)
  if (withErrors.length) {
    console.log(divider)
    console.log('  LAST ERRORS')
    for (const j of withErrors.slice(0, 5)) {
      console.log(`    ${j.id.slice(0, 8)}  ${j.error?.slice(0, 64)}`)
    }
  }

  console.log(`${divider}\n`)
}

if (WATCH) {
  console.log('  watching — Ctrl+C to stop')
  for (;;) {
    await render()
    await new Promise((r) => setTimeout(r, 3000))
  }
} else {
  await render()
  process.exit(0)
}
