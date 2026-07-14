import { describe, it, expect } from 'vitest'
import { listTeachersWithWorkload } from '@modules/tenant/tenant.service.js'
import {
  seedTenantWithUsers,
  createTestTenant,
  createTestUser,
  createMembership,
  createTestClass,
  enrollStudent,
  createTestExam,
} from '../../helpers/fixtures.js'

describe('listTeachersWithWorkload', () => {
  it('returns an empty array when the tenant has no teachers', async () => {
    const owner = await createTestUser({ role: 'coaching_owner' })
    const tenant = await createTestTenant({ ownerId: owner.id })
    await createMembership({ userId: owner.id, tenantId: tenant.id, role: 'coaching_owner' })

    expect(await listTeachersWithWorkload(tenant.id)).toEqual([])
  })

  it('returns only teachers — not the owner or students', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const rows = await listTeachersWithWorkload(tenant.id)
    expect(rows.map((r) => r.userId)).toEqual([teacher.id])
  })

  it('reports zero workload for a teacher with no batches, students, or exams', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const [row] = await listTeachersWithWorkload(tenant.id)
    expect(row).toMatchObject({
      userId: teacher.id,
      classCount: 0,
      studentCount: 0,
      examCount: 0,
    })
  })

  it('counts batches, approved students, and authored exams', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const c1 = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const c2 = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    const s1 = await createTestUser({ role: 'student', tenantId: tenant.id })
    const s2 = await createTestUser({ role: 'student', tenantId: tenant.id })
    const s3 = await createTestUser({ role: 'student', tenantId: tenant.id })
    await enrollStudent({ classId: c1.id, studentId: s1.id, status: 'approved' })
    await enrollStudent({ classId: c1.id, studentId: s2.id, status: 'pending' }) // excluded
    await enrollStudent({ classId: c2.id, studentId: s3.id, status: 'approved' })

    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id })
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id })

    const [row] = await listTeachersWithWorkload(tenant.id)
    expect(row.classCount).toBe(2)
    expect(row.studentCount).toBe(2) // only the two approved students
    expect(row.examCount).toBe(2)
  })

  it('counts a student enrolled in two of the teacher\'s batches only once', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const c1 = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const c2 = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const student = await createTestUser({ role: 'student', tenantId: tenant.id })
    await enrollStudent({ classId: c1.id, studentId: student.id, status: 'approved' })
    await enrollStudent({ classId: c2.id, studentId: student.id, status: 'approved' })

    const [row] = await listTeachersWithWorkload(tenant.id)
    expect(row.classCount).toBe(2)
    expect(row.studentCount).toBe(1) // distinct student
  })

  it('does not count classes, students, or exams from other tenants', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()

    // Give tenant B's teacher some workload; tenant A's roster must ignore it.
    const bClass = await createTestClass({ tenantId: b.tenant.id, teacherId: b.teacher.id })
    const bStudent = await createTestUser({ role: 'student', tenantId: b.tenant.id })
    await enrollStudent({ classId: bClass.id, studentId: bStudent.id, status: 'approved' })
    await createTestExam({ tenantId: b.tenant.id, createdBy: b.teacher.id })

    const rowsA = await listTeachersWithWorkload(a.tenant.id)
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0]).toMatchObject({
      userId: a.teacher.id,
      classCount: 0,
      studentCount: 0,
      examCount: 0,
    })
  })

  it('lists every teacher with their own independent workload', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const teacher2 = await createTestUser({ role: 'teacher', tenantId: tenant.id })
    await createMembership({ userId: teacher2.id, tenantId: tenant.id, role: 'teacher' })

    await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await createTestExam({ tenantId: tenant.id, createdBy: teacher2.id })

    const rows = await listTeachersWithWorkload(tenant.id)
    const byId = new Map(rows.map((r) => [r.userId, r]))
    expect(byId.get(teacher.id)).toMatchObject({ classCount: 1, examCount: 0 })
    expect(byId.get(teacher2.id)).toMatchObject({ classCount: 0, examCount: 1 })
  })
})
