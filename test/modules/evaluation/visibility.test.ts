import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { evaluationJobs } from '@modules/evaluation/evaluation.schema.js'
import {
  getExamEvaluationProgress,
  getJobForTenant,
  getSessionEvaluation,
} from '@modules/evaluation/evaluation.service.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createTestExam,
  createTestQuestion,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — what the outside world is allowed to learn about a failure.
//
// Every other test file in this module asserts that evaluation recovers. These
// assert that nobody outside Gyaanverse is told it ever had to. They are worth
// having as tests rather than as a convention because the regressions are all
// one-liners someone would write in good faith: a `...job` spread, an `error`
// field added back "for debugging", a `failedJobs` count restored to a panel
// that looks empty without it.
//
// The status collapse is the load-bearing one. `failed` on a job row has meant
// "the last attempt didn't land" since Phase 2's ladder — not "finished", not
// "given up" — so publishing it verbatim was both alarming and untrue.
// ─────────────────────────────────────────────────────────────────────────────

/** A job parked mid-ladder, with a full error trail behind it. */
async function seedFailedJob(examStatus: 'under_evaluation' | 'completed' = 'under_evaluation') {
  const { tenant, teacher, student } = await seedTenantWithUsers()
  const exam = await createTestExam({
    tenantId: tenant.id,
    createdBy: teacher.id,
    status: examStatus,
  })
  const question = await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'submitted',
  })
  const job = await createEvaluationJob({
    sessionId: session.id,
    tenantId: tenant.id,
    status: 'failed',
  })
  await db
    .update(evaluationJobs)
    .set({
      attempts: 7,
      error: 'engine timed out after 120000ms',
      lastErrorCode: 'ENGINE_TIMEOUT',
      failureClass: 'transient',
      nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    .where(eq(evaluationJobs.id, job.id))

  return { tenant, exam, question, session, job, student }
}

describe('getExamEvaluationProgress — the teacher sees progress, never failure', () => {
  it('does not report failed jobs, however many there are', async () => {
    const { tenant, exam } = await seedFailedJob()

    const progress = await getExamEvaluationProgress(exam.id, tenant.id)

    expect(progress).not.toHaveProperty('failedJobs')
    // Nothing else smuggles it back in under another name.
    expect(JSON.stringify(progress)).not.toMatch(/fail|error|ENGINE_/i)
  })

  it('still reports underReview — the one number that explains a held publish', async () => {
    // Deliberately exempt from this phase's removals: it is not failure
    // visibility, it is the reason the publish button is disabled. Removing it
    // leaves a dead control with no explanation attached.
    const { tenant, exam, question, job } = await seedFailedJob()
    await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 0,
      maxScore: 10,
      imageUrl: 'https://example.test/a.jpg',
      reviewStatus: 'needs_human',
    })

    const progress = await getExamEvaluationProgress(exam.id, tenant.id)

    expect(progress.underReview).toBe(1)
  })
})

describe('getSessionEvaluation — the student polls until it is done', () => {
  it('reports a failed job as `processing`, so polling never stops', async () => {
    // The bug this closes: StudentResults stopped its poll on `failed` and then
    // showed a "Pending" badge forever, even though the ladder went on to grade
    // the paper minutes later.
    const { session, student } = await seedFailedJob('completed')

    const evaluation = await getSessionEvaluation(session.id, student.id)

    expect(evaluation?.status).toBe('processing')
  })

  it('never returns the raw engine error to a student', async () => {
    const { session, student } = await seedFailedJob('completed')

    const evaluation = await getSessionEvaluation(session.id, student.id)

    expect(evaluation).not.toHaveProperty('error')
  })
})

describe('getJobForTenant — no diagnostics through the API either', () => {
  it('omits the whole error trail and collapses the status', async () => {
    const { tenant, job } = await seedFailedJob()

    const view = await getJobForTenant(job.id, tenant.id)

    expect(view.status).toBe('processing')
    for (const leak of ['error', 'lastErrorCode', 'failureClass', 'attempts', 'leaseExpiresAt', 'nextRetryAt'])
      expect(view).not.toHaveProperty(leak)
  })

  it('does not expose review_status — the internal axis stays internal', async () => {
    const { tenant, question, job } = await seedFailedJob()
    await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 0,
      maxScore: 10,
      imageUrl: 'https://example.test/a.jpg',
      reviewStatus: 'needs_human',
    })

    const view = await getJobForTenant(job.id, tenant.id)

    expect(view.results).toHaveLength(1)
    expect(view.results[0]).not.toHaveProperty('reviewStatus')
  })
})
