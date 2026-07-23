import { describe, it, expect } from 'vitest'
import { eq, asc } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams, questions, examClasses, examStatusHistory } from '@modules/exam/exam.schema.js'
import {
  transitionExam, publishResults, duplicateExam, archiveExam,
} from '@modules/exam/exam.service.js'
import {
  approveAndScheduleExam, requestChanges, rejectExam,
} from '@modules/admin/admin.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass, createTestQuestion,
} from '../../helpers/fixtures.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'

// The exam state machine (transitionExam) is the single choke point for every
// status change. These tests pin down (a) which transitions are allowed, (b)
// which actor role each requires, and (c) that a history row is written.

async function examAt(status: ExamStatus, opts: { plan?: 'free' | 'pro'; visibility?: 'private' | 'public_free' } = {}) {
  const { tenant, owner, teacher, student } = await seedTenantWithUsers(opts.plan ?? 'pro')
  const exam = await createTestExam({
    tenantId: tenant.id, createdBy: owner.id, status,
    visibility: opts.visibility ?? 'private',
  })
  return { tenant, owner, teacher, student, exam }
}

const ownerActor = (id: string) => ({ id, role: 'coaching_owner' })

describe('transitionExam — allowed transitions', () => {
  it('author moves draft → under_review and records history', async () => {
    const { tenant, owner, exam } = await examAt('draft')

    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'under_review', actor: ownerActor(owner.id),
    })
    expect(updated.status).toBe('under_review')
    expect(updated.submittedAt).toBeTruthy()

    const [h] = await db.select().from(examStatusHistory).where(eq(examStatusHistory.examId, exam.id))
    expect(h.fromStatus).toBe('draft')
    expect(h.toStatus).toBe('under_review')
    expect(h.actorId).toBe(owner.id)
  })

  it('owner moves under_review → approved', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'approved', actor: ownerActor(owner.id),
    })
    expect(updated.status).toBe('approved')
    expect(updated.reviewedBy).toBe(owner.id)
    expect(updated.reviewedAt).toBeTruthy()
  })

  it('author reopens a rejected exam back to draft', async () => {
    const { tenant, owner, exam } = await examAt('rejected')
    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'draft', actor: ownerActor(owner.id),
    })
    expect(updated.status).toBe('draft')
  })

  it('system (null actor) drives scheduled → live and stamps publishedAt', async () => {
    const { tenant, exam } = await examAt('scheduled')
    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'live', actor: null,
    })
    expect(updated.status).toBe('live')
    expect(updated.publishedAt).toBeTruthy()

    const [h] = await db.select().from(examStatusHistory).where(eq(examStatusHistory.examId, exam.id))
    expect(h.actorId).toBeNull() // system transition has no actor
  })

  it('system drives live → under_evaluation', async () => {
    const { tenant, exam } = await examAt('live')
    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'under_evaluation', actor: null,
    })
    expect(updated.status).toBe('under_evaluation')
  })

  it('owner may override a system transition (scheduled → live)', async () => {
    const { tenant, owner, exam } = await examAt('scheduled')
    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'live', actor: ownerActor(owner.id),
    })
    expect(updated.status).toBe('live')
  })
})

