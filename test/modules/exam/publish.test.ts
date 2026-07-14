import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams } from '@modules/exam/exam.schema.js'
import { publishExam, addQuestion, linkExamToClass } from '@modules/exam/exam.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestClass,
} from '../../helpers/fixtures.js'

// Publishing gates: an exam needs at least one question, and — for private
// exams — at least one class assignment, since a private exam only reaches
// students through the classes it is linked to.

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

describe('publishExam — class assignment gate', () => {
  it('refuses to publish a private exam with no class assigned', async () => {
    const { tenant, owner, exam } = await draftPrivateExamWithQuestion()

    await expect(
      publishExam(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Assign at least one class before publishing/)

    // The exam stays a draft — a rejected publish must not mutate status.
    const [row] = await db.select({ status: exams.status }).from(exams).where(eq(exams.id, exam.id))
    expect(row.status).toBe('draft')
  })

  it('publishes a private exam once a class is linked', async () => {
    const { tenant, owner, exam } = await draftPrivateExamWithQuestion()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await linkExamToClass(exam.id, tenant.id, owner.id, 'coaching_owner', cls.id)

    const published = await publishExam(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(published.status).toBe('published')
    expect(published.publishedAt).toBeTruthy()
  })

  it('does not require a class for a public exam', async () => {
    // Pro plan carries the public_mocks feature that public publishing needs.
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'draft',
    })
    await addQuestion(exam.id, tenant.id, owner.id, 'coaching_owner', mcq)

    const published = await publishExam(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(published.status).toBe('published')
  })

  it('still refuses to publish an exam with no questions', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'draft',
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    await linkExamToClass(exam.id, tenant.id, owner.id, 'coaching_owner', cls.id)

    await expect(
      publishExam(exam.id, tenant.id, owner.id, 'coaching_owner'),
    ).rejects.toThrow(/Add at least one question before publishing/)
  })
})
