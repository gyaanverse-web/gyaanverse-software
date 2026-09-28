import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { classTeachers } from '@modules/class/class.schema.js'
import { dispatch } from '@modules/notification/index.js'
import {
  createClass,
  setClassTeachers,
  getAllClasses,
  getClassesForTeacher,
  getClassForViewer,
  listClassStudents,
  deleteClass,
  useClassJoinCode,
  generateClassJoinCode,
} from '@modules/class/class.service.js'
import { removeMember } from '@modules/tenant/tenant.service.js'
import {
  seedTenantWithUsers,
  createTestUser,
  createMembership,
  createTestClass,
  enrollStudent,
} from '../../helpers/fixtures.js'

// Another teacher wired into the given tenant.
async function addTeacher(tenantId: string, name?: string) {
  const t = await createTestUser({ name })
  await createMembership({ userId: t.id, tenantId, role: 'teacher' })
  return t
}

async function assignedIds(classId: string) {
  const rows = await db.select().from(classTeachers).where(eq(classTeachers.classId, classId))
  return rows.map((r) => r.teacherId).sort()
}

describe('createClass', () => {
  it('creates a class with no teachers', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const cls = await createClass({ tenantId: tenant.id, createdBy: owner.id, name: 'Batch A' })
    expect(cls.teachers).toEqual([])
    expect(await assignedIds(cls.id)).toEqual([])
  })

  it('assigns the given teachers and notifies them', async () => {
    vi.mocked(dispatch).mockClear()
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const teacher2 = await addTeacher(tenant.id)

    const cls = await createClass({
      tenantId: tenant.id,
      createdBy: owner.id,
      name: 'Batch A',
      teacherIds: [teacher.id, teacher2.id],
    })
    expect(await assignedIds(cls.id)).toEqual([teacher.id, teacher2.id].sort())
    expect(cls.teachers.map((t) => t.id).sort()).toEqual([teacher.id, teacher2.id].sort())
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: { userIds: expect.arrayContaining([teacher.id, teacher2.id]) } }),
    )
  })

  it('rejects a non-teacher in teacherIds and creates nothing', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    await expect(
      createClass({ tenantId: tenant.id, createdBy: owner.id, name: 'Batch A', teacherIds: [student.id] }),
    ).rejects.toMatchObject({ code: 'INVALID_TEACHER' })
    expect(await getAllClasses(tenant.id)).toEqual([])
  })
})

describe('setClassTeachers', () => {
  it('replaces the list: adds new, removes dropped, keeps the rest', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const t2 = await addTeacher(tenant.id)
    const t3 = await addTeacher(tenant.id)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await setClassTeachers(cls.id, tenant.id, owner.id, [teacher.id, t2.id])
    expect(await assignedIds(cls.id)).toEqual([teacher.id, t2.id].sort())

    const updated = await setClassTeachers(cls.id, tenant.id, owner.id, [t2.id, t3.id])
    expect(await assignedIds(cls.id)).toEqual([t2.id, t3.id].sort())
    expect(updated.teachers.map((t) => t.id).sort()).toEqual([t2.id, t3.id].sort())
  })

  it('an empty list unassigns everyone', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await setClassTeachers(cls.id, tenant.id, owner.id, [])
    expect(await assignedIds(cls.id)).toEqual([])
  })

  it('notifies only the newly added teachers', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const t2 = await addTeacher(tenant.id)
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    vi.mocked(dispatch).mockClear()
    await setClassTeachers(cls.id, tenant.id, owner.id, [teacher.id, t2.id])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ recipients: { userIds: [t2.id] } }))
  })

  it('sends nothing when the list is unchanged', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    vi.mocked(dispatch).mockClear()
    await setClassTeachers(cls.id, tenant.id, owner.id, [teacher.id])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects the coaching owner — the owner never teaches a batch', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id })
    await expect(setClassTeachers(cls.id, tenant.id, owner.id, [owner.id]))
      .rejects.toMatchObject({ code: 'INVALID_TEACHER', statusCode: 400 })
  })

  it('rejects a student and an outsider, leaving the list unchanged', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const outsider = await createTestUser()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await expect(setClassTeachers(cls.id, tenant.id, owner.id, [student.id]))
      .rejects.toMatchObject({ code: 'INVALID_TEACHER' })
    await expect(setClassTeachers(cls.id, tenant.id, owner.id, [teacher.id, outsider.id]))
      .rejects.toMatchObject({ code: 'INVALID_TEACHER' })
    expect(await assignedIds(cls.id)).toEqual([teacher.id])
  })

  it("rejects another tenant's teacher", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: a.tenant.id })
    await expect(setClassTeachers(cls.id, a.tenant.id, a.owner.id, [b.teacher.id]))
      .rejects.toMatchObject({ code: 'INVALID_TEACHER' })
  })

  it("cannot touch a class scoped to a different tenant", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bClass = await createTestClass({ tenantId: b.tenant.id, teacherId: b.teacher.id })
    await expect(setClassTeachers(bClass.id, a.tenant.id, a.owner.id, [a.teacher.id]))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await assignedIds(bClass.id)).toEqual([b.teacher.id])
  })
})