describe('transitionExam — forbidden transitions', () => {
  it('rejects a transition that is not in the map (draft → live)', async () => {
    const { tenant, owner, exam } = await examAt('draft')
    await expect(
      transitionExam({ examId: exam.id, tenantId: tenant.id, to: 'live', actor: ownerActor(owner.id) }),
    ).rejects.toThrow(/Cannot move an exam from draft to live/)
  })

  it('rejects a no-op transition (already in target state)', async () => {
    const { tenant, owner, exam } = await examAt('draft')
    await expect(
      transitionExam({ examId: exam.id, tenantId: tenant.id, to: 'draft', actor: ownerActor(owner.id) }),
    ).rejects.toThrow(/already draft/)
  })

  it('CRITICAL: a non-owner cannot make an owner-only review decision', async () => {
    const { tenant, teacher, exam } = await examAt('under_review')
    // teacher is neither the creator (owner is) nor a coaching_owner
    await expect(
      transitionExam({
        examId: exam.id, tenantId: tenant.id, to: 'approved',
        actor: { id: teacher.id, role: 'teacher' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: a teacher cannot override a system transition (scheduled → live)', async () => {
    const { tenant, teacher, exam } = await examAt('scheduled')
    await expect(
      transitionExam({
        examId: exam.id, tenantId: tenant.id, to: 'live',
        actor: { id: teacher.id, role: 'teacher' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: a non-creator teacher cannot perform an author transition', async () => {
    const { tenant, teacher, exam } = await examAt('draft')
    await expect(
      transitionExam({
        examId: exam.id, tenantId: tenant.id, to: 'under_review',
        actor: { id: teacher.id, role: 'teacher' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('approveAndScheduleExam', () => {
  it('walks under_review → approved → scheduled, sets the window & classes', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000)
    const endsAt = new Date(Date.now() + 3 * 60 * 60 * 1000)

    const updated = await approveAndScheduleExam(exam.id, tenant.id, ownerActor(owner.id), {
      classIds: [cls.id], scheduledAt, endsAt, durationMins: 90,
    })

    expect(updated.status).toBe('scheduled')
    expect(updated.scheduledAt?.getTime()).toBe(scheduledAt.getTime())
    expect(updated.endsAt?.getTime()).toBe(endsAt.getTime())
    expect(updated.durationMins).toBe(90)

    const links = await db.select().from(examClasses).where(eq(examClasses.examId, exam.id))
    expect(links.map((l) => l.classId)).toEqual([cls.id])

    // Two audited hops: approved then scheduled.
    const hist = await db
      .select()
      .from(examStatusHistory)
      .where(eq(examStatusHistory.examId, exam.id))
      .orderBy(asc(examStatusHistory.createdAt))
    expect(hist.map((h) => h.toStatus)).toEqual(['approved', 'scheduled'])
  })

  it('rejects a window whose end is not after its start', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const t = new Date(Date.now() + 60 * 60 * 1000)
    await expect(
      approveAndScheduleExam(exam.id, tenant.id, ownerActor(owner.id), {
        scheduledAt: t, endsAt: t,
      }),
    ).rejects.toThrow(/endsAt must be after scheduledAt/)
  })

  it('rejects approving an exam that is not under review', async () => {
    const { tenant, owner, exam } = await examAt('draft')
    await expect(
      approveAndScheduleExam(exam.id, tenant.id, ownerActor(owner.id), {}),
    ).rejects.toThrow(/Only exams under review can be approved/)
  })

  it('CRITICAL: a teacher cannot approve & schedule', async () => {
    const { tenant, teacher, exam } = await examAt('under_review')
    await expect(
      approveAndScheduleExam(exam.id, tenant.id, { id: teacher.id, role: 'teacher' }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('requestChanges / rejectExam', () => {
  it('bounces under_review → changes_requested carrying remarks', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const updated = await requestChanges(exam.id, tenant.id, ownerActor(owner.id), 'Fix Q3 marking')
    expect(updated.status).toBe('changes_requested')
    expect(updated.reviewRemarks).toBe('Fix Q3 marking')

    const [h] = await db.select().from(examStatusHistory).where(eq(examStatusHistory.examId, exam.id))
    expect(h.remarks).toBe('Fix Q3 marking')
  })

  it('rejects under_review → rejected carrying remarks', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const updated = await rejectExam(exam.id, tenant.id, ownerActor(owner.id), 'Out of syllabus')
    expect(updated.status).toBe('rejected')
    expect(updated.reviewRemarks).toBe('Out of syllabus')
  })
})

describe('publishResults', () => {
  it('moves under_evaluation → results_published and stamps resultsPublishedAt', async () => {
    const { tenant, owner, exam } = await examAt('under_evaluation')
    const updated = await publishResults(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(updated.status).toBe('results_published')
    expect(updated.resultsPublishedAt).toBeTruthy()
  })

  it('refuses to publish results from any other state', async () => {
    const { tenant, owner, exam } = await examAt('live')
    await expect(
      publishResults(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Results can only be published from under_evaluation/)
  })
})

describe('archiveExam', () => {
  it('owner archives a completed exam', async () => {
    const { tenant, owner, exam } = await examAt('completed')
    const updated = await archiveExam(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(updated.status).toBe('archived')
  })

  it('rejects archiving from a non-terminal state (live)', async () => {
    const { tenant, owner, exam } = await examAt('live')
    await expect(
      archiveExam(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Cannot move an exam from live to archived/)
  })

  it('CRITICAL: a teacher cannot archive', async () => {
    const { tenant, teacher, exam } = await examAt('completed')
    await expect(
      archiveExam(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('duplicateExam', () => {
  it('clones a completed exam into a fresh draft with questions and classes copied', async () => {
    const { tenant, owner, exam } = await examAt('completed')
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 1, marks: 10 })
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 2, marks: 5 })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await db.insert(examClasses).values({ examId: exam.id, classId: cls.id })

    const copy = await duplicateExam(exam.id, tenant.id, owner.id, 'coaching_owner')

    expect(copy.id).not.toBe(exam.id)
    expect(copy.status).toBe('draft')       // lifecycle resets
    expect(copy.publishedAt).toBeNull()     // audit/lifecycle columns start clean
    expect(copy.title).toMatch(/\(Copy\)$/)
    expect(copy.totalMarks).toBe(15)        // recomputed from copied questions

    const copiedQs = await db.select().from(questions).where(eq(questions.examId, copy.id))
    expect(copiedQs).toHaveLength(2)

    const copiedClasses = await db.select().from(examClasses).where(eq(examClasses.examId, copy.id))
    expect(copiedClasses.map((c) => c.classId)).toEqual([cls.id])
  })
})
