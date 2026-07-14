import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { classes } from '@modules/class/class.schema.js'
import { dispatch } from '@modules/notification/index.js'
import { reassignClassTeacher, getAllClasses } from '@modules/class/class.service.js'
import {
  seedTenantWithUsers,
  createTestUser,
  createMembership,
  createTestClass,
  enrollStudent,
} from '../../helpers/fixtures.js'

// A second teacher wired into the given tenant — the common reassignment target.
async function addTeacher(tenantId: string, name?: string) {
  const t = await createTestUser({ role: 'teacher', tenantId, name })
  await createMembership({ userId: t.id, tenantId, role: 'teacher' })
  return t
}

describe('reassignClassTeacher', () => {
  it('moves the batch to another teacher and persists it', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const teacher2 = await addTeacher(tenant.id)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    const updated = await reassignClassTeacher(cls.id, tenant.id, teacher2.id)
    expect(updated.teacherId).toBe(teacher2.id)

    const [row] = await db.select().from(classes).where(eq(classes.id, cls.id))
    expect(row.teacherId).toBe(teacher2.id)
  })

  it('allows reassigning to the coaching owner', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    const updated = await reassignClassTeacher(cls.id, tenant.id, owner.id)
    expect(updated.teacherId).toBe(owner.id)
  })

  it('notifies the newly assigned teacher', async () => {
    vi.mocked(dispatch).mockClear()
    const { tenant, teacher } = await seedTenantWithUsers()
    const teacher2 = await addTeacher(tenant.id)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await reassignClassTeacher(cls.id, tenant.id, teacher2.id)

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: { userIds: [teacher2.id] } }),
    )
  })

  it('is a no-op (and sends no notification) when the target is already the teacher', async () => {
    vi.mocked(dispatch).mockClear()
    const { tenant, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    const updated = await reassignClassTeacher(cls.id, tenant.id, teacher.id)
    expect(updated.teacherId).toBe(teacher.id)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects a target who is not a member of the tenant', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const outsider = await createTestUser({ role: 'teacher' }) // no membership anywhere
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await expect(
      reassignClassTeacher(cls.id, tenant.id, outsider.id),
    ).rejects.toMatchObject({ code: 'INVALID_TEACHER', statusCode: 400 })
  })

  it('rejects a target who is a student in the tenant, leaving the class unchanged', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await expect(
      reassignClassTeacher(cls.id, tenant.id, student.id),
    ).rejects.toMatchObject({ code: 'INVALID_TEACHER' })

    const [row] = await db.select().from(classes).where(eq(classes.id, cls.id))
    expect(row.teacherId).toBe(teacher.id)
  })

  it('rejects when the class does not exist in the tenant', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    await expect(
      reassignClassTeacher(crypto.randomUUID(), tenant.id, teacher.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("cannot reassign a class scoped to a different tenant", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bClass = await createTestClass({ tenantId: b.tenant.id, teacherId: b.teacher.id })

    // Passing B's class id but A's tenant id must not resolve the class.
    await expect(
      reassignClassTeacher(bClass.id, a.tenant.id, a.teacher.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const [row] = await db.select().from(classes).where(eq(classes.id, bClass.id))
    expect(row.teacherId).toBe(b.teacher.id) // untouched
  })
})

describe('getAllClasses', () => {
  it('attaches the owning teacher name to each class', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    const rows = await getAllClasses(tenant.id)
    const found = rows.find((r) => r.id === cls.id)
    expect(found?.teacherName).toBe(teacher.name)
  })

  it('reports the correct teacher per class', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const teacher2 = await addTeacher(tenant.id, 'Second Teacher')
    const c1 = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const c2 = await createTestClass({ tenantId: tenant.id, teacherId: teacher2.id })

    const rows = await getAllClasses(tenant.id)
    expect(rows.find((r) => r.id === c1.id)?.teacherName).toBe(teacher.name)
    expect(rows.find((r) => r.id === c2.id)?.teacherName).toBe('Second Teacher')
  })

  it('reflects a reassignment in the teacher name', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const teacher2 = await addTeacher(tenant.id, 'New Owner')
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await reassignClassTeacher(cls.id, tenant.id, teacher2.id)

    const rows = await getAllClasses(tenant.id)
    expect(rows.find((r) => r.id === cls.id)?.teacherName).toBe('New Owner')
  })

  it('still returns enrollment counts alongside the teacher name', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'approved' })

    const [row] = await getAllClasses(tenant.id)
    expect(row.teacherName).toBe(teacher.name)
    expect(row.studentCount).toBe(1)
    expect(row.pendingCount).toBe(0)
  })
})
