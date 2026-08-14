import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { exams } from '@modules/exam/exam.schema.js'
import { evaluationJobs, questionResults } from '@modules/evaluation/evaluation.schema.js'
import { reports } from '@modules/report/report.schema.js'
import {
  closeFinishedSettledJobs,
  findBackstopCandidates,
  findUnclosedSettledJobs,
  runBackstopSweep,
  settleJob,
} from '@modules/evaluation/evaluation.backstop.js'
import {
  countOpenReviewsForExam,
  listReviewQueue,
  overrideQuestionResult,
} from '@modules/evaluation/evaluation.review.js'
import { publishResults } from '@modules/exam/exam.service.js'
import {
  createReportForSession,
  recomputeReportForSession,
} from '@modules/report/report.service.js'
import {
  BACKSTOP_AFTER_MS,
  BACKSTOP_MAX_ATTEMPTS,
  UNGRADEABLE_ATTEMPTS,
} from '@modules/evaluation/evaluation.retry.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createSessionAnswer,
  createTestExam,
  createTestQuestion,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// Mocked so the last group can run the REAL `processJob` over a settled job
// without an engine — the question there is whether a human's score survives a
// re-grade, and the honest way to answer it is to actually re-grade.
const engine = vi.hoisted(() => ({
  ocrImage: vi.fn(),
  evaluateSteps: vi.fn(),
}))

vi.mock('@modules/evaluation/evaluation.engine.js', () => ({
  ocrImage: engine.ocrImage,
  evaluateSteps: engine.evaluateSteps,
  indexDocuments: vi.fn(),
  indexTextDocuments: vi.fn(),
}))

const { processJob, getSessionEvaluation } = await import(
  '@modules/evaluation/evaluation.service.js'
)

/** One fully-right step — `scoreFromSteps` turns this into full marks. */
const GRADED = {
  response: [
    {
      stepId: '1',
      text: 'v = u + at = 20 m/s',
      step_status: 'right' as const,
      step_weight: 1,
      topic: 'kinematics',
      step_understanding: 'ok',
      description: 'correct',
    },
  ],
}

beforeEach(() => {
  engine.ocrImage.mockReset().mockResolvedValue([{ stepId: '1', text: 'v = u + at = 20 m/s' }])
  engine.evaluateSteps.mockReset().mockResolvedValue(GRADED)
})

// The backstop is where "AI evaluation never fails" stops being literally true
// and starts being honest. Every test here is some version of the same
// question: **did a cohort get its results, and did a placeholder ever reach a
// student as a real mark?** Those two have to both come out yes/no in that
// order, and most of the ways to get one right get the other wrong.
//
// The bounds are six hours and thirty attempts, so everything is backdated —
// the clock is faked, nothing else is.

const IMAGE = 'https://cdn.example.com/answers/a1.jpg'

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000)
const pastT = () => new Date(Date.now() - BACKSTOP_AFTER_MS - 3_600_000)

async function patchJob(jobId: string, fields: Partial<typeof evaluationJobs.$inferInsert>) {
  await db.update(evaluationJobs).set(fields).where(eq(evaluationJobs.id, jobId))
}

async function jobRow(jobId: string) {
  const [row] = await db.select().from(evaluationJobs).where(eq(evaluationJobs.id, jobId))
  return row
}

async function sessionRow(sessionId: string) {
  const [row] = await db.select().from(examSessions).where(eq(examSessions.id, sessionId))
  return row
}

async function resultsFor(jobId: string) {
  return db.select().from(questionResults).where(eq(questionResults.jobId, jobId))
}

/**
 * A paper the pipeline gave up on: one submitted session, one answered
 * subjective question, and a job parked at `needs_human` past T.
 *
 * This is `eval:fixture -- --exhausted` in miniature.
 */
