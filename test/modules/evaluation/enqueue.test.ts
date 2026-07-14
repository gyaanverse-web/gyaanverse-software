import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { evaluationJobs } from '@modules/evaluation/evaluation.schema.js'
import { enqueueEvaluation } from '@modules/evaluation/evaluation.service.js'
import { PLANS } from '@config/plans.js'
import {
  createTestExam,
  createTestSession,
  createTestUser,
  createEvaluationJob,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

describe('enqueueEvaluation', () => {
  it('creates a pending job and returns its id', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted',
    })

    const result = await enqueueEvaluation(session.id)
    expect(result).not.toBeNull()
    expect(result!.jobId).toBeDefined()

    const [job] = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.id, result!.jobId))
    expect(job.status).toBe('pending')
    expect(job.sessionId).toBe(session.id)
    expect(job.tenantId).toBe(tenant.id)
  })

  it('returns null for an unknown session (does not throw)', async () => {
    const result = await enqueueEvaluation('00000000-0000-0000-0000-000000000000')
    expect(result).toBeNull()
  })

  it('CRITICAL: soft-fails (returns null) when AI quota is exhausted', async () => {
    // The submit flow must NEVER throw post-write. enqueueEvaluation is called
    // after the session is already saved; a thrown error there would cause
    // the user to see a 500 even though their submission succeeded.
    const { tenant, owner, student } = await seedTenantWithUsers('free')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })

    // Fill the AI-evaluation quota. The counter is "rows in evaluation_jobs
    // for this tenant this month" — we can pin all of them to one filler
    // session to avoid the unique (examId, studentId, attemptNumber) constraint.
    const fillerSession = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted',
    })
    const limit = PLANS.free.limits.ai_evaluations // 10
    for (let i = 0; i < limit; i++) {
      await createEvaluationJob({ sessionId: fillerSession.id, tenantId: tenant.id })
    }

    // One more session over the cap — use a different student to dodge the
    // attempt-number uniqueness constraint
    const overflowStudent = await createTestUser({ role: 'student' })
    const overflowSession = await createTestSession({
      examId: exam.id, studentId: overflowStudent.id, tenantId: tenant.id, status: 'submitted',
    })

    const result = await enqueueEvaluation(overflowSession.id)
    expect(result).toBeNull() // soft-fail, no throw

    // No new job row was created
    const jobsForOverflow = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.sessionId, overflowSession.id))
    expect(jobsForOverflow).toHaveLength(0)
  })

  it('resolves tenant from exam, not from session.tenantId (which may be null for public exams)', async () => {
    // A public-exam taker is NOT a member of the exam's tenant. Their session
    // has tenantId=null. The evaluation job still has to be billed to the
    // exam's creating tenant.
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free',
    })
    // session with null tenant
    const session = await createTestSession({
      examId: exam.id, studentId: owner.id, tenantId: null, status: 'submitted',
    })

    const result = await enqueueEvaluation(session.id)
    expect(result).not.toBeNull()

    const [job] = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.id, result!.jobId))
    expect(job.tenantId).toBe(tenant.id) // billed to exam's tenant
  })
})
