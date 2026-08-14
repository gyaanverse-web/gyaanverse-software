import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams } from '@modules/exam/exam.schema.js'
import {
  updateExam, submitForReview, duplicateExam, discardDraft, loadVisibleExam,
  addQuestion, updateQuestion, removeQuestion, reorderQuestions,
  setExamChapters, linkExamToClass, unlinkExamFromClass, saveWizardState,
} from '@modules/exam/exam.service.js'
import { approveExam, requestChanges, rejectExam } from '@modules/exam-review/exam-review.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestQuestion, createTestClass,
} from '../../helpers/fixtures.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'

// ── Custody of an exam across the lifecycle ──────────────────────────────────
//
// The client's framing: an exam has exactly ONE owner at any moment, and the
// handover points are the status changes.
//
//   draft / changes_requested → the TEACHER's. They author freely.
//   under_review              → the ADMIN's. The teacher cannot touch it: no
//                               edits, no questions, no deleting. Duplicating is
//                               their only move. The admin, in turn, judges the
//                               paper — they do not fix it, so they get no
//                               authoring powers either.
//   rejected                  → NOBODY's. Terminal; read-only for everyone.
//   approved                  → the ADMIN's, indefinitely. Approval is a verdict,
//                               not a date; the teacher watches the status only.
//
// role-separation.test.ts pins WHO may act; this file pins WHEN, which is the
// half the manager flagged as confusing.

const mcq = {
  type: 'mcq_single',
  body: 'Pick the correct option',
  marks: 4,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
  answerKey: { optionId: 'a' },
}

const asOwner = (id: string) => [id, 'coaching_owner'] as const
const asTeacher = (id: string) => [id, 'teacher'] as const

/** A tenant with a teacher-authored exam parked at `status`, plus one question. */
async function examAt(status: ExamStatus) {
  const seeded = await seedTenantWithUsers('pro')
  const exam = await createTestExam({
    tenantId: seeded.tenant.id, createdBy: seeded.teacher.id, status, visibility: 'private',
  })
  const question = await createTestQuestion({ examId: exam.id, tenantId: seeded.tenant.id })
  return { ...seeded, exam, question }
}

// Every authoring action a teacher has, so a "locked" state can be shown to lock
// ALL of them rather than just the one that happened to be tested.
const LOCKED = /can only be edited while in draft or changes_requested/

async function expectAllAuthoringLocked(
  ctx: Awaited<ReturnType<typeof examAt>>,
) {
  const { tenant, teacher, exam, question } = ctx
  const who = asTeacher(teacher.id)
  const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

  await expect(updateExam(exam.id, tenant.id, ...who, { title: 'Edited' })).rejects.toThrow(LOCKED)
  await expect(addQuestion(exam.id, tenant.id, ...who, mcq)).rejects.toThrow(LOCKED)
  await expect(
    updateQuestion(question.id, exam.id, tenant.id, ...who, { body: 'Reworded' }),
  ).rejects.toThrow(LOCKED)
  await expect(removeQuestion(question.id, exam.id, tenant.id, ...who)).rejects.toThrow(LOCKED)
  await expect(reorderQuestions(exam.id, tenant.id, ...who, [question.id])).rejects.toThrow(LOCKED)
  await expect(setExamChapters(exam.id, tenant.id, ...who, [])).rejects.toThrow(LOCKED)
  await expect(linkExamToClass(exam.id, tenant.id, ...who, cls.id)).rejects.toThrow(LOCKED)
  await expect(unlinkExamFromClass(exam.id, tenant.id, ...who, cls.id)).rejects.toThrow(LOCKED)
  await expect(saveWizardState(exam.id, tenant.id, ...who, { step: 2, state: {} })).rejects.toThrow(LOCKED)
}

describe('under_review — the exam is the admin\'s, not the teacher\'s', () => {
  it('CRITICAL: the teacher cannot edit anything at all', async () => {
    const ctx = await examAt('under_review')
    await expectAllAuthoringLocked(ctx)
  })

  it('CRITICAL: the teacher cannot delete it', async () => {
    const { tenant, teacher, exam } = await examAt('under_review')
    await expect(
      discardDraft(exam.id, tenant.id, ...asTeacher(teacher.id)),
    ).rejects.toThrow(/Only a draft can be discarded/)

    const [row] = await db.select().from(exams).where(eq(exams.id, exam.id))
    expect(row).toBeTruthy()
  })

  it('the teacher CAN duplicate it — their one move while it is in the queue', async () => {
    const { tenant, teacher, exam } = await examAt('under_review')

    const copy = await duplicateExam(exam.id, tenant.id, ...asTeacher(teacher.id))

    // A fresh draft they own outright; the submitted paper is untouched.
    expect(copy.status).toBe('draft')
    expect(copy.createdBy).toBe(teacher.id)
    expect(copy.id).not.toBe(exam.id)
    const [original] = await db.select().from(exams).where(eq(exams.id, exam.id))
    expect(original.status).toBe('under_review')
  })

  it('the teacher cannot re-submit to jump the queue', async () => {
    const { tenant, teacher, exam } = await examAt('under_review')
    await expect(
      submitForReview(exam.id, tenant.id, ...asTeacher(teacher.id)),
    ).rejects.toThrow(/Cannot submit an exam that is under_review/)
  })

  it('the admin can read the whole paper to judge it', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const visible = await loadVisibleExam(exam.id, tenant.id, ...asOwner(owner.id))
    expect(visible.id).toBe(exam.id)
  })

  it('CRITICAL: the admin still cannot touch the questions — judging is not fixing', async () => {
    const { tenant, owner, exam, question } = await examAt('under_review')
    const who = asOwner(owner.id)
    const notAuthor = /Only a teacher can author exams/

    await expect(addQuestion(exam.id, tenant.id, ...who, mcq)).rejects.toThrow(notAuthor)
    await expect(
      updateQuestion(question.id, exam.id, tenant.id, ...who, { body: 'Reworded by admin' }),
    ).rejects.toThrow(notAuthor)
    await expect(removeQuestion(question.id, exam.id, tenant.id, ...who)).rejects.toThrow(notAuthor)
    await expect(reorderQuestions(exam.id, tenant.id, ...who, [question.id])).rejects.toThrow(notAuthor)
    await expect(updateExam(exam.id, tenant.id, ...who, { title: 'Retitled' })).rejects.toThrow(notAuthor)
  })

  it('the admin has exactly three verdicts, each landing in its own state', async () => {
    for (const [verdict, expected] of [
      ['approve', 'approved'],
      ['request-changes', 'changes_requested'],
      ['reject', 'rejected'],
    ] as const) {
      const { tenant, owner, exam } = await examAt('under_review')
      const actor = { id: owner.id, role: 'coaching_owner' }

      const updated =
        verdict === 'approve' ? await approveExam(exam.id, tenant.id, actor)
        : verdict === 'request-changes' ? await requestChanges(exam.id, tenant.id, actor, 'Fix Q3')
        : await rejectExam(exam.id, tenant.id, actor, 'Out of syllabus')

      expect(updated.status).toBe(expected)
      expect(updated.reviewedBy).toBe(owner.id)
    }
  })
})

