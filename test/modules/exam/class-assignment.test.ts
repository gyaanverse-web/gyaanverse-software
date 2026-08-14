import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examClasses } from '@modules/exam/exam.schema.js'
import {
  resolveTenantClasses, linkExamToClass, createExam,
} from '@modules/exam/exam.service.js'
import { seedTenantWithUsers, createTestExam, createTestClass } from '../../helpers/fixtures.js'

// The wizard now asks for the class in step 1, so class ids arrive from the
// client on the generate call as well as the manual link route. Both funnel
// through `resolveTenantClasses`, which is the only thing standing between a
// caller-supplied uuid and a cross-tenant exam assignment.

describe('resolveTenantClasses', () => {
  it('resolves classes belonging to the tenant', async () => {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    const a = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })
    const b = await createTestClass({ tenantId: tenant.id, teacherId: owner.id })

    const rows = await resolveTenantClasses([a.id, b.id], tenant.id)
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('CRITICAL: refuses a class belonging to another tenant', async () => {
    const { tenant: mine } = await seedTenantWithUsers('pro')
    const { tenant: theirs, owner: theirOwner } = await seedTenantWithUsers('pro')
    const foreign = await createTestClass({ tenantId: theirs.id, teacherId: theirOwner.id })

    await expect(resolveTenantClasses([foreign.id], mine.id)).rejects.toThrow(/Class/)
  })

  it('CRITICAL: refuses the whole set when one id is foreign', async () => {
    const { tenant: mine, owner } = await seedTenantWithUsers('pro')
    const { tenant: theirs, owner: theirOwner } = await seedTenantWithUsers('pro')
    const ours = await createTestClass({ tenantId: mine.id, teacherId: owner.id })
    const foreign = await createTestClass({ tenantId: theirs.id, teacherId: theirOwner.id })

    await expect(resolveTenantClasses([ours.id, foreign.id], mine.id)).rejects.toThrow(/Class/)
  })

  it('rejects an unknown class id', async () => {
    const { tenant } = await seedTenantWithUsers('pro')
    await expect(
      resolveTenantClasses(['00000000-0000-0000-0000-000000000000'], tenant.id),
    ).rejects.toThrow(/Class/)
  })

  it('returns nothing for an empty list without touching the DB', async () => {
    const { tenant } = await seedTenantWithUsers('pro')
    expect(await resolveTenantClasses([], tenant.id)).toEqual([])
  })
})

// Linking is an authoring action, so the requester is the paper's TEACHER — the
// coaching owner cannot assign classes to a paper they did not write.
describe('linkExamToClass — tenant isolation', () => {
  it('CRITICAL: cannot link an exam to another tenant\'s class', async () => {
    const { tenant: mine, teacher } = await seedTenantWithUsers('pro')
    const { tenant: theirs, owner: theirOwner } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: mine.id, createdBy: teacher.id, visibility: 'private', status: 'draft',
    })
    const foreign = await createTestClass({ tenantId: theirs.id, teacherId: theirOwner.id })

    await expect(
      linkExamToClass(exam.id, mine.id, teacher.id, 'teacher', foreign.id),
    ).rejects.toThrow(/Class/)

    // Nothing was written — a rejected link must not leave a partial row.
    const rows = await db.select().from(examClasses).where(eq(examClasses.examId, exam.id))
    expect(rows).toHaveLength(0)
  })

  it('links a class from the same tenant', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('pro')
    const exam = await createExam({
      tenantId: tenant.id, createdBy: teacher.id, title: 'Weekly test',
      durationMins: 60, visibility: 'private',
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    const row = await linkExamToClass(exam.id, tenant.id, teacher.id, 'teacher', cls.id)
    expect(row.classId).toBe(cls.id)
  })
})
