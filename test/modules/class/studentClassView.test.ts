import { describe, it, expect } from 'vitest'
import { getClassesForStudent, listClassStudents } from '@modules/class/class.service.js'
import {
  seedTenantWithUsers,
  createTestUser,
  createMembership,
  createTestClass,
  enrollStudent,
  createTestExam,
  linkExamToClass,
  createTestTenant,
} from '../../helpers/fixtures.js'

/** A student wired into the tenant, optionally enrolled in a class. */
async function addStudent(
  tenantId: string,
  opts: { name?: string; classId?: string; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  const s = await createTestUser({ role: 'student', tenantId, name: opts.name })
  await createMembership({ userId: s.id, tenantId, role: 'student' })
  if (opts.classId) {
    await enrollStudent({ classId: opts.classId, studentId: s.id, status: opts.status ?? 'approved' })
  }
  return s
}

// ── The batches a student sees ──────────────────────────────────────────────

describe('getClassesForStudent', () => {
  it('returns an approved enrollment', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'approved' })

    const rows = await getClassesForStudent(student.id, tenant.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(cls.id)
    expect(rows[0].enrollmentStatus).toBe('approved')
  })

  it('returns a pending enrollment, so the student can see the request is in review', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, autoApprove: false })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'pending' })

    const rows = await getClassesForStudent(student.id, tenant.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].enrollmentStatus).toBe('pending')
  })

  it('hides a rejected enrollment', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, autoApprove: false })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'rejected' })

    expect(await getClassesForStudent(student.id, tenant.id)).toHaveLength(0)
  })

  it('never returns a batch the student has no row in', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })

    expect(await getClassesForStudent(student.id, tenant.id)).toHaveLength(0)
  })

  it('does not leak a batch from another tenant the student is somehow enrolled in', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const other = await seedTenantWithUsers()
    const foreign = await createTestClass({ tenantId: other.tenant.id, teacherId: other.teacher.id })
    await enrollStudent({ classId: foreign.id, studentId: student.id, status: 'approved' })

    const mine = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: mine.id, studentId: student.id, status: 'approved' })

    const rows = await getClassesForStudent(student.id, tenant.id)
    expect(rows.map((r) => r.id)).toEqual([mine.id])
  })

  it('attaches the batch teacher name', async () => {
    const { tenant, student } = await seedTenantWithUsers()
    const teacher = await createTestUser({ role: 'teacher', tenantId: tenant.id, name: 'Rita Bose' })
    await createMembership({ userId: teacher.id, tenantId: tenant.id, role: 'teacher' })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    const [row] = await getClassesForStudent(student.id, tenant.id)
    expect(row.teacherName).toBe('Rita Bose')
  })

  describe('studentCount', () => {
    it("counts approved classmates only, never the teacher's pending queue", async () => {
      const { tenant, teacher, student } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await enrollStudent({ classId: cls.id, studentId: student.id, status: 'approved' })
      await addStudent(tenant.id, { classId: cls.id, status: 'approved' })
      await addStudent(tenant.id, { classId: cls.id, status: 'pending' })
      await addStudent(tenant.id, { classId: cls.id, status: 'rejected' })

      const [row] = await getClassesForStudent(student.id, tenant.id)
      expect(row.studentCount).toBe(2)
    })

    it('is 1 for a student alone in a batch — they count themselves', async () => {
      const { tenant, teacher, student } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await enrollStudent({ classId: cls.id, studentId: student.id })

      const [row] = await getClassesForStudent(student.id, tenant.id)
      expect(row.studentCount).toBe(1)
    })
  })

  describe('examCount', () => {
    it('counts only exams in a state the student can see', async () => {
      const { tenant, teacher, student } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await enrollStudent({ classId: cls.id, studentId: student.id })

      for (const status of ['scheduled', 'live', 'completed'] as const) {
        const e = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status })
        await linkExamToClass(e.id, cls.id)
      }
      // Invisible to a student: still being written / reviewed / retired.
      for (const status of ['draft', 'under_review', 'approved', 'archived'] as const) {
        const e = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status })
        await linkExamToClass(e.id, cls.id)
      }

      const [row] = await getClassesForStudent(student.id, tenant.id)
      expect(row.examCount).toBe(3)
    })

    it('does not count an exam assigned to a different batch', async () => {
      const { tenant, teacher, student } = await seedTenantWithUsers()
      const mine = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      const other = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await enrollStudent({ classId: mine.id, studentId: student.id })

      const e = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'live' })
      await linkExamToClass(e.id, other.id)

      const [row] = await getClassesForStudent(student.id, tenant.id)
      expect(row.examCount).toBe(0)
    })

    it("counts an exam once even when it is assigned to two of the student's batches", async () => {
      const { tenant, teacher, student } = await seedTenantWithUsers()
      const a = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      const b = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await enrollStudent({ classId: a.id, studentId: student.id })
      await enrollStudent({ classId: b.id, studentId: student.id })

      const e = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'live' })
      await linkExamToClass(e.id, a.id)
      await linkExamToClass(e.id, b.id)

      const rows = await getClassesForStudent(student.id, tenant.id)
      expect(rows.map((r) => r.examCount)).toEqual([1, 1])
    })

    it('reports zero counts for a batch with no exams', async () => {
      const { tenant, teacher, student } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await enrollStudent({ classId: cls.id, studentId: student.id })

      const [row] = await getClassesForStudent(student.id, tenant.id)
      expect(row.examCount).toBe(0)
      expect(row.studentCount).toBe(1)
    })
  })
})

