import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams } from '@modules/exam/exam.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { runLifecycleTick } from '@modules/exam/exam.scheduler.js'
import {
  seedTenantWithUsers, createTestExam, createTestSession,
} from '../../helpers/fixtures.js'

// The time-triggered worker sweep (runLifecycleTick) drives the automatic
// transitions: scheduled→live at scheduledAt, live→under_evaluation at endsAt
// (force-submitting active sessions), and results_published→completed once no
// session is still in flight. It queries the DB directly — no Redis needed.

const past = (mins: number) => new Date(Date.now() - mins * 60 * 1000)
const future = (mins: number) => new Date(Date.now() + mins * 60 * 1000)

async function statusOf(examId: string): Promise<string> {
  const [row] = await db.select({ status: exams.status }).from(exams).where(eq(exams.id, examId))
  return row.status
}

describe('runLifecycleTick — scheduled → live', () => {
  it('starts an exam whose scheduledAt has passed', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'scheduled', scheduledAt: past(5),
    })

    const result = await runLifecycleTick()
    expect(result.started).toBe(1)
    expect(await statusOf(exam.id)).toBe('live')

    // publishedAt is stamped on go-live.
    const [row] = await db.select({ publishedAt: exams.publishedAt }).from(exams).where(eq(exams.id, exam.id))
    expect(row.publishedAt).toBeTruthy()
  })

  it('leaves a future-scheduled exam untouched', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'scheduled', scheduledAt: future(30),
    })

    const result = await runLifecycleTick()
    expect(result.started).toBe(0)
    expect(await statusOf(exam.id)).toBe('scheduled')
  })

  it('ignores a scheduled exam with no scheduledAt set', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'scheduled', scheduledAt: null,
    })

    await runLifecycleTick()
    expect(await statusOf(exam.id)).toBe('scheduled')
  })
})

describe('runLifecycleTick — live → under_evaluation', () => {
  it('ends an exam whose endsAt has passed and force-submits active sessions', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'live', endsAt: past(1),
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })

    const result = await runLifecycleTick()
    expect(result.ended).toBe(1)
    expect(await statusOf(exam.id)).toBe('under_evaluation')

    // The active session was force-submitted (no longer in_progress).
    const [s] = await db.select({ status: examSessions.status }).from(examSessions).where(eq(examSessions.id, session.id))
    expect(s.status).not.toBe('in_progress')
  })

  it('leaves a live exam whose window has not closed', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'live', endsAt: future(30),
    })

    const result = await runLifecycleTick()
    expect(result.ended).toBe(0)
    expect(await statusOf(exam.id)).toBe('live')
  })
})

describe('runLifecycleTick — results_published → completed', () => {
  it('completes a published exam once no session is still in flight', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'results_published',
    })
    // A fully-settled session must not block completion.
    await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'evaluated',
    })

    const result = await runLifecycleTick()
    expect(result.completed).toBe(1)
    expect(await statusOf(exam.id)).toBe('completed')
  })

  it('keeps a published exam that still has an in-flight session', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'results_published',
    })
    await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted', // awaiting eval
    })

    const result = await runLifecycleTick()
    expect(result.completed).toBe(0)
    expect(await statusOf(exam.id)).toBe('results_published')
  })
})
