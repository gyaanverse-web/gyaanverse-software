import { describe, it, expect } from 'vitest'
import { and, eq, asc } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams, questions, examClasses, examStatusHistory } from '@modules/exam/exam.schema.js'
import {
  transitionExam, publishResults, duplicateExam, archiveExam,
} from '@modules/exam/exam.service.js'
import {
  approveExam, scheduleExam, requestChanges, rejectExam, goLiveExam,
} from '@modules/exam-review/exam-review.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass, createTestQuestion,
  createTestUser, createMembership,
} from '../../helpers/fixtures.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'

// The exam state machine (transitionExam) is the single choke point for every
// status change. These tests pin down (a) which transitions are allowed, (b)
// which actor role each requires, and (c) that a history row is written.
//
// Exams are authored by the TEACHER throughout: the owner's role in the
// lifecycle starts at review. `author` transitions are the teacher's alone —
// see role-separation.test.ts for the owner-cannot-author boundary.

async function examAt(status: ExamStatus, opts: { plan?: 'free' | 'pro'; visibility?: 'private' | 'public_free' } = {}) {
  const { tenant, owner, teacher, student } = await seedTenantWithUsers(opts.plan ?? 'pro')
  const exam = await createTestExam({
    tenantId: tenant.id, createdBy: teacher.id, status,
    visibility: opts.visibility ?? 'private',
  })
  return { tenant, owner, teacher, student, exam }
}

const ownerActor = (id: string) => ({ id, role: 'coaching_owner' })
const teacherActor = (id: string) => ({ id, role: 'teacher' })