// ── The roster, and what each role is allowed to read from it ───────────────

describe('listClassStudents', () => {
  describe('as staff', () => {
    it('returns contact details', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await addStudent(tenant.id, { classId: cls.id, name: 'Asha Rao' })

      const [row] = await listClassStudents(cls.id, tenant.id, undefined, {
        role: 'teacher',
        id: teacher.id,
      })
      expect(row.name).toBe('Asha Rao')
      expect(row.email).toBeTruthy()
      expect(row).toHaveProperty('phoneNumber')
    })

    it('still sees pending rows, and still honours ?status=', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await addStudent(tenant.id, { classId: cls.id, status: 'approved' })
      await addStudent(tenant.id, { classId: cls.id, status: 'pending' })

      const all = await listClassStudents(cls.id, tenant.id, undefined, { role: 'teacher', id: teacher.id })
      expect(all).toHaveLength(2)

      const pending = await listClassStudents(cls.id, tenant.id, 'pending', { role: 'teacher', id: teacher.id })
      expect(pending).toHaveLength(1)
      expect(pending[0].status).toBe('pending')
    })

    it('is unchanged when called with no viewer at all', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await addStudent(tenant.id, { classId: cls.id, status: 'pending' })

      const rows = await listClassStudents(cls.id, tenant.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveProperty('email')
    })
  })

  describe('as an enrolled student', () => {
    it('returns classmates by name with no contact details', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      const me = await addStudent(tenant.id, { classId: cls.id, name: 'Asha Rao' })
      await addStudent(tenant.id, { classId: cls.id, name: 'Dev Kapoor' })

      const rows = await listClassStudents(cls.id, tenant.id, undefined, { role: 'student', id: me.id })
      expect(rows.map((r) => r.name).sort()).toEqual(['Asha Rao', 'Dev Kapoor'])
      for (const r of rows) {
        expect(r).not.toHaveProperty('email')
        expect(r).not.toHaveProperty('phoneNumber')
      }
    })

    it('sees approved classmates only — pending and rejected requests stay private', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      const me = await addStudent(tenant.id, { classId: cls.id, name: 'Asha Rao' })
      await addStudent(tenant.id, { classId: cls.id, name: 'Waiting Wanda', status: 'pending' })
      await addStudent(tenant.id, { classId: cls.id, name: 'Rejected Ravi', status: 'rejected' })

      const rows = await listClassStudents(cls.id, tenant.id, undefined, { role: 'student', id: me.id })
      expect(rows.map((r) => r.name)).toEqual(['Asha Rao'])
    })

    it('cannot widen its own view with ?status=pending', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      const me = await addStudent(tenant.id, { classId: cls.id, name: 'Asha Rao' })
      await addStudent(tenant.id, { classId: cls.id, name: 'Waiting Wanda', status: 'pending' })

      const rows = await listClassStudents(cls.id, tenant.id, 'pending', { role: 'student', id: me.id })
      expect(rows.map((r) => r.name)).toEqual(['Asha Rao'])
    })
  })

  describe('as a student who should not see the roster', () => {
    it('rejects a student of the same coaching who is not in the batch', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await addStudent(tenant.id, { classId: cls.id })
      const outsider = await addStudent(tenant.id)

      await expect(
        listClassStudents(cls.id, tenant.id, undefined, { role: 'student', id: outsider.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })
    })

    it('rejects a student whose own enrollment is still pending', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, autoApprove: false })
      const waiting = await addStudent(tenant.id, { classId: cls.id, status: 'pending' })

      await expect(
        listClassStudents(cls.id, tenant.id, undefined, { role: 'student', id: waiting.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })
    })

    it('rejects a student whose enrollment was rejected', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, autoApprove: false })
      const denied = await addStudent(tenant.id, { classId: cls.id, status: 'rejected' })

      await expect(
        listClassStudents(cls.id, tenant.id, undefined, { role: 'student', id: denied.id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })
    })

    it('rejects a student of another coaching, even one enrolled in this batch', async () => {
      const { tenant, teacher } = await seedTenantWithUsers()
      const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
      await addStudent(tenant.id, { classId: cls.id })

      // The tenant scope is checked first: the batch isn't in the intruder's
      // tenant, so it does not exist as far as they're concerned.
      const otherTenant = await createTestTenant()
      const intruder = await addStudent(otherTenant.id)
      await enrollStudent({ classId: cls.id, studentId: intruder.id, status: 'approved' })

      await expect(
        listClassStudents(cls.id, otherTenant.id, undefined, { role: 'student', id: intruder.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 })
    })
  })
})
