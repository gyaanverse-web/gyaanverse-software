import { describe, it, expect } from 'vitest'
import {
  createExam, updateExam, submitForReview, publishResults, duplicateExam,
  archiveExam, addQuestion, removeQuestion, reorderQuestions,
  setExamChapters, linkExamToClass, unlinkExamFromClass,
  startWizardDraft, saveWizardState, discardDraft, assertExamAuthor,
} from '@modules/exam/exam.service.js'
import {
  generateIntoDraft, keepDraftQuestion, keepAllDraftQuestions, discardDraftQuestion,
  regenerateDraftQuestion, editDraftQuestion, finalizeGeneration,
} from '@modules/exam/exam.generation.service.js'
import {
  approveExam, scheduleExam, requestChanges, rejectExam, extendExamTime, forceSubmitExam,
} from '@modules/exam-review/exam-review.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestQuestion, createTestClass,
  createTestUser, createMembership,
} from '../../helpers/fixtures.js'

// ── The hard role split ──────────────────────────────────────────────────────
//
// Authoring a paper and approving one are DIFFERENT JOBS, not two rungs of the
// same ladder. Before this change a coaching_owner could do everything a teacher
// could plus review it, which made the product impossible to explain: the owner
// was "a teacher with extra buttons", and could rubber-stamp their own paper.
//
//   TEACHER  writes, edits, generates, submits, publishes results, duplicates.
//   OWNER    approves, requests changes, rejects, schedules, runs live, archives.
//
// Neither can reach into the other's half. These tests are the contract.

const mcq = {
  type: 'mcq_single',
  body: 'Pick the correct option',
  marks: 4,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
  answerKey: { optionId: 'a' },
}

/** Every argument list in this module ends with (…, requesterId, requesterRole). */
const asOwner = (id: string) => [id, 'coaching_owner'] as const
const asTeacher = (id: string) => [id, 'teacher'] as const