describe('changes_requested — custody returns to the teacher', () => {
  it('the teacher regains full edit rights and can re-submit', async () => {
    const { tenant, teacher, exam } = await examAt('changes_requested')
    const who = asTeacher(teacher.id)

    const edited = await updateExam(exam.id, tenant.id, ...who, { title: 'Reworked' })
    expect(edited.title).toBe('Reworked')

    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, ...who, cls.id)
    const resubmitted = await submitForReview(exam.id, tenant.id, ...who)
    expect(resubmitted.status).toBe('under_review')
  })

  it('the admin\'s remarks travel with it so the teacher knows what to fix', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const updated = await requestChanges(
      exam.id, tenant.id, { id: owner.id, role: 'coaching_owner' }, 'Q3 has two correct options',
    )
    expect(updated.reviewRemarks).toBe('Q3 has two correct options')
  })
})

describe('rejected — terminal, editable by nobody', () => {
  it('CRITICAL: the teacher cannot edit it', async () => {
    const ctx = await examAt('rejected')
    await expectAllAuthoringLocked(ctx)
  })

  it('CRITICAL: the teacher cannot resurrect it by re-submitting', async () => {
    const { tenant, teacher, exam } = await examAt('rejected')
    await expect(
      submitForReview(exam.id, tenant.id, ...asTeacher(teacher.id)),
    ).rejects.toThrow(/Cannot submit an exam that is rejected/)
  })

  it('CRITICAL: the admin cannot edit it either — the verdict is not a handle', async () => {
    const { tenant, owner, exam } = await examAt('rejected')
    await expect(
      updateExam(exam.id, tenant.id, ...asOwner(owner.id), { title: 'Salvaged' }),
    ).rejects.toThrow(/Only a teacher can author exams/)
  })

  it('duplicating into a fresh draft is the only way forward', async () => {
    const { tenant, teacher, exam } = await examAt('rejected')
    const copy = await duplicateExam(exam.id, tenant.id, ...asTeacher(teacher.id))
    expect(copy.status).toBe('draft')

    // And the copy is genuinely editable — the rejection does not follow it.
    const edited = await updateExam(copy.id, tenant.id, ...asTeacher(teacher.id), { title: 'Take two' })
    expect(edited.title).toBe('Take two')
  })

  it('the teacher can still read it, so they can see WHY it was rejected', async () => {
    const { tenant, owner, teacher, exam } = await examAt('under_review')
    await rejectExam(exam.id, tenant.id, { id: owner.id, role: 'coaching_owner' }, 'Out of syllabus')

    const visible = await loadVisibleExam(exam.id, tenant.id, ...asTeacher(teacher.id))
    expect(visible.status).toBe('rejected')
    expect(visible.reviewRemarks).toBe('Out of syllabus')
  })
})

describe('approved — the teacher watches, the admin decides when', () => {
  it('CRITICAL: approval does not hand edit rights back', async () => {
    const ctx = await examAt('approved')
    await expectAllAuthoringLocked(ctx)
  })

  it('an approved exam may sit undated indefinitely', async () => {
    const { tenant, owner, exam } = await examAt('under_review')
    const approved = await approveExam(exam.id, tenant.id, { id: owner.id, role: 'coaching_owner' })

    // Nothing about approving implies a date — that is the whole point of the
    // split. The exam rests here until the admin picks a slot.
    expect(approved.status).toBe('approved')
    expect(approved.scheduledAt).toBeNull()
    expect(approved.endsAt).toBeNull()
  })

  it('the teacher can read the metadata and status while they wait', async () => {
    const { tenant, teacher, exam } = await examAt('approved')
    const visible = await loadVisibleExam(exam.id, tenant.id, ...asTeacher(teacher.id))
    expect(visible.status).toBe('approved')
    expect(visible.title).toBe(exam.title)
  })

  it('the teacher cannot delete an approved exam', async () => {
    const { tenant, teacher, exam } = await examAt('approved')
    await expect(
      discardDraft(exam.id, tenant.id, ...asTeacher(teacher.id)),
    ).rejects.toThrow(/Only a draft can be discarded/)
  })
})
