import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { createReportForSession, getReportForStudent, getReportForTenant } from '@modules/report/report.service.js'
import { reports, reportItems } from '@modules/report/report.schema.js'
import {
  seedTenantWithUsers,
  createTestExam,
  createTestQuestion,
  createTestSession,
  createSessionAnswer,
  createEvaluationJob,
  createQuestionResult,
  createTestUser,
} from '../../helpers/fixtures.js'

describe('createReportForSession — happy path', () => {
  it('publishes a report combining objective + AI scores', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id,
      createdBy: owner.id,
      totalMarks: 30,
    })
    const objQ = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, order: 1, type: 'mcq_single', marks: 10,
    })
    const subjQ = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, order: 2, type: 'subjective', marks: 20,
    })

    const session = await createTestSession({
      examId: exam.id,
      studentId: student.id,
      tenantId: tenant.id,
      totalMarks: 30,
      autoScore: 10,        // got the MCQ right
      manualScore: 15,      // AI gave 15/20 on the subjective
      status: 'evaluated',
    })

    // Mark the objective question as correct in session_answers
    await createSessionAnswer({
      sessionId: session.id, questionId: objQ.id,
      answer: { optionId: 'a' }, isCorrect: true, awardedMarks: 10,
    })
    await createSessionAnswer({
      sessionId: session.id, questionId: subjQ.id,
      imageUrl: 'https://res.cloudinary.com/test/image/upload/v1/x.jpg',
    })

    // The AI worker would have written these
    const job = await createEvaluationJob({ sessionId: session.id, tenantId: tenant.id })
    await createQuestionResult({
      jobId: job.id, questionId: subjQ.id,
      score: 15, maxScore: 20,
      imageUrl: 'https://res.cloudinary.com/test/image/upload/v1/x.jpg',
      aiFeedback: JSON.stringify({ steps: [], topics: ['Kinematics'], summary: { totalSteps: 0 } }),
    })

    const { reportId, created } = await createReportForSession(session.id)
    expect(created).toBe(true)

    const fetched = await getReportForStudent(session.id, student.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(reportId)
    expect(fetched!.totalScore).toBe(25)   // 10 (auto) + 15 (ai)
    expect(fetched!.maxScore).toBe(30)
    expect(fetched!.autoScore).toBe(10)
    expect(fetched!.aiScore).toBe(15)
    expect(fetched!.status).toBe('ready')
    expect(fetched!.publishedAt).not.toBeNull()

    // One row per question
    expect(fetched!.items).toHaveLength(2)

    const objItem = fetched!.items.find((i) => i.questionId === objQ.id)
    expect(objItem).toBeDefined()
    expect(objItem!.score).toBe(10)
    expect(objItem!.maxScore).toBe(10)
    expect(objItem!.feedback).toBeNull()
    expect(objItem!.imageUrl).toBeNull()

    const subjItem = fetched!.items.find((i) => i.questionId === subjQ.id)
    expect(subjItem).toBeDefined()
    expect(subjItem!.score).toBe(15)
    expect(subjItem!.maxScore).toBe(20)
    expect(subjItem!.feedback).toContain('Kinematics')
    expect(subjItem!.imageUrl).toContain('cloudinary')
  })

  it('dispatches a result_ready notification to the student', async () => {
    // report.service.ts imports dispatch from `@modules/notification/index.js`
    // — must grab the spy from the same path so we share the mocked module.
    const { dispatch } = await import('@modules/notification/index.js')
    const mockedDispatch = vi.mocked(dispatch)
    mockedDispatch.mockClear()

    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, totalMarks: 10 })
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id,
      totalMarks: 10, autoScore: 10, status: 'evaluated',
    })

    await createReportForSession(session.id)

    expect(mockedDispatch).toHaveBeenCalledOnce()
    const call = mockedDispatch.mock.calls[0][0]
    expect(call.type).toBe('result_ready')
    expect((call.recipients as { userIds: string[] }).userIds).toContain(student.id)
    expect(call.data.body).toContain('10 out of 10')
  })
})

