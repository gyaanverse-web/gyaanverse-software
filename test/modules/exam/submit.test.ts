import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams, examStatusHistory } from '@modules/exam/exam.schema.js'
import { submitForReview, addQuestion, linkExamToClass } from '@modules/exam/exam.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass,
} from '../../helpers/fixtures.js'

// submitForReview replaces the old self-publish. The same gates that used to
// block going live now block entry into the admin review pipeline:
//   • at least one question,
//   • for a private exam, at least one class assignment,
//   • for a public exam, the public_mocks feature.
// On success the exam moves draft|changes_requested → under_review.

const mcq = {
  type: 'mcq_single',
  body: 'Pick the correct option',
  marks: 4,
  payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
  answerKey: { optionId: 'a' },
}

async function draftPrivateExamWithQuestion(plan: 'free' | 'pro' = 'pro') {
  const { tenant, owner } = await seedTenantWithUsers(plan)
  const exam = await createTestExam({
    tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'draft',
  })
  await addQuestion(exam.id, tenant.id, owner.id, 'coaching_owner', mcq)
  return { tenant, owner, exam }
}

describe('submitForReview — class assignment gate', () => {
  it('refuses to submit a private exam with no class assigned', async () => {
    const { tenant, owner, exam } = await draftPrivateExamWithQuestion()

    await expect(
      submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Assign at least one class before submitting/)

    // The exam stays a draft — a rejected submit must not mutate status.
    const [row] = await db.select({ status: exams.status }).from(exams).where(eq(exams.id, exam.id))
    expect(row.status).toBe('draft')
  })

  it('submits a private exam once a class is linked', async () => {
    const { tenant, owner, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await linkExamToClass(exam.id, tenant.id, owner.id, 'coaching_owner', cls.id)

    const submitted = await submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner')
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
    expect(history[0].actorId).toBe(owner.id)
  })

  it('does not require a class for a public exam', async () => {
    // Pro plan carries the public_mocks feature that public submission needs.
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(exam.id, tenant.id, owner.id, 'coaching_owner', mcq)

    const submitted = await submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(submitted.status).toBe('under_review')
  })

  it('still refuses to submit an exam with no questions', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'draft',
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await linkExamToClass(exam.id, tenant.id, owner.id, 'coaching_owner', cls.id)

    await expect(
      submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Add at least one question before submitting/)
  })

  it('gates public submission behind the public_mocks feature (free plan)', async () => {
    // Free plan lacks public_mocks; a public exam can't enter review.
    const { tenant, owner } = await seedTenantWithUsers('free')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(exam.id, tenant.id, owner.id, 'coaching_owner', mcq)

    await expect(
      submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' })
  })
})

describe('submitForReview — status guard & re-submission', () => {
  it('re-submits an exam that was bounced back with changes_requested', async () => {
    const { tenant, owner, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await linkExamToClass(exam.id, tenant.id, owner.id, 'coaching_owner', cls.id)
    // Simulate an admin bounce: park the exam in changes_requested.
    await db.update(exams).set({ status: 'changes_requested' }).where(eq(exams.id, exam.id))

    const resubmitted = await submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(resubmitted.status).toBe('under_review')
  })

  it('refuses to submit an exam that is already under review', async () => {
    const { tenant, owner, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await linkExamToClass(exam.id, tenant.id, owner.id, 'coaching_owner', cls.id)
    await db.update(exams).set({ status: 'under_review' }).where(eq(exams.id, exam.id))

    await expect(
      submitForReview(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Cannot submit an exam that is under_review/)
  })

  it('CRITICAL: a teacher cannot submit another teacher\'s exam', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers('pro')
    // Owner-authored exam; a plain teacher is not the creator.
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(exam.id, tenant.id, owner.id, 'coaching_owner', mcq)

    await expect(
      submitForReview(exam.id, tenant.id, teacher.id, 'teacher'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