async function seedExhausted(opts: { questions?: number; status?: 'under_evaluation' } = {}) {
  const { tenant, owner, student } = await seedTenantWithUsers()
  const exam = await createTestExam({
    tenantId: tenant.id,
    createdBy: owner.id,
    status: opts.status ?? 'under_evaluation',
    totalMarks: 10 * (opts.questions ?? 1),
  })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'submitted',
    totalMarks: 10 * (opts.questions ?? 1),
    autoScore: 0,
  })

  const qs = []
  for (let i = 0; i < (opts.questions ?? 1); i++) {
    const q = await createTestQuestion({
      examId: exam.id,
      tenantId: tenant.id,
      order: i + 1,
      type: 'subjective',
      marks: 10,
    })
    await createSessionAnswer({ sessionId: session.id, questionId: q.id, imageUrl: IMAGE })
    qs.push(q)
  }

  const job = await createEvaluationJob({
    sessionId: session.id,
    tenantId: tenant.id,
    status: 'failed',
  })
  await patchJob(job.id, {
    attempts: UNGRADEABLE_ATTEMPTS,
    failureClass: 'needs_human',
    lastErrorCode: 'OCR_EMPTY',
    error: 'OCR returned no readable text',
    nextRetryAt: null,
    createdAt: pastT(),
    completedAt: pastT(),
  })

  return { tenant, owner, student, exam, session, job, questions: qs }
}

describe('backstop — what it picks up, and what it leaves alone', () => {
  it('claims a needs_human job once it is past T', async () => {
    const { job } = await seedExhausted()
    const found = await findBackstopCandidates()
    expect(found.map((c) => c.jobId)).toContain(job.id)
  })

  it('leaves a needs_human job alone before T', async () => {
    // The point of T is that an operator gets a window to fix the underlying
    // problem before a placeholder is written. Settling on the third failed
    // attempt — 35 seconds after submission — would skip that window entirely.
    const { job } = await seedExhausted()
    await patchJob(job.id, { createdAt: hoursAgo(1), completedAt: hoursAgo(1) })

    const found = await findBackstopCandidates()
    expect(found.map((c) => c.jobId)).not.toContain(job.id)
  })

  it('leaves a transient job alone past T until it has also burned N attempts', async () => {
    // Both bounds, never either. A job that burned 30 attempts inside the first
    // hour of an outage is still in the window where the engine coming back
    // would grade it properly.
    const { job } = await seedExhausted()
    await patchJob(job.id, { failureClass: 'transient', attempts: 4, nextRetryAt: new Date() })
    expect((await findBackstopCandidates()).map((c) => c.jobId)).not.toContain(job.id)

    await patchJob(job.id, { attempts: BACKSTOP_MAX_ATTEMPTS })
    expect((await findBackstopCandidates()).map((c) => c.jobId)).toContain(job.id)
  })

  it('ignores a job whose session already settled', async () => {
    // A worker that finally succeeded, or a previous sweep. Either way there is
    // nothing holding the exam back and nothing to place a placeholder over.
    const { job, session } = await seedExhausted()
    await db
      .update(examSessions)
      .set({ status: 'evaluated' })
      .where(eq(examSessions.id, session.id))

    expect((await findBackstopCandidates()).map((c) => c.jobId)).not.toContain(job.id)
  })

  it('ignores a job that is still pending or processing', async () => {
    // Drift, not exhaustion — the reconciler's problem. Reaching in from here
    // would settle a session that is about to be graded properly.
    const { job } = await seedExhausted()
    await patchJob(job.id, { status: 'processing' })
    expect((await findBackstopCandidates()).map((c) => c.jobId)).not.toContain(job.id)
  })

  it('does not settle the same job twice', async () => {
    const { job } = await seedExhausted()
    const first = await runBackstopSweep()
    expect(first.settled).toBeGreaterThanOrEqual(1)

    // settled_at is the idempotency marker; a second tick must be a no-op.
    const second = await findBackstopCandidates()
    expect(second.map((c) => c.jobId)).not.toContain(job.id)
    expect((await jobRow(job.id)).settledAt).not.toBeNull()
  })
})