describe('transitionExam — allowed transitions', () => {
  it('author moves draft → under_review and records history', async () => {
    const { tenant, teacher, exam } = await examAt('draft')

    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'under_review', actor: teacherActor(teacher.id),
    })
    expect(updated.status).toBe('under_review')
    expect(updated.submittedAt).toBeTruthy()

    const [h] = await db.select().from(examStatusHistory).where(eq(examStatusHistory.examId, exam.id))
    expect(h.fromStatus).toBe('draft')
    expect(h.toStatus).toBe('under_review')
    expect(h.actorId).toBe(teacher.id)
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

  // `rejected` is terminal by design: the admin's two verdicts are
  // `changes_requested` (fix & resubmit) and `rejected` (paper is unusable).
  // A teacher salvages a rejected paper by duplicating it, not reopening it.
  it('CRITICAL: rejected is terminal — cannot be reopened to draft', async () => {
    const { tenant, owner, exam } = await examAt('rejected')
    await expect(
      transitionExam({ examId: exam.id, tenantId: tenant.id, to: 'draft', actor: ownerActor(owner.id) }),
    ).rejects.toThrow(/Cannot move an exam from rejected to draft/)
  })

  it('CRITICAL: rejected cannot be re-submitted for review', async () => {
    const { tenant, owner, exam } = await examAt('rejected')
    await expect(
      transitionExam({ examId: exam.id, tenantId: tenant.id, to: 'under_review', actor: ownerActor(owner.id) }),
    ).rejects.toThrow(/Cannot move an exam from rejected to under_review/)
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
    const { tenant, exam } = await examAt('draft')
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    await expect(
      transitionExam({
        examId: exam.id, tenantId: tenant.id, to: 'under_review',
        actor: teacherActor(colleague.id),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  // The hard role split: the owner reviews papers, they do not write or submit
  // them. Before the split this passed, because `author` accepted any owner.
  it('CRITICAL: the coaching owner cannot perform an author transition', async () => {
    const { tenant, owner, exam } = await examAt('draft')
    await expect(
      transitionExam({
        examId: exam.id, tenantId: tenant.id, to: 'under_review', actor: ownerActor(owner.id),
      }),
    ).rejects.toThrow(/Only the authoring teacher/)
  })

  // Publishing is the ONE place the owner may act in the teacher's stead. It is
  // a deliberate exception, not a hole in the role split: 'author' means the one
  // teacher who created the exam, so without it an author who has left the
  // coaching would strand already-computed marks with no way to release them.
  it('lets the coaching owner publish as a break-glass, and records who did it', async () => {
    const { tenant, owner, exam } = await examAt('ready_to_publish')
    const updated = await transitionExam({
      examId: exam.id, tenantId: tenant.id, to: 'completed', actor: ownerActor(owner.id),
    })
    expect(updated.status).toBe('completed')

    const [history] = await db
      .select()
      .from(examStatusHistory)
      .where(and(eq(examStatusHistory.examId, exam.id), eq(examStatusHistory.toStatus, 'completed')))
    expect(history.actorId).toBe(owner.id)
  })

  it('CRITICAL: a non-creator teacher still cannot publish someone else\'s exam', async () => {
    const { tenant, exam } = await examAt('ready_to_publish')
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    await expect(
      transitionExam({
        examId: exam.id, tenantId: tenant.id, to: 'completed', actor: teacherActor(colleague.id),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

// Approving and scheduling are two SEPARATE admin decisions, made at different
// times. The client was explicit: the admin approves when the paper is good, and
// picks a date later, whenever a slot is free. These tests pin the split — an
// approved exam must be able to sit undated indefinitely without being pushed
// into `scheduled`.
describe('approveExam', () => {
  it('moves under_review → approved and sets NO date', async () => {
    const { tenant, owner, exam } = await examAt('under_review')

    const updated = await approveExam(exam.id, tenant.id, ownerActor(owner.id))

    expect(updated.status).toBe('approved')
    expect(updated.reviewedBy).toBe(owner.id)
    // CRITICAL: approving must not schedule. The old fused call left the exam in
    // `scheduled` with a null scheduledAt, which the lifecycle worker skips
    // (isNotNull(scheduledAt)) — the exam could then never go live.
    expect(updated.scheduledAt).toBeNull()

    const hist = await db
      .select()
      .from(examStatusHistory)
      .where(eq(examStatusHistory.examId, exam.id))
      .orderBy(asc(examStatusHistory.createdAt))
    expect(hist.map((h) => h.toStatus)).toEqual(['approved'])
  })

  it('rejects approving an exam that is not under review', async () => {
    const { tenant, owner, exam } = await examAt('draft')
    await expect(
      approveExam(exam.id, tenant.id, ownerActor(owner.id)),
    ).rejects.toThrow(/Only exams under review can be approved/)
  })

  it('CRITICAL: a teacher cannot approve their own paper', async () => {
    const { tenant, teacher, exam } = await examAt('under_review')
    await expect(
      approveExam(exam.id, tenant.id, teacherActor(teacher.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('scheduleExam', () => {
  const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000)

  it('moves approved → scheduled, setting the window & classes', async () => {
    const { tenant, owner, teacher, exam } = await examAt('approved')
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const scheduledAt = inHours(1)
    const endsAt = inHours(3)

    const updated = await scheduleExam(exam.id, tenant.id, ownerActor(owner.id), {
      classIds: [cls.id], scheduledAt, endsAt, durationMins: 90,
    })

    expect(updated.status).toBe('scheduled')
    expect(updated.scheduledAt?.getTime()).toBe(scheduledAt.getTime())
    expect(updated.endsAt?.getTime()).toBe(endsAt.getTime())
    expect(updated.durationMins).toBe(90)

    const links = await db.select().from(examClasses).where(eq(examClasses.examId, exam.id))
    expect(links.map((l) => l.classId)).toEqual([cls.id])
  })

  it('re-schedules an already-scheduled exam without changing its status', async () => {
    const { tenant, owner, teacher, exam } = await examAt('approved')
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await scheduleExam(exam.id, tenant.id, ownerActor(owner.id), {
      classIds: [cls.id], scheduledAt: inHours(1),
    })

    const moved = inHours(48)
    const updated = await scheduleExam(exam.id, tenant.id, ownerActor(owner.id), {
      scheduledAt: moved,
    })

    expect(updated.status).toBe('scheduled')
    expect(updated.scheduledAt?.getTime()).toBe(moved.getTime())
    // One hop only — moving the date is not a new lifecycle event.
    const hist = await db
      .select()
      .from(examStatusHistory)
      .where(eq(examStatusHistory.examId, exam.id))
    expect(hist.filter((h) => h.toStatus === 'scheduled')).toHaveLength(1)
  })

  it('rejects a start time in the past', async () => {
    const { tenant, owner, exam } = await examAt('approved')
    await expect(
      scheduleExam(exam.id, tenant.id, ownerActor(owner.id), { scheduledAt: inHours(-1) }),
    ).rejects.toThrow(/scheduledAt must be in the future/)
  })

  it('rejects a window whose end is not after its start', async () => {
    const { tenant, owner, exam } = await examAt('approved')
    const t = inHours(1)
    await expect(
      scheduleExam(exam.id, tenant.id, ownerActor(owner.id), { scheduledAt: t, endsAt: t }),
    ).rejects.toThrow(/endsAt must be after scheduledAt/)
  })

  it('rejects scheduling an exam that has not been approved', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    await expect(
      scheduleExam(exam.id, tenant.id, ownerActor(owner.id), { scheduledAt: inHours(1) }),
    ).rejects.toThrow(/Only an approved exam can be scheduled/)
  })

  it('refuses to leave a private exam with no class, rolling the window back', async () => {
    const { tenant, owner, exam } = await examAt('approved')
    await expect(
      scheduleExam(exam.id, tenant.id, ownerActor(owner.id), {
        classIds: [], scheduledAt: inHours(1),
      }),
    ).rejects.toThrow(/needs at least one class/)

    // The whole call is one transaction: the date must not have been written.
    const [row] = await db.select().from(exams).where(eq(exams.id, exam.id))
    expect(row.status).toBe('approved')
    expect(row.scheduledAt).toBeNull()
  })

  it('CRITICAL: a teacher cannot schedule their own approved paper', async () => {
    const { tenant, teacher, exam } = await examAt('approved')
    await expect(
      scheduleExam(exam.id, tenant.id, teacherActor(teacher.id), { scheduledAt: inHours(1) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('an approved-but-undated exam cannot be started — it must be scheduled first', async () => {
    const { tenant, owner, exam } = await examAt('approved')
    await expect(
      goLiveExam(exam.id, tenant.id, ownerActor(owner.id)),
    ).rejects.toThrow(/Cannot move an exam from approved to live/)
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
  it('moves ready_to_publish → completed and stamps both timestamps', async () => {
    const { tenant, teacher, exam } = await examAt('ready_to_publish')
    const updated = await publishResults(exam.id, tenant.id, teacher.id, 'teacher')
    expect(updated.status).toBe('completed')
    // Publishing IS completing, so both columns record the same moment.
    expect(updated.resultsPublishedAt).toBeTruthy()
    expect(updated.completedAt).toBeTruthy()
  })

  // The review gate. An exam still being evaluated has incomplete numbers, so
  // publishing must not be reachable — and the error has to say why, not just
  // "wrong state", or the teacher has no idea what they are waiting for.
  it('refuses to publish while sessions are still being evaluated', async () => {
    const { tenant, teacher, exam } = await examAt('under_evaluation')
    await expect(
      publishResults(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toThrow(/still being evaluated/)
  })

  it('refuses to publish results from any other state', async () => {
    const { tenant, teacher, exam } = await examAt('live')
    await expect(
      publishResults(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toThrow(/Results can only be published from ready_to_publish/)
  })

  it('accepts the coaching owner as a break-glass publisher', async () => {
    const { tenant, owner, exam } = await examAt('ready_to_publish')
    const updated = await publishResults(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(updated.status).toBe('completed')
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
    const { tenant, teacher, exam } = await examAt('completed')
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 1, marks: 10 })
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 2, marks: 5 })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await db.insert(examClasses).values({ examId: exam.id, classId: cls.id })

    const copy = await duplicateExam(exam.id, tenant.id, teacher.id, 'teacher')

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
