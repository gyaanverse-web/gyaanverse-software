import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import {
  evaluationJobs,
  ocrCache,
  questionResults,
} from '@modules/evaluation/evaluation.schema.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createSessionAnswer,
  createTestExam,
  createTestQuestion,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// The engine is the thing we are counting. Every assertion in this file is
// ultimately "how many times did we pay?", so the mock is the instrument.
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

// The blank-page detector is a separate engine reached over real `fetch`, not
// through `evaluation.engine.js`. Mocked here too so the BLANK/OCR-empty tests
// below stay deterministic instead of depending on nothing listening on
// localhost:5000 in whatever environment the suite happens to run in.
const blankPage = vi.hoisted(() => ({ isConfirmedBlankPage: vi.fn() }))

vi.mock('@modules/evaluation/evaluation.blank-page.js', () => ({
  isConfirmedBlankPage: blankPage.isConfirmedBlankPage,
  BLANK_PAGE_AUTO_ZERO_REASON: 'blank_page_detector',
}))

const { processJob } = await import('@modules/evaluation/evaluation.service.js')
// Phase 8 deleted the tenant-facing `retryJob`; `forceRetryJob` is the only
// retry left, so it inherits the resumability property asserted at the bottom
// of this file.
const { forceRetryJob } = await import('@modules/evaluation/evaluation.ops.js')

const READABLE = [{ stepId: '1', text: 'v = u + at = 0 + 2(10) = 20 m/s' }]
const BLANK = [{ stepId: '1', text: '   ' }]

/** One fully-right step — scoreFromSteps turns this into full marks. */
const GRADED = {
  response: [
    {
      stepId: '1',
      text: 'v = u + at = 0 + 2(10) = 20 m/s',
      step_status: 'right' as const,
      step_weight: 1,
      topic: 'kinematics',
      step_understanding: 'ok',
      description: 'correct',
    },
  ],
}

beforeEach(() => {
  engine.ocrImage.mockReset().mockResolvedValue(READABLE)
  engine.evaluateSteps.mockReset().mockResolvedValue(GRADED)
  // Default: the detector has no opinion (matches a real network failure in a
  // test environment) — so an OCR-empty result still falls through to the
  // pre-existing OCR_EMPTY retry path unless a test opts into "confirmed blank".
  blankPage.isConfirmedBlankPage.mockReset().mockResolvedValue(false)
})

/**
 * An exam with `count` subjective questions, each answered with an image, and a
 * pending evaluation job for the session.
 */
async function seedGradeableSession(opts: { count?: number; imageUrls?: string[] } = {}) {
  const count = opts.count ?? 2
  const { tenant, owner, student } = await seedTenantWithUsers()
  const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'submitted',
  })

  const questions = []
  for (let i = 0; i < count; i++) {
    const q = await createTestQuestion({
      examId: exam.id,
      tenantId: tenant.id,
      order: i + 1,
      type: 'subjective',
      marks: 10,
    })
    const imageUrl = opts.imageUrls?.[i] ?? `https://cdn.test/answers/${session.id}-q${i + 1}.jpg`
    await createSessionAnswer({ sessionId: session.id, questionId: q.id, imageUrl })
    questions.push({ ...q, imageUrl })
  }

  const job = await createEvaluationJob({
    sessionId: session.id,
    tenantId: tenant.id,
    status: 'pending',
  })

  return { tenant, student, exam, session, questions, job }
}

function payload(job: { id: string; sessionId: string; tenantId: string }) {
  return { jobId: job.id, sessionId: job.sessionId, tenantId: job.tenantId }
}

