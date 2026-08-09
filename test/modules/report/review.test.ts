import { describe, it, expect } from 'vitest'
import {
  createReportForSession,
  getReportForTenant,
  listReportsForExam,
} from '@modules/report/report.service.js'
import {
  seedTenantWithUsers,
  createTestExam,
  createTestQuestion,
  createTestSession,
  createTestUser,
} from '../../helpers/fixtures.js'

/**
 * The teacher's pre-publish review surface reads these two functions. What it
 * needs beyond the raw rows is the student's identity — a marks list keyed by
 * UUID is unusable — so that is what these tests pin down.
 */

async function seedExamWithTwoReports() {
  const { tenant, owner, teacher, student } = await seedTenantWithUsers()
  const exam = await createTestExam({
    tenantId: tenant.id, createdBy: teacher.id, totalMarks: 10, status: 'ready_to_publish',
  })
  await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })

  // Deliberately inserted Z-then-A so a name sort is distinguishable from
  // insertion order.
  const zoya = await createTestUser({ role: 'student', tenantId: tenant.id, name: 'Zoya Khan' })
  const aarav = await createTestUser({ role: 'student', tenantId: tenant.id, name: 'Aarav Mehta' })

  for (const [s, score] of [[zoya, 4], [aarav, 9]] as const) {
    const session = await createTestSession({
      examId: exam.id, studentId: s.id, tenantId: tenant.id,
      totalMarks: 10, autoScore: score, status: 'evaluated',
    })
    await createReportForSession(session.id)
  }

  return { tenant, owner, teacher, student, exam, zoya, aarav }
}

describe('listReportsForExam — teacher review list', () => {
  it('returns every report with the student\'s name and email, ordered by name', async () => {
    const { tenant, teacher, exam, aarav, zoya } = await seedExamWithTwoReports()

    const rows = await listReportsForExam(exam.id, tenant.id, teacher.id, 'teacher')

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.studentName)).toEqual(['Aarav Mehta', 'Zoya Khan'])
    expect(rows[0].studentId).toBe(aarav.id)
    expect(rows[0].studentEmail).toBe(aarav.email)
    expect(rows[0].totalScore).toBe(9)
    expect(rows[1].studentId).toBe(zoya.id)
    expect(rows[1].totalScore).toBe(4)
    expect(rows[0].maxScore).toBe(10)
  })

  it('lets the coaching owner read reports for an exam they did not author', async () => {
    const { tenant, owner, exam } = await seedExamWithTwoReports()

    const rows = await listReportsForExam(exam.id, tenant.id, owner.id, 'coaching_owner')
    expect(rows).toHaveLength(2)
  })

  it('CRITICAL: a teacher cannot read reports for another teacher\'s exam', async () => {
    const { tenant, exam } = await seedExamWithTwoReports()
    const otherTeacher = await createTestUser({ role: 'teacher', tenantId: tenant.id })

    await expect(
      listReportsForExam(exam.id, tenant.id, otherTeacher.id, 'teacher'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })
  })
})

describe('getReportForTenant — review drill-down', () => {
  it('includes the student identity alongside the per-question items', async () => {
    const { tenant, teacher, exam, aarav } = await seedExamWithTwoReports()
    const rows = await listReportsForExam(exam.id, tenant.id, teacher.id, 'teacher')
    const aaravRow = rows.find((r) => r.studentId === aarav.id)!

    const detail = await getReportForTenant(aaravRow.id, tenant.id)

    expect(detail.studentName).toBe('Aarav Mehta')
    expect(detail.studentEmail).toBe(aarav.email)
    expect(detail.items).toHaveLength(1)
    expect(detail.items[0].maxScore).toBe(10)
  })
})
