import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { evaluationJobs, questionResults } from '@modules/evaluation/evaluation.schema.js'
import {
  createEvaluationJob,
  createSessionAnswer,
  createTestExam,
  createTestQuestion,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// `processJob` (evaluation.service.ts) wiring for the pixel-confirmed blank
// path: a confirmed-blank answer must score a REAL 0 immediately (not a
// `needs_human` placeholder), and an unconfirmed OCR-empty result must still
// fall through to the pre-existing OCR_EMPTY retry path, untouched.
//
// `evaluation.blank-page.ts`'s own fail-open contract (network error, bad
// response, etc. → always `false`) is tested against the real fetch client in
// blank-page-detector.test.ts, not here — this file only asserts the wiring.
// ─────────────────────────────────────────────────────────────────────────────

const engine = vi.hoisted(() => ({ ocrImage: vi.fn(), evaluateSteps: vi.fn() }))
vi.mock('@modules/evaluation/evaluation.engine.js', () => ({
  ocrImage: engine.ocrImage,
  evaluateSteps: engine.evaluateSteps,
  indexDocuments: vi.fn(),
  indexTextDocuments: vi.fn(),
}))

const blankPage = vi.hoisted(() => ({ isConfirmedBlankPage: vi.fn() }))
vi.mock('@modules/evaluation/evaluation.blank-page.js', () => ({
  isConfirmedBlankPage: blankPage.isConfirmedBlankPage,
  BLANK_PAGE_AUTO_ZERO_REASON: 'blank_page_detector',
}))

const { processJob } = await import('@modules/evaluation/evaluation.service.js')

beforeEach(() => {
  engine.ocrImage.mockReset().mockResolvedValue([{ stepId: '1', text: '   ' }]) // OCR-empty
  engine.evaluateSteps.mockReset()
  blankPage.isConfirmedBlankPage.mockReset()
})

async function seedOneQuestionSession() {
  const { tenant, owner, student } = await seedTenantWithUsers()
  const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'submitted',
  })
  const question = await createTestQuestion({
    examId: exam.id,
    tenantId: tenant.id,
    order: 1,
    type: 'subjective',
    marks: 10,
  })
  const imageUrl = `https://cdn.test/answers/${session.id}-q1.jpg`
  await createSessionAnswer({ sessionId: session.id, questionId: question.id, imageUrl })
  const job = await createEvaluationJob({ sessionId: session.id, tenantId: tenant.id, status: 'pending' })
  return { session, question, job }
}

describe('processJob — pixel-confirmed blank page', () => {
  it('CRITICAL: a confirmed-blank page scores a real 0 immediately — no retry, no needs_human', async () => {
    blankPage.isConfirmedBlankPage.mockResolvedValue(true)
    const { session, question, job } = await seedOneQuestionSession()

    await processJob({ jobId: job.id, sessionId: session.id, tenantId: job.tenantId })

    // The grader is never called — a confirmed-blank page has nothing to grade.
    expect(engine.evaluateSteps).not.toHaveBeenCalled()

    const [result] = await db
      .select()
      .from(questionResults)
      .where(eq(questionResults.jobId, job.id))
    expect(result.score).toBe(0)
    expect(result.questionId).toBe(question.id)
    // A REAL score, not the backstop's placeholder — nothing for a person to review.
    expect(result.reviewStatus).toBe('ai')

    const [sessionRow] = await db.select().from(examSessions).where(eq(examSessions.id, session.id))
    expect(sessionRow.status).toBe('evaluated')

    const [jobRow] = await db.select().from(evaluationJobs).where(eq(evaluationJobs.id, job.id))
    expect(jobRow.status).toBe('completed')
    expect(jobRow.failureClass).toBeNull()
  })

  it('an unconfirmed OCR-empty result still falls through to the existing OCR_EMPTY path', async () => {
    blankPage.isConfirmedBlankPage.mockResolvedValue(false)
    const { session, job } = await seedOneQuestionSession()

    await expect(
      processJob({ jobId: job.id, sessionId: session.id, tenantId: job.tenantId }),
    ).rejects.toMatchObject({ code: 'OCR_EMPTY' })

    const rows = await db.select().from(questionResults).where(eq(questionResults.jobId, job.id))
    expect(rows).toHaveLength(0) // nothing scored — still eligible for retry
  })
})
