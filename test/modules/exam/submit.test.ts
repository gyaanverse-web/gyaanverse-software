import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams, examStatusHistory } from '@modules/exam/exam.schema.js'
import { submitForReview, addQuestion, linkExamToClass } from '@modules/exam/exam.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass, createTestUser, createMembership,
  setBillingEnabled,
} from '../../helpers/fixtures.js'

// submitForReview replaces the old self-publish. The same gates that used to
// block going live now block entry into the admin review pipeline:
//   • at least one question,
//   • for a private exam, at least one class assignment,
//   • for a public exam, the public_mocks feature.
// On success the exam moves draft|changes_requested → under_review.
//
// Every exam here is authored by the TEACHER: under the hard role split the
// coaching owner does not author or submit papers at all (see
// role-separation.test.ts for that boundary).

const mcq = {
  type: 'mcq_single',
  body: 'Pick the correct option',
  marks: 4,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
  answerKey: { optionId: 'a' },
}

async function draftPrivateExamWithQuestion(plan: 'free' | 'pro' = 'pro') {
  const { tenant, owner, teacher } = await seedTenantWithUsers(plan)
  const exam = await createTestExam({
    tenantId: tenant.id, createdBy: teacher.id, visibility: 'private', status: 'draft',
  })
  await addQuestion(exam.id, tenant.id, teacher.id, 'teacher', mcq)
  return { tenant, owner, teacher, exam }
}

describe('submitForReview — class assignment gate', () => {
  it('refuses to submit a private exam with no class assigned', async () => {
    const { tenant, teacher, exam } = await draftPrivateExamWithQuestion()

    await expect(
      submitForReview(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toThrow(/Assign at least one class before submitting/)

    // The exam stays a draft — a rejected submit must not mutate status.
    const [row] = await db.select({ status: exams.status }).from(exams).where(eq(exams.id, exam.id))
    expect(row.status).toBe('draft')
  })

  it('submits a private exam once a class is linked', async () => {
    const { tenant, teacher, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, teacher.id, 'teacher', cls.id)

    const submitted = await submitForReview(exam.id, tenant.id, teacher.id, 'teacher')
    expect(submitted.status).toBe('under_review')
    expect(submitted.submittedAt).toBeTruthy()

    // The transition is recorded on the audit timeline.
    const history = await db
      .select()
      .from(examStatusHistory)
      .where(eq(examStatusHistory.examId, exam.id))
    expect(history).toHaveLength(1)
    expect(history[0].fromStatus).toBe('draft')
    expect(history[0].toStatus).toBe('under_review')
    expect(history[0].actorId).toBe(teacher.id)
  })

  it('does not require a class for a public exam', async () => {
    // Pro plan carries the public_mocks feature that public submission needs.
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(exam.id, tenant.id, teacher.id, 'teacher', mcq)

    const submitted = await submitForReview(exam.id, tenant.id, teacher.id, 'teacher')
    expect(submitted.status).toBe('under_review')
  })

  it('still refuses to submit an exam with no questions', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, visibility: 'private', status: 'draft',
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, teacher.id, 'teacher', cls.id)

    await expect(
      submitForReview(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toThrow(/Add at least one question before submitting/)
  })

  it('gates public submission behind the public_mocks feature (free plan)', async () => {
    // Feature gates only exist while billing is on; it defaults off (MVP).
    await setBillingEnabled(true)

    // Free plan lacks public_mocks; a public exam can't enter review.
    const { tenant, teacher } = await seedTenantWithUsers('free')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(exam.id, tenant.id, teacher.id, 'teacher', mcq)

    await expect(
      submitForReview(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' })
  })
})

describe('submitForReview — status guard & re-submission', () => {
  it('re-submits an exam that was bounced back with changes_requested', async () => {
    const { tenant, teacher, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, teacher.id, 'teacher', cls.id)
    // Simulate an admin bounce: park the exam in changes_requested.
    await db.update(exams).set({ status: 'changes_requested' }).where(eq(exams.id, exam.id))

    const resubmitted = await submitForReview(exam.id, tenant.id, teacher.id, 'teacher')
    expect(resubmitted.status).toBe('under_review')
  })

  it('refuses to submit an exam that is already under review', async () => {
    const { tenant, teacher, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, tenant.id, teacher.id, 'teacher', cls.id)
    await db.update(exams).set({ status: 'under_review' }).where(eq(exams.id, exam.id))

    await expect(
      submitForReview(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toThrow(/Cannot submit an exam that is under_review/)
  })

  it('CRITICAL: a teacher cannot submit another teacher\'s exam', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const other = await createTestExam({
      tenantId: tenant.id, createdBy: teacher.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(other.id, tenant.id, teacher.id, 'teacher', mcq)

    // A second teacher in the SAME coaching is still not the author.
    const colleague = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    await expect(
      submitForReview(other.id, tenant.id, colleague.id, 'teacher'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('submitForReview — monthly mock quota', () => {
  // The quota moved from draft creation to submission, so starting (and
  // abandoning) drafts is free. The free plan allows 3 mocks/month.
  const FREE_MOCKS = 3

  async function submittableDraft(tenantId: string, teacherId: string, classId: string) {
    const e = await createTestExam({
      tenantId, createdBy: teacherId, visibility: 'private', status: 'draft',
    })
    await addQuestion(e.id, tenantId, teacherId, 'teacher', mcq)
    await linkExamToClass(e.id, tenantId, teacherId, 'teacher', classId)
    return e
  }

  it('charges the quota on submit, not on draft creation', async () => {
    // The quota is only charged while billing is on; it defaults off (MVP).
    await setBillingEnabled(true)

    const { tenant, teacher } = await seedTenantWithUsers('free')
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    // Well past the free plan's monthly allowance — but all still drafts, which
    // under the old create-time accounting would already have been refused.
    const drafts = []
    for (let i = 0; i < FREE_MOCKS + 3; i++) {
      drafts.push(await submittableDraft(tenant.id, teacher.id, cls.id))
    }

    // Creating them cost nothing; the allowed submissions go through.
    for (let i = 0; i < FREE_MOCKS; i++) {
      const submitted = await submitForReview(drafts[i].id, tenant.id, teacher.id, 'teacher')
      expect(submitted.status).toBe('under_review')
    }

    // The next submission of the month is the one that hits the plan limit.
    await expect(
      submitForReview(drafts[FREE_MOCKS].id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' })

    // …and the refused paper is still an editable draft, not a half-submitted one.
    const [row] = await db.select({ status: exams.status }).from(exams)
      .where(eq(exams.id, drafts[FREE_MOCKS].id))
    expect(row.status).toBe('draft')
  })

  it('does not charge the quota again when re-submitting after changes_requested', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('free')
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    // Use up the whole month's allowance.
    const submitted = []
    for (let i = 0; i < FREE_MOCKS; i++) {
      const e = await submittableDraft(tenant.id, teacher.id, cls.id)
      await submitForReview(e.id, tenant.id, teacher.id, 'teacher')
      submitted.push(e)
    }

    // The quota is now full, but a bounced paper coming back is not a new mock.
    await db.update(exams).set({ status: 'changes_requested' }).where(eq(exams.id, submitted[0].id))
    const resubmitted = await submitForReview(submitted[0].id, tenant.id, teacher.id, 'teacher')
    expect(resubmitted.status).toBe('under_review')
  })
})