describe('backstop — settling', () => {
  it('settles the session so the exam can move on, flagging the unread answer', async () => {
    const { job, session, questions } = await seedExhausted()

    const [candidate] = await findBackstopCandidates()
    const result = await settleJob(candidate)

    expect(result).toEqual({ flagged: 1, score: 0 })

    // The whole reason this exists: the session is no longer blocking the
    // lifecycle's `in_progress | submitted` count.
    expect((await sessionRow(session.id)).status).toBe('evaluated')

    const rows = await resultsFor(job.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].questionId).toBe(questions[0].id)
    expect(rows[0].score).toBe(0)
    expect(rows[0].reviewStatus).toBe('needs_human')
  })

  it('does not flag a question the student never answered', async () => {
    // A blank answer is a 0 the student earned, not a review task. Flagging it
    // would bury the real failures under a queue of unanswered questions.
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      status: 'under_evaluation',
    })
    const session = await createTestSession({
      examId: exam.id,
      studentId: student.id,
      tenantId: tenant.id,
      status: 'submitted',
      autoScore: 0,
    })
    const answered = await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 1 })
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 2 }) // no answer row
    await createSessionAnswer({ sessionId: session.id, questionId: answered.id, imageUrl: IMAGE })

    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, {
      attempts: UNGRADEABLE_ATTEMPTS,
      failureClass: 'needs_human',
      createdAt: pastT(),
    })

    const [candidate] = await findBackstopCandidates({ examId: exam.id })
    const result = await settleJob(candidate)

    expect(result?.flagged).toBe(1)
    expect(await resultsFor(job.id)).toHaveLength(1)
  })

  it('never overwrites a score the engine actually produced', async () => {
    // A two-question paper where Q1 graded fine and Q2 never did. The placeholder
    // belongs only on Q2, and the roll-up has to carry Q1's real marks.
    const { job, questions } = await seedExhausted({ questions: 2 })
    await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 7,
      maxScore: 10,
      imageUrl: IMAGE,
    })

    const [candidate] = await findBackstopCandidates()
    const result = await settleJob(candidate)

    expect(result).toEqual({ flagged: 1, score: 7 })

    const rows = await resultsFor(job.id)
    const q1 = rows.find((r) => r.questionId === questions[0].id)!
    const q2 = rows.find((r) => r.questionId === questions[1].id)!
    expect(q1.score).toBe(7)
    expect(q1.reviewStatus).toBe('ai')
    expect(q2.score).toBe(0)
    expect(q2.reviewStatus).toBe('needs_human')
  })

  it('writes no report while an answer is flagged', async () => {
    // `reports` is student-facing and, for a public exam, visible the moment it
    // exists. Building one here would hand a student a placeholder 0 as a
    // finished mark — the one outcome this design exists to prevent.
    const { session } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    const rows = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(rows).toHaveLength(0)
  })

  it('writes the report immediately when nothing needed flagging', async () => {
    // A `permanent` failure on a paper with no answered subjective questions:
    // the session settles, nobody has to look at anything, so it behaves exactly
    // like the happy path.
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      status: 'under_evaluation',
    })
    const session = await createTestSession({
      examId: exam.id,
      studentId: student.id,
      tenantId: tenant.id,
      status: 'submitted',
      autoScore: 4,
    })
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, { failureClass: 'permanent', createdAt: pastT() })

    const [candidate] = await findBackstopCandidates({ examId: exam.id })
    const result = await settleJob(candidate)

    expect(result?.flagged).toBe(0)
    const rows = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(rows).toHaveLength(1)
  })
})

describe('publish gate', () => {
  it('refuses to publish while an answer is with a Gyanverse operator', async () => {
    const { tenant, owner, exam, session } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    expect(await countOpenReviewsForExam(exam.id)).toBe(1)

    // The exam is fully evaluated — the teacher has their roster and their
    // marks. Only the last click waits, and it waits on Gyanverse.
    await db.update(exams).set({ status: 'ready_to_publish' }).where(eq(exams.id, exam.id))
    expect((await sessionRow(session.id)).status).toBe('evaluated')

    await expect(publishResults(exam.id, tenant.id, owner.id, 'coaching_owner')).rejects.toThrow(
      /still being reviewed by Gyanverse/,
    )

    // And nothing in the refusal says "failed", "error" or "retry".
    await publishResults(exam.id, tenant.id, owner.id, 'coaching_owner').catch((err: Error) => {
      expect(err.message).not.toMatch(/fail|error|retry/i)
    })
  })

  it('lets the publish through once the answer is scored', async () => {
    const { tenant, owner, exam } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)
    await db.update(exams).set({ status: 'ready_to_publish' }).where(eq(exams.id, exam.id))

    const [item] = (await listReviewQueue({ examId: exam.id })).items
    await overrideQuestionResult({ resultId: item.resultId, score: 8, reviewerId: owner.id })

    expect(await countOpenReviewsForExam(exam.id)).toBe(0)
    await expect(
      publishResults(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).resolves.toBeTruthy()
  })
})

