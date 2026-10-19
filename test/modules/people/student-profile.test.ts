import { describe, it, expect } from 'vitest'
import {
  getStudentProfile,
  listStudents,
  sharesBatchWith,
} from '@modules/people/people.service.js'
import {
  seedTenantWithUsers,
  createTestUser,
  createMembership,
  createTestClass,
  createTestExam,
  createTestSession,
  enrollStudent,
  assignTeacher,
} from '../../helpers/fixtures.js'

const asOwner = (id: string) => ({ id, role: 'coaching_owner' as const })
const asTeacher = (id: string) => ({ id, role: 'teacher' as const })

describe('getStudentProfile — owner', () => {
  it('returns identity, batches and attempts', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, name: 'Batch A' })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'Unit 1' })
    await createTestSession({ examId: exam.id, studentId: student.id, tenantId: tenant.id })

    const p = await getStudentProfile(tenant.id, student.id, asOwner(owner.id))

    expect(p.scope).toBe('owner')
    expect(p.student.id).toBe(student.id)
    // `joinedAt` is the MEMBERSHIP date, not the account's — a student who
    // signed up last year and joined this coaching today reads as "today".
    expect(p.student.joinedAt).toBeInstanceOf(Date)
    expect(p.batches.map((b) => b.name)).toEqual(['Batch A'])
    expect(p.batches[0].teachers.map((t) => t.id)).toEqual([teacher.id])
    expect(p.attempts).toHaveLength(1)
    expect(p.attempts[0].examTitle).toBe('Unit 1')
    expect(p.activity.attempted).toBe(1)
  })

  it('returns one row per attempt, not per exam', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, maxAttempts: 2 })
    await createTestSession({ examId: exam.id, studentId: student.id, tenantId: tenant.id, attemptNumber: 1 })
    await createTestSession({ examId: exam.id, studentId: student.id, tenantId: tenant.id, attemptNumber: 2 })

    const p = await getStudentProfile(tenant.id, student.id, asOwner(owner.id))
    expect(p.attempts).toHaveLength(2)
    expect(p.attempts.map((a) => a.attemptNumber).sort()).toEqual([1, 2])
    expect(p.activity.attempted).toBe(2)
  })

  it('sees every batch, including ones no teacher is assigned to', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const orphan = await createTestClass({ tenantId: tenant.id, name: 'Unassigned' })
    await enrollStudent({ classId: orphan.id, studentId: student.id })

    const p = await getStudentProfile(tenant.id, student.id, asOwner(owner.id))
    expect(p.batches.map((b) => b.name)).toEqual(['Unassigned'])
    expect(p.batches[0].teachers).toEqual([])
  })

  it('reports a pending enrollment as pending rather than hiding it', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, autoApprove: false })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'pending' })

    const p = await getStudentProfile(tenant.id, student.id, asOwner(owner.id))
    expect(p.batches[0].status).toBe('pending')
  })
})

describe('getStudentProfile — tenant isolation', () => {
  it('404s for a student who belongs to another coaching', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()

    await expect(
      getStudentProfile(a.tenant.id, b.student.id, asOwner(a.owner.id)),
    ).rejects.toThrow(/not found/i)
  })

  it('404s for an id that is a member but not a student', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()

    // The teachers route is the surface for a teacher. Resolving one here would
    // make the student page a generic user-viewer that bypasses the owner-only
    // guard on teacher detail.
    await expect(
      getStudentProfile(tenant.id, teacher.id, asOwner(owner.id)),
    ).rejects.toThrow(/not found/i)
  })

  it('excludes attempts at another coaching\'s exam', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    // Same human studies at both coachings.
    await createMembership({ userId: a.student.id, tenantId: b.tenant.id, role: 'student' })

    const theirExam = await createTestExam({ tenantId: b.tenant.id, createdBy: b.teacher.id, title: 'Rival paper' })
    await createTestSession({ examId: theirExam.id, studentId: a.student.id, tenantId: b.tenant.id })

    const p = await getStudentProfile(a.tenant.id, a.student.id, asOwner(a.owner.id))
    expect(p.attempts).toHaveLength(0)
  })

  it('excludes a batch of the same name from another coaching', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    await createMembership({ userId: a.student.id, tenantId: b.tenant.id, role: 'student' })
    const theirs = await createTestClass({ tenantId: b.tenant.id, name: 'Batch A' })
    await enrollStudent({ classId: theirs.id, studentId: a.student.id })

    const p = await getStudentProfile(a.tenant.id, a.student.id, asOwner(a.owner.id))
    expect(p.batches).toEqual([])
  })
})