describe('createReportForSession — idempotency', () => {
  it('returns the existing report on a second call without inserting duplicates', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, totalMarks: 10 })
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id,
      totalMarks: 10, autoScore: 7, status: 'evaluated',
    })

    const first = await createReportForSession(session.id)
    const second = await createReportForSession(session.id)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.reportId).toBe(first.reportId)

    const allReports = await db.select().from(reports).where(eq(reports.sessionId, session.id))
    expect(allReports).toHaveLength(1)
  })
})

describe('createReportForSession — tenant isolation', () => {
  it('CRITICAL: a teacher in tenant B cannot read a report from tenant A', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()

    const examInA = await createTestExam({ tenantId: a.tenant.id, createdBy: a.owner.id })
    await createTestQuestion({ examId: examInA.id, tenantId: a.tenant.id })
    const session = await createTestSession({
      examId: examInA.id, studentId: a.student.id, tenantId: a.tenant.id,
      autoScore: 50, status: 'evaluated',
    })
    const { reportId } = await createReportForSession(session.id)

    // Teacher in tenant B tries to fetch a report scoped to tenant A
    await expect(getReportForTenant(reportId, b.tenant.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    })

    // And the owner of A can read it fine
    const reportFromA = await getReportForTenant(reportId, a.tenant.id)
    expect(reportFromA.id).toBe(reportId)
  })

  it('a student cannot read another student\'s report', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, totalMarks: 10 })
    await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id,
      totalMarks: 10, autoScore: 10, status: 'evaluated',
    })
    await createReportForSession(session.id)

    const otherStudent = await createTestUser({ role: 'student', tenantId: tenant.id })
    const stolen = await getReportForStudent(session.id, otherStudent.id)
    expect(stolen).toBeNull()
  })
})

describe('createReportForSession — edge cases', () => {
  it('handles a session with no AI evaluation (objective-only)', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, totalMarks: 10 })
    const q = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'mcq_single', marks: 10,
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id,
      totalMarks: 10, autoScore: 10, status: 'evaluated',
    })
    await createSessionAnswer({
      sessionId: session.id, questionId: q.id,
      answer: { optionId: 'a' }, isCorrect: true, awardedMarks: 10,
    })

    const { reportId } = await createReportForSession(session.id)
    const fetched = await getReportForStudent(session.id, student.id)

    expect(fetched!.totalScore).toBe(10)
    expect(fetched!.aiScore).toBe(0)
    expect(fetched!.autoScore).toBe(10)
    expect(fetched!.items).toHaveLength(1)
    expect(fetched!.items[0].score).toBe(10)
    expect(fetched!.items[0].feedback).toBeNull()

    // No leftover unmatched report rows from earlier tests
    const items = await db.select().from(reportItems).where(eq(reportItems.reportId, reportId))
    expect(items).toHaveLength(1)
  })

  it('handles a session where the student skipped some questions', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id, totalMarks: 20 })
    const q1 = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'mcq_single', marks: 10, order: 1,
    })
    const q2 = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'mcq_single', marks: 10, order: 2,
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id,
      totalMarks: 20, autoScore: 10, status: 'evaluated',
    })
    await createSessionAnswer({
      sessionId: session.id, questionId: q1.id,
      answer: { optionId: 'a' }, isCorrect: true, awardedMarks: 10,
    })
    // q2 never answered

    await createReportForSession(session.id)
    const fetched = await getReportForStudent(session.id, student.id)

    expect(fetched!.items).toHaveLength(2)
    const q1Item = fetched!.items.find((i) => i.questionId === q1.id)
    const q2Item = fetched!.items.find((i) => i.questionId === q2.id)
    expect(q1Item!.score).toBe(10)
    expect(q2Item!.score).toBe(0)   // missing answer → 0
  })
})