describe('the manual path', () => {
  it('surfaces the flagged answer with everything an operator needs to score it', async () => {
    const { exam, tenant, student, questions } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    const { items, total } = await listReviewQueue({ examId: exam.id })
    expect(total).toBe(1)
    expect(items[0]).toMatchObject({
      questionId: questions[0].id,
      tenantId: tenant.id,
      studentName: student.name,
      maxScore: 10,
      imageUrl: IMAGE,
      // The ops trail survives the settle — it is the only record of WHY a
      // person is needed, and the queue is what reads it.
      lastErrorCode: 'OCR_EMPTY',
    })
  })

  it('records the human score, preserves the AI number, and rolls the session up', async () => {
    const { owner, session, job } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    const [item] = (await listReviewQueue()).items
    const result = await overrideQuestionResult({
      resultId: item.resultId,
      score: 9,
      note: 'Photo was too dark for OCR; working is correct through to the final line.',
      reviewerId: owner.id,
    })

    expect(result.sessionScore).toBe(9)
    expect((await sessionRow(session.id)).manualScore).toBe(9)

    const [row] = await resultsFor(job.id)
    expect(row.score).toBe(9)
    expect(row.aiScore).toBe(0) // the placeholder, kept as evidence of the miss
    expect(row.reviewStatus).toBe('resolved')
    expect(row.reviewedBy).toBe(owner.id)
    expect(row.reviewNote).toMatch(/too dark/)
  })

  it('refuses a score outside the question\'s marks', async () => {
    const { owner } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)
    const [item] = (await listReviewQueue()).items

    await expect(
      overrideQuestionResult({ resultId: item.resultId, score: 11, reviewerId: owner.id }),
    ).rejects.toThrow(/between 0 and 10/)
  })

  it('refuses to touch an answer the AI graded fine', async () => {
    // This is a repair tool, not a general "edit any score" endpoint. A platform
    // operator silently rewriting a correct AI grade, for a coaching that never
    // asked, is a different and much worse product.
    const { owner, job, questions } = await seedExhausted({ questions: 2 })
    const graded = await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 7,
      maxScore: 10,
      imageUrl: IMAGE,
    })

    await expect(
      overrideQuestionResult({ resultId: graded.id, score: 10, reviewerId: owner.id }),
    ).rejects.toThrow(/not open for manual review/)
  })

  it('refuses a second override of the same answer', async () => {
    const { owner } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)
    const [item] = (await listReviewQueue()).items

    await overrideQuestionResult({ resultId: item.resultId, score: 6, reviewerId: owner.id })
    await expect(
      overrideQuestionResult({ resultId: item.resultId, score: 9, reviewerId: owner.id }),
    ).rejects.toThrow(/already been reviewed/)
  })

  it('builds the report the settle deliberately withheld, with the human score in it', async () => {
    const { owner, session } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)
    expect(await db.select().from(reports).where(eq(reports.sessionId, session.id))).toHaveLength(0)

    const [item] = (await listReviewQueue()).items
    await overrideQuestionResult({ resultId: item.resultId, score: 8, reviewerId: owner.id })
    await recomputeReportForSession(session.id)

    const [report] = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(report.aiScore).toBe(8)
    expect(report.totalScore).toBe(8)
  })

  it('pushes a correction into a report that already exists', async () => {
    // The case `createReportForSession` cannot handle on its own: it returns the
    // existing report untouched, which would leave the student looking at the
    // placeholder forever.
    const { owner, session, job, questions } = await seedExhausted({ questions: 2 })
    await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 5,
      maxScore: 10,
      imageUrl: IMAGE,
    })
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    // Force the report into existence at the pre-correction numbers.
    await recomputeReportForSession(session.id)
    const [before] = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(before.totalScore).toBe(5)

    const [item] = (await listReviewQueue()).items
    await overrideQuestionResult({ resultId: item.resultId, score: 10, reviewerId: owner.id })
    const out = await recomputeReportForSession(session.id)

    expect(out).toMatchObject({ created: false, changed: true })
    const [after] = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(after.id).toBe(before.id)
    expect(after.totalScore).toBe(15)
  })
})