describe('the coaching owner cannot author exam content', () => {
  it('CRITICAL: cannot open a wizard draft', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    await expect(
      startWizardDraft({ tenantId: tenant.id, createdBy: owner.id, requesterRole: 'coaching_owner' }),
    ).rejects.toThrow(/Only a teacher can author exams/)
  })

  it('CRITICAL: cannot edit a teacher\'s draft', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })

    await expect(
      updateExam(exam.id, tenant.id, ...asOwner(owner.id), { title: 'Renamed by the boss' }),
    ).rejects.toThrow(/Only a teacher can author exams/)
  })

  it('CRITICAL: cannot add, remove or reorder questions', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    const q = await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 1 })

    await expect(addQuestion(exam.id, tenant.id, ...asOwner(owner.id), mcq))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(removeQuestion(q.id, exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(reorderQuestions(exam.id, tenant.id, ...asOwner(owner.id), [q.id]))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot change scope or class assignment', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await expect(setExamChapters(exam.id, tenant.id, ...asOwner(owner.id), []))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(linkExamToClass(exam.id, tenant.id, ...asOwner(owner.id), cls.id))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(unlinkExamFromClass(exam.id, tenant.id, ...asOwner(owner.id), cls.id))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot submit a paper into their own review queue', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    await addQuestion(exam.id, tenant.id, ...asTeacher(teacher.id), mcq)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, ...asTeacher(teacher.id), cls.id)

    await expect(submitForReview(exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toThrow(/Only a teacher can author exams/)
  })

  // Publishing results is the ONE deliberate exception to the role split, and it
  // is not an authoring action — the paper is finished and graded by this point,
  // the owner is only releasing numbers the teacher's students already earned.
  //
  // It exists because `author` means the ONE teacher who created the exam. An
  // author-only rule would let a teacher who leaves the coaching (or is simply
  // away) strand marks that are already computed, with nobody able to release
  // them. The override is audited — see the exam_status_history assertion in
  // state-machine.test.ts.
  it('CAN publish results as a break-glass when the authoring teacher is unavailable', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'ready_to_publish',
    })
    const updated = await publishResults(exam.id, tenant.id, ...asOwner(owner.id))
    expect(updated.status).toBe('completed')
  })

  it('CRITICAL: cannot duplicate or discard a teacher\'s paper', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })

    await expect(duplicateExam(exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(discardDraft(exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot run the draft-review tools on a generated paper', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    const q = await createTestQuestion({ examId: exam.id, tenantId: tenant.id, order: 1 })

    await expect(keepDraftQuestion(exam.id, q.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(keepAllDraftQuestions(exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(discardDraftQuestion(exam.id, q.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(regenerateDraftQuestion(exam.id, q.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(editDraftQuestion(exam.id, q.id, tenant.id, ...asOwner(owner.id), { marks: 9 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(finalizeGeneration(exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot generate questions into a draft', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })

    await expect(generateIntoDraft({
      examId: exam.id,
      tenantId: tenant.id,
      requesterId: owner.id,
      requesterRole: 'coaching_owner',
      params: {
        subjectId: '00000000-0000-0000-0000-000000000000',
        totalQuestions: 1,
        typeDistribution: { mcq_single: 1 },
        difficultyDistribution: { easy: 1 },
      },
    })).rejects.toThrow(/Only a teacher can author exams/)
  })

  // The owner authoring an exam of their own is the loophole that would put us
  // straight back where we started: they could then approve it themselves.
  it('CRITICAL: an owner-created exam row is still not owner-editable', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, status: 'draft' })

    await expect(assertExamAuthor(exam.id, tenant.id, ...asOwner(owner.id)))
      .rejects.toThrow(/Only a teacher can author exams/)
  })
})

describe('the teacher cannot make review or live decisions', () => {
  it('CRITICAL: cannot approve their own paper', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'under_review',
    })
    await expect(
      approveExam(exam.id, tenant.id, { id: teacher.id, role: 'teacher' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot schedule their own approved paper', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'approved',
    })
    await expect(
      scheduleExam(exam.id, tenant.id, { id: teacher.id, role: 'teacher' }, {
        scheduledAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot request changes or reject', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'under_review',
    })
    const actor = { id: teacher.id, role: 'teacher' }

    await expect(requestChanges(exam.id, tenant.id, actor, 'nope'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(rejectExam(exam.id, tenant.id, actor, 'nope'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot use the live controls', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'live' })
    const actor = { id: teacher.id, role: 'teacher' }

    await expect(extendExamTime(exam.id, tenant.id, actor, 15))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(forceSubmitExam(exam.id, tenant.id, actor))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('CRITICAL: cannot archive their own completed paper', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'completed',
    })
    await expect(archiveExam(exam.id, tenant.id, ...asTeacher(teacher.id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('teachers are isolated from each other', () => {
  it('CRITICAL: a teacher cannot edit a colleague\'s paper', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })

    await expect(
      updateExam(exam.id, tenant.id, ...asTeacher(colleague.id), { title: 'Mine now' }),
    ).rejects.toThrow(/You can only manage exams you created/)
  })
})

describe('the happy path still works for the right role', () => {
  it('a teacher authors and submits; the owner approves, then schedules later', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')

    // Teacher's half of the lifecycle.
    const exam = await createExam({
      tenantId: tenant.id, createdBy: teacher.id,
      title: 'Kinematics Unit Test', durationMins: 60, visibility: 'private',
    })
    await addQuestion(exam.id, tenant.id, ...asTeacher(teacher.id), mcq)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, ...asTeacher(teacher.id), cls.id)

    const submitted = await submitForReview(exam.id, tenant.id, ...asTeacher(teacher.id))
    expect(submitted.status).toBe('under_review')

    // Owner's half — two separate decisions. Approving settles whether the paper
    // is good; the exam then waits, undated, until a slot is free.
    const ownerActor = { id: owner.id, role: 'coaching_owner' }
    const approved = await approveExam(exam.id, tenant.id, ownerActor)
    expect(approved.status).toBe('approved')
    expect(approved.reviewedBy).toBe(owner.id)
    expect(approved.scheduledAt).toBeNull()

    // The teacher is locked out for good now — approval is not a return of edit
    // rights, they can only look at the metadata and the status.
    await expect(
      updateExam(exam.id, tenant.id, ...asTeacher(teacher.id), { title: 'Late tweak' }),
    ).rejects.toThrow(/can only be edited while in draft or changes_requested/)

    const scheduled = await scheduleExam(exam.id, tenant.id, ownerActor, {
      classIds: [cls.id],
      scheduledAt: new Date(Date.now() + 3_600_000),
      endsAt: new Date(Date.now() + 7_200_000),
    })
    expect(scheduled.status).toBe('scheduled')
  })

  it('a teacher may still edit after the owner requests changes', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'under_review',
    })

    // Locked while it sits in the owner's queue…
    await expect(
      updateExam(exam.id, tenant.id, ...asTeacher(teacher.id), { title: 'Sneaky edit' }),
    ).rejects.toThrow(/can only be edited while in draft or changes_requested/)

    // …and unlocked again the moment it is bounced back.
    await requestChanges(exam.id, tenant.id, { id: owner.id, role: 'coaching_owner' }, 'Fix Q3')
    const edited = await updateExam(
      exam.id, tenant.id, ...asTeacher(teacher.id), { title: 'Fixed Q3' },
    )
    expect(edited.title).toBe('Fixed Q3')
  })

  it('saveWizardState is refused once the paper is under review', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, status: 'under_review',
    })
    await expect(
      saveWizardState(exam.id, tenant.id, ...asTeacher(teacher.id), { step: 2, state: {} }),
    ).rejects.toThrow(/can only be edited while in draft or changes_requested/)
  })
})
