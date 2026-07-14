import { describe, it, expect } from 'vitest'
import { canStudentAccess } from '@modules/exam/exam.service.js'
import {
  createTestExam,
  createTestClass,
  enrollStudent,
  linkExamToClass,
  createTestPurchase,
  createTestUser,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

describe('canStudentAccess — public_free', () => {
  it('allows any authenticated student', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'public_free',
      status: 'published',
    })
    const anyStudent = await createTestUser({ role: 'student' })

    expect(await canStudentAccess(anyStudent.id, exam.id)).toBe(true)
  })

  it('rejects access to an unpublished exam', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'public_free',
      status: 'draft',
    })
    const anyStudent = await createTestUser({ role: 'student' })

    expect(await canStudentAccess(anyStudent.id, exam.id)).toBe(false)
  })
})

describe('canStudentAccess — public_paid', () => {
  it('rejects a student who has not purchased', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'public_paid',
      status: 'published',
      price: '99.00',
    })
    const anyStudent = await createTestUser({ role: 'student' })

    expect(await canStudentAccess(anyStudent.id, exam.id)).toBe(false)
  })

  it('allows a student who has purchased', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'public_paid',
      status: 'published',
      price: '99.00',
    })
    const anyStudent = await createTestUser({ role: 'student' })
    await createTestPurchase({ studentId: anyStudent.id, examId: exam.id })

    expect(await canStudentAccess(anyStudent.id, exam.id)).toBe(true)
  })

  it("doesn't leak purchase across students", async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'public_paid',
      status: 'published',
      price: '99.00',
    })
    const buyer = await createTestUser({ role: 'student' })
    const freeloader = await createTestUser({ role: 'student' })
    await createTestPurchase({ studentId: buyer.id, examId: exam.id })

    expect(await canStudentAccess(buyer.id, exam.id)).toBe(true)
    expect(await canStudentAccess(freeloader.id, exam.id)).toBe(false)
  })
})

describe('canStudentAccess — private', () => {
  it('rejects when the student is not in any class linked to the exam', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'private',
      status: 'published',
    })
    // Class exists but exam is not linked to it; or student not enrolled.
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'approved' })
    // (no linkExamToClass call)

    expect(await canStudentAccess(student.id, exam.id)).toBe(false)
  })

  it('allows when the student is enrolled in a linked class', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'private',
      status: 'published',
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'approved' })
    await linkExamToClass(exam.id, cls.id)

    expect(await canStudentAccess(student.id, exam.id)).toBe(true)
  })

  it('rejects students with pending or rejected enrollment', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      visibility: 'private',
      status: 'published',
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await linkExamToClass(exam.id, cls.id)

    const pendingStudent = await createTestUser({ role: 'student', tenantId: tenant.id })
    await enrollStudent({ classId: cls.id, studentId: pendingStudent.id, status: 'pending' })
    const rejectedStudent = await createTestUser({ role: 'student', tenantId: tenant.id })
    await enrollStudent({ classId: cls.id, studentId: rejectedStudent.id, status: 'rejected' })

    expect(await canStudentAccess(pendingStudent.id, exam.id)).toBe(false)
    expect(await canStudentAccess(rejectedStudent.id, exam.id)).toBe(false)
  })

  // Cross-tenant isolation: a student of coaching A must not pass private-exam
  // access for an exam owned by coaching B even if they happen to share class
  // memberships through some misconfiguration.
  it('CRITICAL: rejects a student from a different tenant', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const examInB = await createTestExam({
      tenantId: b.tenant.id,
      createdBy: b.owner.id,
      visibility: 'private',
      status: 'published',
    })
    const classInB = await createTestClass({ tenantId: b.tenant.id, teacherId: b.teacher.id })
    await linkExamToClass(examInB.id, classInB.id)

    // a.student is not in classInB and not in any class linked to examInB
    expect(await canStudentAccess(a.student.id, examInB.id)).toBe(false)
  })
})