describe('getStudentProfile — teacher scope', () => {
  it('404s when the teacher shares no batch with the student', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()

    // 404 and not 403: a 403 would confirm this student is enrolled here, which
    // is a roster leak to a teacher who is not meant to know.
    await expect(
      getStudentProfile(tenant.id, student.id, asTeacher(teacher.id)),
    ).rejects.toThrow(/not found/i)
  })

  it('404s when the shared enrollment is only pending', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id, status: 'pending' })

    // Otherwise a student could grant themselves visibility to any teacher just
    // by requesting their batch.
    await expect(
      getStudentProfile(tenant.id, student.id, asTeacher(teacher.id)),
    ).rejects.toThrow(/not found/i)
    expect(await sharesBatchWith(tenant.id, teacher.id, student.id)).toBe(false)
  })

  it('omits the fees and guardians keys entirely', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    const p = await getStudentProfile(tenant.id, student.id, asTeacher(teacher.id))

    expect(p.scope).toBe('teacher')
    // Absent, not null. A client that forgets to branch on `scope` cannot read
    // a money field that was never serialised.
    expect('fees' in p).toBe(false)
    expect('guardians' in p).toBe(false)
  })

  it('shows only batches the teacher is assigned to', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const mine = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, name: 'Mine' })
    const theirs = await createTestClass({ tenantId: tenant.id, name: 'Someone else\'s' })
    await enrollStudent({ classId: mine.id, studentId: student.id })
    await enrollStudent({ classId: theirs.id, studentId: student.id })

    const p = await getStudentProfile(tenant.id, student.id, asTeacher(teacher.id))
    expect(p.batches.map((b) => b.name)).toEqual(['Mine'])
  })

  it('shows only attempts at papers this teacher authored', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    const colleague = await createTestUser()
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })

    const mine = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'My paper' })
    const theirs = await createTestExam({ tenantId: tenant.id, createdBy: colleague.id, title: 'Their paper' })
    await createTestSession({ examId: mine.id, studentId: student.id, tenantId: tenant.id })
    await createTestSession({ examId: theirs.id, studentId: student.id, tenantId: tenant.id })

    const p = await getStudentProfile(tenant.id, student.id, asTeacher(teacher.id))
    expect(p.attempts.map((a) => a.examTitle)).toEqual(['My paper'])
    // The summary is computed over the attempts actually returned, so it cannot
    // disclose a colleague's paper by arithmetic.
    expect(p.activity.attempted).toBe(1)
  })
})

describe('listStudents', () => {
  it('lists every student for the owner with batch and attempt rollups', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, name: 'Batch A' })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: teacher.id })
    await createTestSession({ examId: exam.id, studentId: student.id, tenantId: tenant.id })

    const other = await createTestUser()
    await createMembership({ userId: other.id, tenantId: tenant.id, role: 'student' })

    const rows = await listStudents(tenant.id, asOwner(owner.id))
    expect(rows).toHaveLength(2)

    const enrolled = rows.find((r) => r.id === student.id)!
    expect(enrolled.batchCount).toBe(1)
    expect(enrolled.batchNames).toEqual(['Batch A'])
    expect(enrolled.attemptCount).toBe(1)
    expect(enrolled.lastActiveAt).not.toBeNull()

    const idle = rows.find((r) => r.id === other.id)!
    expect(idle.batchCount).toBe(0)
    expect(idle.attemptCount).toBe(0)
    expect(idle.lastActiveAt).toBeNull()
  })

  it('gives a teacher only students approved in their own batches', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const mine = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: mine.id, studentId: student.id })

    const pendingStudent = await createTestUser()
    await createMembership({ userId: pendingStudent.id, tenantId: tenant.id, role: 'student' })
    await enrollStudent({ classId: mine.id, studentId: pendingStudent.id, status: 'pending' })

    const elsewhere = await createTestUser()
    await createMembership({ userId: elsewhere.id, tenantId: tenant.id, role: 'student' })
    const theirs = await createTestClass({ tenantId: tenant.id })
    await enrollStudent({ classId: theirs.id, studentId: elsewhere.id })

    const rows = await listStudents(tenant.id, asTeacher(teacher.id))
    expect(rows.map((r) => r.id)).toEqual([student.id])
  })

  it('never carries an outstanding figure for a teacher', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    const [row] = await listStudents(tenant.id, asTeacher(teacher.id))
    // null means "not shown", never "owes nothing" — so the column can be
    // dropped client-side rather than rendered as a confident ₹0.
    expect(row.outstanding).toBeNull()
  })

  it('counts a batch once for a teacher assigned alongside another', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, name: 'Shared' })
    const colleague = await createTestUser()
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })
    await assignTeacher({ classId: cls.id, tenantId: tenant.id, teacherId: colleague.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    const [row] = await listStudents(tenant.id, asTeacher(teacher.id))
    // The `exists` subquery must not multiply the row per assigned teacher.
    expect(row.batchCount).toBe(1)
    expect(row.batchNames).toEqual(['Shared'])
  })

  it('does not leak students from another coaching', async () => {
    const a = await seedTenantWithUsers()
    await seedTenantWithUsers()

    const rows = await listStudents(a.tenant.id, asOwner(a.owner.id))
    expect(rows.map((r) => r.id)).toEqual([a.student.id])
  })
})
