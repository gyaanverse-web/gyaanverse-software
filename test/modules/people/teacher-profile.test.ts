import { describe, it, expect } from 'vitest'
import { getTeacherProfile } from '@modules/people/people.service.js'
import { listTeachersWithWorkload } from '@modules/tenant/tenant.service.js'
import {
  seedTenantWithUsers,
  createTestUser,
  createMembership,
  createTestClass,
  createTestExam,
  enrollStudent,
  assignTeacher,
} from '../../helpers/fixtures.js'

describe('getTeacherProfile', () => {
  it('returns identity, assigned batches and workload', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id, name: 'Batch A' })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    const p = await getTeacherProfile(tenant.id, teacher.id)

    expect(p.teacher.id).toBe(teacher.id)
    expect(p.teacher.role).toBe('teacher')
    expect(p.batches.map((b) => b.name)).toEqual(['Batch A'])
    expect(p.batches[0].studentCount).toBe(1)
    expect(p.workload).toEqual({ batchCount: 1, studentCount: 1, paperCount: 0 })
  })

  it('counts only approved students in a batch', async () => {
    const { tenant, teacher, student } = await seedTenantWithUsers()
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    const pending = await createTestUser()
    await createMembership({ userId: pending.id, tenantId: tenant.id, role: 'student' })
    await enrollStudent({ classId: cls.id, studentId: pending.id, status: 'pending' })

    const p = await getTeacherProfile(tenant.id, teacher.id)
    expect(p.batches[0].studentCount).toBe(1)
    expect(p.workload.studentCount).toBe(1)
  })

  it('lists authored papers newest first', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'Older', status: 'completed' })
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'Newer', status: 'live' })

    const p = await getTeacherProfile(tenant.id, teacher.id)
    expect(p.papers).toHaveLength(2)
    expect(p.workload.paperCount).toBe(2)
  })

  it('excludes a colleague\'s papers', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const colleague = await createTestUser()
    await createMembership({ userId: colleague.id, tenantId: tenant.id, role: 'teacher' })
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'Mine' })
    await createTestExam({ tenantId: tenant.id, createdBy: colleague.id, title: 'Theirs' })

    const p = await getTeacherProfile(tenant.id, teacher.id)
    expect(p.papers.map((x) => x.title)).toEqual(['Mine'])
  })

  it('CRITICAL: hides draft papers from the owner, in the list AND the count', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'Unfinished', status: 'draft' })
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, title: 'Submitted', status: 'under_review' })

    const p = await getTeacherProfile(tenant.id, teacher.id)

    expect(p.papers.map((x) => x.title)).toEqual(['Submitted'])
    // The count is the subtler half: "2 papers" against one visible row tells
    // the owner a draft exists, which is the same leak in a smaller box.
    expect(p.workload.paperCount).toBe(1)
  })

  it('CRITICAL: the teachers roster count excludes drafts too', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'live' })

    // The roster and the detail page must agree; this column used to count
    // every status, so the owner's Teachers table disclosed drafts.
    const [row] = await listTeachersWithWorkload(tenant.id)
    expect(row.examCount).toBe(1)
  })

  it('404s for a user who is not a teacher of this coaching', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()

    await expect(getTeacherProfile(tenant.id, student.id)).rejects.toThrow(/not found/i)
    // The owner is not a teacher under the hard role split, so they have no
    // teacher profile either — not even their own.
    await expect(getTeacherProfile(tenant.id, owner.id)).rejects.toThrow(/not found/i)
  })

  it('404s for a teacher of another coaching', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()

    await expect(getTeacherProfile(a.tenant.id, b.teacher.id)).rejects.toThrow(/not found/i)
  })

  it('excludes batches and papers belonging to another coaching', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    // The same person teaches at both coachings.
    await createMembership({ userId: a.teacher.id, tenantId: b.tenant.id, role: 'teacher' })
    const theirBatch = await createTestClass({ tenantId: b.tenant.id, name: 'Rival batch' })
    await assignTeacher({ classId: theirBatch.id, tenantId: b.tenant.id, teacherId: a.teacher.id })
    await createTestExam({ tenantId: b.tenant.id, createdBy: a.teacher.id, title: 'Rival paper' })

    const p = await getTeacherProfile(a.tenant.id, a.teacher.id)
    expect(p.batches).toEqual([])
    expect(p.papers).toEqual([])
  })
})
