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
// (force-submitting active sessions), under_evaluation→ready_to_publish once no
// session is still in flight, and — for PUBLIC exams only — ready_to_publish→
// completed. It queries the DB directly — no Redis needed.

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

    // The active session was force-submitted (no longer in_progress).
    const [s] = await db.select({ status: examSessions.status }).from(examSessions).where(eq(examSessions.id, session.id))
    expect(s.status).not.toBe('in_progress')

    // This exam has no subjective questions, so force-submitting graded it
    // outright — and the SAME tick's next sweep therefore finds nothing pending
    // and moves it straight on to ready_to_publish. `under_evaluation` is a real
    // state, but only for exams that actually need the AI evaluator; a purely
    // objective paper passes through it without ever resting there.
    expect(await statusOf(exam.id)).toBe('ready_to_publish')
    expect(result.readyToPublish).toBe(1)
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

describe('runLifecycleTick — under_evaluation → ready_to_publish', () => {
  it('promotes an exam once every session is settled', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'under_evaluation',
    })
    await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'evaluated',
    })

    const result = await runLifecycleTick()
    expect(result.readyToPublish).toBe(1)
    expect(await statusOf(exam.id)).toBe('ready_to_publish')
  })

  // This is the stall the evaluation-progress panel exists to expose: one
  // session still with the AI evaluator holds the whole exam back.
  it('holds an exam that still has a session awaiting evaluation', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'under_evaluation',
    })
    await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted', // awaiting eval
    })

    const result = await runLifecycleTick()
    expect(result.readyToPublish).toBe(0)
    expect(await statusOf(exam.id)).toBe('under_evaluation')
  })

  it('promotes an exam nobody attempted (no sessions to wait on)', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'under_evaluation',
    })

    await runLifecycleTick()
    expect(await statusOf(exam.id)).toBe('ready_to_publish')
  })
})

describe('runLifecycleTick — ready_to_publish → completed (public exams only)', () => {
  // Private exams wait for a teacher who reviews the reports first. Public
  // marketplace exams have no such teacher, so the worker publishes them.
  it('does NOT auto-publish a private exam', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'ready_to_publish', visibility: 'private',
    })

    const result = await runLifecycleTick()
    expect(result.completed).toBe(0)
    expect(await statusOf(exam.id)).toBe('ready_to_publish')
  })

  it('auto-publishes a public exam', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'ready_to_publish', visibility: 'public_free',
    })

    const result = await runLifecycleTick()
    expect(result.completed).toBe(1)
    expect(await statusOf(exam.id)).toBe('completed')
  })
})
