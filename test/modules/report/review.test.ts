import { describe, it, expect } from 'vitest'
import {
  createReportForSession,
  getReportForTenant,
  listReportsForExam,
  listSessionsAwaitingReport,
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

describe('listSessionsAwaitingReport — accounting for the rest of the roster', () => {
  // The gap this closes: `listReportsForExam` selects `.from(reports)`, so a
  // session the backstop is holding is simply absent from the marks table. On a
  // 30-student exam the teacher sees 29 rows and no mention of the 30th.

  it('names a submitted student who has no report yet', async () => {
    const { tenant, teacher, exam } = await seedExamWithTwoReports()
    const priya = await createTestUser({ role: 'student', tenantId: tenant.id, name: 'Priya Rao' })
    await createTestSession({
      examId: exam.id, studentId: priya.id, tenantId: tenant.id,
      totalMarks: 10, status: 'submitted',
    })

    const rows = await listSessionsAwaitingReport(exam.id, tenant.id, teacher.id, 'teacher')

    expect(rows).toHaveLength(1)
    expect(rows[0].studentName).toBe('Priya Rao')
    expect(rows[0].studentId).toBe(priya.id)
  })

  it('CRITICAL: says nothing about WHY a student is waiting', async () => {
    // The whole point. A field that separated "still evaluating" from "held for
    // a Gyanverse operator" would tell the teacher exactly whose answer the AI
    // could not read — the failure visibility Phase 8 removed, one screen along.
    const { tenant, teacher, exam } = await seedExamWithTwoReports()
    const priya = await createTestUser({ role: 'student', tenantId: tenant.id, name: 'Priya Rao' })
    await createTestSession({
      examId: exam.id, studentId: priya.id, tenantId: tenant.id,
      totalMarks: 10, status: 'evaluated',
    })

    const rows = await listSessionsAwaitingReport(exam.id, tenant.id, teacher.id, 'teacher')

    expect(Object.keys(rows[0]).sort()).toEqual(
      ['sessionId', 'studentEmail', 'studentId', 'studentName', 'submittedAt'],
    )
  })

  it('an evaluated session and a submitted one are indistinguishable in the response', async () => {
    // Same rule from the other side: these are the two states that produce a
    // missing report, and the teacher must not be able to tell them apart.
    const { tenant, teacher, exam } = await seedExamWithTwoReports()
    for (const [name, status] of [['Ana One', 'submitted'], ['Bo Two', 'evaluated']] as const) {
      const s = await createTestUser({ role: 'student', tenantId: tenant.id, name })
      await createTestSession({
        examId: exam.id, studentId: s.id, tenantId: tenant.id, totalMarks: 10, status,
      })
    }

    const rows = await listSessionsAwaitingReport(exam.id, tenant.id, teacher.id, 'teacher')

    expect(rows.map((r) => r.studentName)).toEqual(['Ana One', 'Bo Two'])
    // Identical shape, and no value anywhere that names a state. (Asserted on
    // values, not on the serialized blob — `submittedAt` is a key, and matching
    // it would fail this for the wrong reason.)
    expect(Object.keys(rows[0])).toEqual(Object.keys(rows[1]))
    const values = rows.flatMap((r) => Object.values(r)).map(String)
    expect(values.filter((v) => /^(submitted|evaluated|needs_human|resolved)$/i.test(v))).toEqual([])
  })

  it('excludes students who already have a report', async () => {
    const { tenant, teacher, exam } = await seedExamWithTwoReports()

    const rows = await listSessionsAwaitingReport(exam.id, tenant.id, teacher.id, 'teacher')

    expect(rows).toHaveLength(0)
  })

  it('ignores in_progress and abandoned sessions', async () => {
    // Neither is a result being waited on: one is a student still writing, the
    // other will never produce a report at all. Listing them would turn this
    // into a roster of everyone who ever opened the paper.
    const { tenant, teacher, exam } = await seedExamWithTwoReports()
    for (const status of ['in_progress', 'abandoned'] as const) {
      const s = await createTestUser({ role: 'student', tenantId: tenant.id })
      await createTestSession({
        examId: exam.id, studentId: s.id, tenantId: tenant.id, totalMarks: 10, status,
      })
    }

    const rows = await listSessionsAwaitingReport(exam.id, tenant.id, teacher.id, 'teacher')

    expect(rows).toHaveLength(0)
  })

  it('CRITICAL: honours the same authorship guard as the reports list', async () => {
    const { tenant, exam } = await seedExamWithTwoReports()
    const otherTeacher = await createTestUser({ role: 'teacher', tenantId: tenant.id })

    await expect(
      listSessionsAwaitingReport(exam.id, tenant.id, otherTeacher.id, 'teacher'),
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