describe('processJob — resumable retries', () => {
  it('CRITICAL: skips questions it already scored instead of re-buying them', async () => {
    // The whole reason 50 attempts is affordable. A job that died at the last
    // question used to re-OCR and re-grade every earlier one on every attempt.
    const { session, questions, job } = await seedGradeableSession({ count: 3 })

    await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 4,
      maxScore: 10,
      imageUrl: questions[0].imageUrl,
    })

    await processJob(payload(job))

    // Only the two unscored questions cost anything.
    expect(engine.ocrImage).toHaveBeenCalledTimes(2)
    expect(engine.evaluateSteps).toHaveBeenCalledTimes(2)

    const ocrArgs = engine.ocrImage.mock.calls.map((c) => c[0])
    expect(ocrArgs).not.toContain(questions[0].imageUrl)

    const rows = await db.select().from(questionResults).where(eq(questionResults.jobId, job.id))
    expect(rows).toHaveLength(3)

    // And the earlier score survived — resuming must not re-mark settled work.
    const kept = rows.find((r) => r.questionId === questions[0].id)!
    expect(kept.score).toBe(4)

    const [after] = await db.select().from(examSessions).where(eq(examSessions.id, session.id))
    expect(after.status).toBe('evaluated')
  })

  it('CRITICAL: rolls up manualScore from every row, not from the questions it just graded', async () => {
    // Accumulating inside the loop undercounts a resumed job by exactly the
    // scores it skipped — the student silently loses marks on a retry.
    const { session, questions, job } = await seedGradeableSession({ count: 2 })

    await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 4,
      maxScore: 10,
      imageUrl: questions[0].imageUrl,
    })

    await processJob(payload(job))

    const [after] = await db.select().from(examSessions).where(eq(examSessions.id, session.id))
    expect(after.manualScore).toBe(14) // 4 carried over + 10 graded now
  })

  it('CRITICAL: re-running a completed job calls the engine zero times and changes nothing', async () => {
    const { session, job } = await seedGradeableSession({ count: 2 })

    await processJob(payload(job))
    const [first] = await db.select().from(examSessions).where(eq(examSessions.id, session.id))
    const callsAfterFirst = engine.ocrImage.mock.calls.length
    expect(callsAfterFirst).toBe(2)

    await processJob(payload(job))

    expect(engine.ocrImage).toHaveBeenCalledTimes(callsAfterFirst)
    expect(engine.evaluateSteps).toHaveBeenCalledTimes(callsAfterFirst)

    const rows = await db.select().from(questionResults).where(eq(questionResults.jobId, job.id))
    expect(rows).toHaveLength(2)

    const [second] = await db.select().from(examSessions).where(eq(examSessions.id, session.id))
    expect(second.manualScore).toBe(first.manualScore)
    expect(second.status).toBe('evaluated')
  })

  it('re-grades a question whose answer image changed', async () => {
    // The skip is keyed on the image, not just the question: a re-submitted
    // paper is different work and has to be read again.
    const { questions, job } = await seedGradeableSession({ count: 1 })

    await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 4,
      maxScore: 10,
      imageUrl: 'https://cdn.test/answers/an-older-upload.jpg',
    })

    await processJob(payload(job))

    expect(engine.ocrImage).toHaveBeenCalledTimes(1)
    const rows = await db.select().from(questionResults).where(eq(questionResults.jobId, job.id))
    expect(rows).toHaveLength(1) // upserted, not duplicated
    expect(rows[0].score).toBe(10) // re-graded against the new image
  })
})

describe('OCR cache', () => {
  it('CRITICAL: reads a given image exactly once, across jobs', async () => {
    const shared = 'https://cdn.test/answers/shared-page.jpg'
    const a = await seedGradeableSession({ count: 1, imageUrls: [shared] })
    await processJob(payload(a.job))
    expect(engine.ocrImage).toHaveBeenCalledTimes(1)

    // A different student, a different job, the same stored image.
    const b = await seedGradeableSession({ count: 1, imageUrls: [shared] })
    await processJob(payload(b.job))

    expect(engine.ocrImage).toHaveBeenCalledTimes(1) // still one — cache hit
    expect(engine.evaluateSteps).toHaveBeenCalledTimes(2) // grading still happens

    const [row] = await db.select().from(ocrCache).where(eq(ocrCache.source, shared))
    expect(row.hits).toBe(1)
  })

  it('CRITICAL: never caches an unreadable read', async () => {
    // A blank result may be a blank page or an engine having a bad minute.
    // Caching it makes that verdict permanent and quietly cancels the
    // UNGRADEABLE_ATTEMPTS re-reads the ladder depends on.
    engine.ocrImage.mockResolvedValue(BLANK)
    const { job } = await seedGradeableSession({ count: 1 })

    await expect(processJob(payload(job))).rejects.toMatchObject({ code: 'OCR_EMPTY' })

    const cached = await db.select().from(ocrCache)
    expect(cached).toHaveLength(0)

    // So the next attempt genuinely re-reads the page.
    await expect(processJob(payload(job))).rejects.toMatchObject({ code: 'OCR_EMPTY' })
    expect(engine.ocrImage).toHaveBeenCalledTimes(2)
  })

  it('a failure after OCR does not re-buy the OCR on the next attempt', async () => {
    // The exact incident this phase exists for: the engine's Gemini dependency
    // was missing, so OCR succeeded and evaluate failed — and every retry paid
    // for the OCR again. At 50 attempts that is 50 reads of one legible page.
    engine.evaluateSteps.mockRejectedValue(new Error('Gemini SDK not installed'))
    const { job } = await seedGradeableSession({ count: 1 })

    await expect(processJob(payload(job))).rejects.toThrow()
    await expect(processJob(payload(job))).rejects.toThrow()
    await expect(processJob(payload(job))).rejects.toThrow()

    expect(engine.ocrImage).toHaveBeenCalledTimes(1)
    expect(engine.evaluateSteps).toHaveBeenCalledTimes(3)
  })
})

describe('forceRetryJob', () => {
  it('CRITICAL: keeps existing question_results so the retry resumes', async () => {
    const { questions, job } = await seedGradeableSession({ count: 2 })
    await createQuestionResult({
      jobId: job.id,
      questionId: questions[0].id,
      score: 7,
      maxScore: 10,
      imageUrl: questions[0].imageUrl,
    })

    await forceRetryJob(job.id)

    const rows = await db.select().from(questionResults).where(eq(questionResults.jobId, job.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].score).toBe(7)

    const [reset] = await db.select().from(evaluationJobs).where(eq(evaluationJobs.id, job.id))
    expect(reset.status).toBe('pending')
    expect(reset.nextRetryAt).toBeNull()
  })
})