describe('what a later re-grade may and may not overwrite', () => {
  it('leaves an operator\'s score alone, and pays nothing to do it', async () => {
    // Phase 6's last checklist line, and the easiest thing here to get wrong.
    // `processJob` resumes from existing `question_results`, so the rule that
    // protects a human score is the same rule that makes retries cheap: a
    // `resolved` row counts as already scored and is skipped entirely.
    const { owner, job, session } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)
    const [item] = (await listReviewQueue()).items
    await overrideQuestionResult({ resultId: item.resultId, score: 9, reviewerId: owner.id })

    await processJob({ jobId: job.id, sessionId: session.id, tenantId: candidate.tenantId })

    expect(engine.ocrImage).not.toHaveBeenCalled()
    expect(engine.evaluateSteps).not.toHaveBeenCalled()

    const [row] = await resultsFor(job.id)
    expect(row.score).toBe(9)
    expect(row.reviewStatus).toBe('resolved')
    expect(row.reviewedBy).toBe(owner.id)
    expect((await sessionRow(session.id)).manualScore).toBe(9)
  })

  it('re-grades a flagged placeholder and retires the flag', async () => {
    // The mirror image, and the bug this would have been: treating the
    // placeholder as "already scored" would make a flagged answer permanently
    // ungradeable — an operator's force-retry after an engine fix would skip the
    // very question it was run for, and the publish gate would never open.
    const { job, session, exam, tenant } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)
    expect(await countOpenReviewsForExam(exam.id)).toBe(1)

    await processJob({ jobId: job.id, sessionId: session.id, tenantId: tenant.id })

    expect(engine.ocrImage).toHaveBeenCalledTimes(1)

    const [row] = await resultsFor(job.id)
    expect(row.score).toBe(10)
    expect(row.reviewStatus).toBe('ai')
    // A real score retires the review, so the teacher's publish button unlocks
    // without anyone having had to look at anything.
    expect(await countOpenReviewsForExam(exam.id)).toBe(0)
    // …and the job no longer reads as one the backstop gave up on.
    expect((await jobRow(job.id)).settledAt).toBeNull()
  })

  it('CRITICAL: a re-grade updates a report that was already built', async () => {
    // The create-vs-recompute trap. `createReportForSession` is idempotent by
    // EARLY RETURN — it hands back an existing report untouched — so a job that
    // succeeds over a report built earlier left `exam_sessions.manual_score`
    // correct and `reports.total_score` frozen at the old number. The report is
    // the row the student actually reads, so the marks were right everywhere
    // except the one place that matters.
    //
    // Two ways in: a student re-uploading an answer, and a backstop settle that
    // flagged nothing (that path DOES write a report) followed by a force-retry
    // that worked.
    const { job, session, tenant } = await seedExhausted()

    // A report frozen before the marks existed.
    await createReportForSession(session.id)
    const [before] = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(before.totalScore).toBe(0)

    await processJob({ jobId: job.id, sessionId: session.id, tenantId: tenant.id })

    expect((await sessionRow(session.id)).manualScore).toBe(10)

    const [after] = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(after.totalScore).toBe(10)
    expect(after.aiScore).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE STUDENT IS TOLD AFTER THE WORK ENDS.
//
// Everything above checks that the marks come out right. This group checks the
// thing that was wrong for months while all of the above passed: the job ROW.
//
// `settleJob` parks it at `failed` and nothing moved it off. `publicJobStatus`
// shows `failed` to a student as `processing` — so a paper an operator had
// scored by hand, published and finalised went on saying "AI is reviewing your
// answer" indefinitely, with the results screen polling every 4 seconds for a
// status that was never coming.
//
// The marks were correct the whole time. That is exactly why nothing caught it,
// and why these assertions are on the status rather than on a score.
// ─────────────────────────────────────────────────────────────────────────────

describe('closing the job row', () => {
  it('CRITICAL: an override that clears the last flagged answer finishes the job', async () => {
    const { owner, student, job, session, exam, tenant } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    // The half-open state: settled, published-ready, still reading as `failed`.
    expect((await jobRow(job.id)).status).toBe('failed')

    const [item] = (await listReviewQueue()).items
    const result = await overrideQuestionResult({
      resultId: item.resultId,
      score: 7,
      reviewerId: owner.id,
    })

    expect(result.jobClosed).toBe(true)

    const row = await jobRow(job.id)
    expect(row.status).toBe('completed')
    expect(row.completedAt).not.toBeNull()
    // `settled_at` STAYS — the opposite of the re-grade case above. This paper
    // really did go through the backstop and really did need a person, and that
    // stamp is the only record of it.
    expect(row.settledAt).not.toBeNull()
    // So does the trail explaining why a person was needed.
    expect(row.failureClass).toBe('needs_human')
    expect(row.lastErrorCode).toBe('OCR_EMPTY')

    // The end of the chain, and the actual bug: what the student's results
    // screen is handed once the teacher has published.
    await db.update(exams).set({ status: 'ready_to_publish' }).where(eq(exams.id, exam.id))
    await publishResults(exam.id, tenant.id, owner.id, 'coaching_owner')

    const seen = await getSessionEvaluation(session.id, student.id)
    expect(seen?.status).toBe('completed')
  })

  it('leaves the job open while another answer on the same paper is still flagged', async () => {
    // Per-PAPER, not per-answer. A two-question paper with one answer scored is
    // genuinely unfinished, and "still being worked on" is the truthful thing to
    // show until both are done.
    const { owner, job } = await seedExhausted({ questions: 2 })
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    const { items } = await listReviewQueue()
    expect(items).toHaveLength(2)

    const first = await overrideQuestionResult({
      resultId: items[0].resultId,
      score: 5,
      reviewerId: owner.id,
    })
    expect(first.jobClosed).toBe(false)
    expect((await jobRow(job.id)).status).toBe('failed')

    const second = await overrideQuestionResult({
      resultId: items[1].resultId,
      score: 6,
      reviewerId: owner.id,
    })
    expect(second.jobClosed).toBe(true)
    expect((await jobRow(job.id)).status).toBe('completed')
  })
})

describe('closeFinishedSettledJobs — the settle that flagged nothing', () => {
  /**
   * A settle with no placeholders to write: the session closes, the report is
   * built and published, and the job row is left at `failed` with no flagged
   * answer anywhere — so no override is ever coming to close it. This sweep is
   * the only thing that resolves it.
   */
  async function seedSettledWithNothingFlagged() {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      status: 'under_evaluation',
    })
    const session = await createTestSession({
      examId: exam.id,
      studentId: student.id,
      tenantId: tenant.id,
      status: 'submitted',
      autoScore: 4,
    })
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, { failureClass: 'permanent', createdAt: pastT() })

    const [candidate] = await findBackstopCandidates({ examId: exam.id })
    const settled = await settleJob(candidate)
    expect(settled?.flagged).toBe(0)

    return { tenant, owner, student, exam, session, job }
  }

  it('CRITICAL: closes a settled job that had nothing left to wait for', async () => {
    const { job, session } = await seedSettledWithNothingFlagged()

    // The report is already built and student-visible…
    expect(await db.select().from(reports).where(eq(reports.sessionId, session.id))).toHaveLength(1)
    // …while the job still reads as unfinished. Nothing else in the system
    // closes this one.
    expect((await jobRow(job.id)).status).toBe('failed')
    expect(await findUnclosedSettledJobs()).toEqual(
      expect.arrayContaining([expect.objectContaining({ jobId: job.id })]),
    )

    const { closed } = await closeFinishedSettledJobs()
    expect(closed).toBeGreaterThanOrEqual(1)

    const row = await jobRow(job.id)
    expect(row.status).toBe('completed')
    expect(row.completedAt).not.toBeNull()
    expect(row.settledAt).not.toBeNull()
  })

  it('is a no-op on the second run', async () => {
    await seedSettledWithNothingFlagged()
    expect((await closeFinishedSettledJobs()).closed).toBeGreaterThanOrEqual(1)
    expect((await closeFinishedSettledJobs()).closed).toBe(0)
  })

  it('CRITICAL: leaves a failed job that was never settled alone', async () => {
    // The one way this sweep could do real damage: a job mid-retry-ladder is
    // `failed` between attempts and has no flagged answers either. Closing that
    // would end a paper the queue was still going to grade. `settled_at` is what
    // separates the two, and it is the reconciler's job, not this one's.
    const { job } = await seedExhausted()
    expect((await jobRow(job.id)).settledAt).toBeNull()

    expect((await findUnclosedSettledJobs()).map((j) => j.jobId)).not.toContain(job.id)
    expect((await closeFinishedSettledJobs()).closed).toBe(0)
    expect((await jobRow(job.id)).status).toBe('failed')
  })

  it('leaves a settled job that still has a flagged answer alone', async () => {
    const { job } = await seedExhausted()
    const [candidate] = await findBackstopCandidates()
    await settleJob(candidate)

    expect((await findUnclosedSettledJobs()).map((j) => j.jobId)).not.toContain(job.id)
    expect((await closeFinishedSettledJobs()).closed).toBe(0)
    expect((await jobRow(job.id)).status).toBe('failed')
  })
})