describe('getAllClasses (owner)', () => {
  it('lists every class with its teachers and enrollment counts', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const t2 = await addTeacher(tenant.id, 'Second Teacher')
    const c1 = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    const c2 = await createTestClass({ tenantId: tenant.id }) // no teacher yet
    await db.insert(classTeachers).values({ classId: c1.id, teacherId: t2.id, tenantId: tenant.id, assignedBy: t2.id })
    await enrollStudent({ classId: c1.id, studentId: student.id, status: 'approved' })

    const rows = await getAllClasses(tenant.id)
    const r1 = rows.find((r) => r.id === c1.id)!
    expect(r1.teachers.map((t) => t.name).sort()).toEqual([teacher.name, 'Second Teacher'].sort())
    expect(r1.studentCount).toBe(1)
    expect(rows.find((r) => r.id === c2.id)!.teachers).toEqual([])
  })
})

describe('getClassesForTeacher (My Classes)', () => {
  it('returns only the classes the teacher is assigned to', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const t2 = await addTeacher(tenant.id)
    const mine = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await createTestClass({ tenantId: tenant.id, teacherId: t2.id })
    await createTestClass({ tenantId: tenant.id })

    const rows = await getClassesForTeacher(teacher.id, tenant.id)
    expect(rows.map((r) => r.id)).toEqual([mine.id])
  })

  it('a shared class shows up for every assigned teacher', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const t2 = await addTeacher(tenant.id)
    const cls = await createTestClass({ tenantId: tenant.id })
    await setClassTeachers(cls.id, tenant.id, owner.id, [teacher.id, t2.id])

    expect((await getClassesForTeacher(teacher.id, tenant.id)).map((r) => r.id)).toEqual([cls.id])
    expect((await getClassesForTeacher(t2.id, tenant.id)).map((r) => r.id)).toEqual([cls.id])
  })
})

describe('teacher read access', () => {
  it('an assigned teacher can read the class and its full roster', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    const viewer = { role: 'teacher', id: teacher.id }

    expect((await getClassForViewer(cls.id, tenant.id, viewer)).id).toBe(cls.id)
    const roster = await listClassStudents(cls.id, tenant.id, undefined, viewer)
    expect(roster[0]).toHaveProperty('email')
  })

  it('an unassigned teacher gets 404 on the class and its roster', async () => {
    const { tenant } = await seedTenantWithUsers()
    const other = await addTeacher(tenant.id)
    const cls = await createTestClass({ tenantId: tenant.id })
    const viewer = { role: 'teacher', id: other.id }

    await expect(getClassForViewer(cls.id, tenant.id, viewer)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(listClassStudents(cls.id, tenant.id, undefined, viewer)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('assignment cleanup', () => {
  it('removing a teacher from the coaching drops their class assignments', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    await removeMember(tenant.id, teacher.id, owner.id)
    expect(await assignedIds(cls.id)).toEqual([])
  })

  it('deleting a class drops its assignments', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await deleteClass(cls.id, tenant.id)
    expect(await assignedIds(cls.id)).toEqual([])
  })
})

describe('enrollment notifications', () => {
  it('a join request notifies the owner, not the assigned teachers', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, autoApprove: false })
    const code = await generateClassJoinCode(cls.id, tenant.id, owner.id)

    vi.mocked(dispatch).mockClear()
    await useClassJoinCode(student.id, code.code)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ recipients: { userIds: [owner.id] } }))
  })
})
