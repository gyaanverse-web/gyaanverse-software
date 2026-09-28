import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { questionResults } from '@modules/evaluation/evaluation.schema.js'
import { BLANK_PAGE_AUTO_ZERO_REASON } from '@modules/evaluation/evaluation.blank-page.js'
import {
  confirmBlankPage,
  correctBlankPageFalsePositive,
  getBlankPageAuditSummary,
  listBlankPageAudit,
} from '@modules/evaluation/evaluation.blank-page-audit.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createSessionAnswer,
  createTestExam,
  createTestQuestion,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// The blank-page audit is a SAMPLE, not a queue — every row here already
// completed and its exam is already free to publish. These tests check the
// three things that matter for that kind of tool: the list/summary only ever
// surface auto-zeroed rows, an audit can only happen once per row (no
// clobbering an earlier operator's verdict), and a false-positive correction
// actually changes the number the student's report reads — not just a flag.
// ─────────────────────────────────────────────────────────────────────────────

async function seedAutoZeroedResult(opts: { score?: number } = {}) {
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
    marks: 10,
  })
  const imageUrl = `https://cdn.test/answers/${session.id}-q1.jpg`
  await createSessionAnswer({ sessionId: session.id, questionId: question.id, imageUrl })
  const job = await createEvaluationJob({ sessionId: session.id, tenantId: tenant.id, status: 'completed' })
  const result = await createQuestionResult({
    jobId: job.id,
    questionId: question.id,
    score: opts.score ?? 0,
    maxScore: question.marks,
    imageUrl,
    autoZeroReason: BLANK_PAGE_AUTO_ZERO_REASON,
  })
  return { tenant, owner, student, exam, session, question, job, result }
}

describe('listBlankPageAudit / getBlankPageAuditSummary', () => {
  it('only surfaces rows the detector actually auto-zeroed', async () => {
    const { result: blank } = await seedAutoZeroedResult()
    // An ordinary AI-graded row (no autoZeroReason) — must never appear.
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id,
      studentId: student.id,
      tenantId: tenant.id,
      status: 'submitted',
    })
    const question = await createTestQuestion({ examId: exam.id, tenantId: tenant.id })
    const job = await createEvaluationJob({ sessionId: session.id, tenantId: tenant.id })
    await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 7,
      maxScore: question.marks,
      imageUrl: 'https://cdn.test/answers/other.jpg',
    })

    const { items, total } = await listBlankPageAudit()
    expect(total).toBe(1)
    expect(items.map((i) => i.resultId)).toEqual([blank.id])
  })

  it('filters by reviewed / unreviewed', async () => {
    const a = await seedAutoZeroedResult()
    const b = await seedAutoZeroedResult()
    await confirmBlankPage({ resultId: a.result.id, reviewerId: a.owner.id })

    const unreviewed = await listBlankPageAudit({ reviewed: false })
    expect(unreviewed.items.map((i) => i.resultId)).toEqual([b.result.id])

    const reviewed = await listBlankPageAudit({ reviewed: true })
    expect(reviewed.items.map((i) => i.resultId)).toEqual([a.result.id])
  })

  it('CRITICAL: summary counts and accuracy match confirm/reject actions taken', async () => {
    const confirmed = await seedAutoZeroedResult()
    const falsePositive = await seedAutoZeroedResult()
    await seedAutoZeroedResult() // left untouched — counts toward totalAutoZeroed/unreviewed only

    await confirmBlankPage({ resultId: confirmed.result.id, reviewerId: confirmed.owner.id })
    await correctBlankPageFalsePositive({
      resultId: falsePositive.result.id,
      score: 8,
      reviewerId: falsePositive.owner.id,
    })

    const summary = await getBlankPageAuditSummary()
    expect(summary.totalAutoZeroed).toBe(3)
    expect(summary.reviewed).toBe(2)
    expect(summary.unreviewed).toBe(1)
    expect(summary.confirmed).toBe(1)
    expect(summary.falsePositive).toBe(1)
    expect(summary.accuracyPct).toBe(50)
  })

  it('accuracyPct is null with nothing reviewed yet, not a misleading 0 or 100', async () => {
    await seedAutoZeroedResult()
    const summary = await getBlankPageAuditSummary()
    expect(summary.reviewed).toBe(0)
    expect(summary.accuracyPct).toBeNull()
  })
})

describe('confirmBlankPage', () => {
  it('stamps the reviewer without changing the score', async () => {
    const { result, owner } = await seedAutoZeroedResult()
    await confirmBlankPage({ resultId: result.id, reviewerId: owner.id, note: 'genuinely blank' })

    const [row] = await db.select().from(questionResults).where(eq(questionResults.id, result.id))
    expect(row.score).toBe(0)
    expect(row.reviewStatus).toBe('ai')
    expect(row.reviewedBy).toBe(owner.id)
    expect(row.reviewNote).toBe('genuinely blank')
    expect(row.reviewedAt).not.toBeNull()
  })

  it('CRITICAL: refuses a second audit of the same row', async () => {
    const { result, owner } = await seedAutoZeroedResult()
    await confirmBlankPage({ resultId: result.id, reviewerId: owner.id })

    await expect(
      confirmBlankPage({ resultId: result.id, reviewerId: owner.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a row the detector never touched', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id,
      studentId: student.id,
      tenantId: tenant.id,
      status: 'submitted',
    })
    const question = await createTestQuestion({ examId: exam.id, tenantId: tenant.id })
    const job = await createEvaluationJob({ sessionId: session.id, tenantId: tenant.id })
    const normal = await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 7,
      maxScore: question.marks,
      imageUrl: 'https://cdn.test/answers/normal.jpg',
    })

    await expect(
      confirmBlankPage({ resultId: normal.id, reviewerId: owner.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('correctBlankPageFalsePositive', () => {
  it('CRITICAL: overturns the auto-zero — real score, resolved status, AI verdict preserved', async () => {
    const { result, owner, job } = await seedAutoZeroedResult()

    const outcome = await correctBlankPageFalsePositive({
      resultId: result.id,
      score: 9,
      note: 'faint pencil, missed by the detector',
      reviewerId: owner.id,
    })
    expect(outcome.score).toBe(9)
    expect(outcome.aiScore).toBe(0)
    expect(outcome.sessionScore).toBe(9)

    const [row] = await db.select().from(questionResults).where(eq(questionResults.id, result.id))
    expect(row.score).toBe(9)
    expect(row.aiScore).toBe(0)
    expect(row.reviewStatus).toBe('resolved')
    expect(row.reviewedBy).toBe(owner.id)

    // The session total actually moved — this is a correction to a finished
    // result, not just a flag nobody downstream reads.
    const [sessionRow] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, job.sessionId))
    expect(sessionRow.manualScore).toBe(9)
  })

  it('rejects a score outside 0..maxScore', async () => {
    const { result, owner, question } = await seedAutoZeroedResult()
    await expect(
      correctBlankPageFalsePositive({
        resultId: result.id,
        score: question.marks + 1,
        reviewerId: owner.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('CRITICAL: refuses a second audit of the same row', async () => {
    const { result, owner } = await seedAutoZeroedResult()
    await correctBlankPageFalsePositive({ resultId: result.id, score: 5, reviewerId: owner.id })

    await expect(
      correctBlankPageFalsePositive({ resultId: result.id, score: 6, reviewerId: owner.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
