import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { exams } from '@modules/exam/exam.schema.js'
import { assertResultsVisible } from '@modules/exam/exam.service.js'
import { getResults } from '@modules/exam-session/exam-session.service.js'
import {
  createReportForSession, getReportForStudent, listReportsForStudent,
} from '@modules/report/report.service.js'
import {
  seedTenantWithUsers, createTestExam, createTestQuestion,
  createTestSession, createSessionAnswer,
} from '../../helpers/fixtures.js'
import type { ExamStatus } from '@modules/exam/exam.types.js'

// Results-visibility gate: a PRIVATE (coaching) exam hides scores/reports until
// the teacher publishes results, which is the `completed` status — publishing is
// what finishes the lifecycle. PUBLIC (self-paced) exams are exempt and show
// results as soon as they are evaluated.

describe('assertResultsVisible', () => {
  async function examWith(visibility: 'private' | 'public_free', status: ExamStatus) {
    const { tenant, owner } = await seedTenantWithUsers('pro')
    return createTestExam({ tenantId: tenant.id, createdBy: owner.id, visibility, status })
  }

  it('blocks a private exam that has not published results (under_evaluation)', async () => {
    const exam = await examWith('private', 'under_evaluation')
    await expect(assertResultsVisible(exam.id)).rejects.toThrow(/have not been published yet/)
  })

  // The whole point of `ready_to_publish`: the marks exist and the teacher can
  // see them, but nothing has been released to students yet.
  it('blocks a private exam that is evaluated but not yet published (ready_to_publish)', async () => {
    const exam = await examWith('private', 'ready_to_publish')
    await expect(assertResultsVisible(exam.id)).rejects.toThrow(/have not been published yet/)
  })

  it('allows a private exam once results are published (completed)', async () => {
    const exam = await examWith('private', 'completed')
    await expect(assertResultsVisible(exam.id)).resolves.toBeUndefined()
  })

  it('exempts a public exam even before results are published', async () => {
    const exam = await examWith('public_free', 'under_evaluation')
    await expect(assertResultsVisible(exam.id)).resolves.toBeUndefined()
  })
})

describe('getResults — student score read', () => {
  it('hides a private exam\'s results until published', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'under_evaluation',
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted',
    })

    await expect(getResults(session.id, student.id)).rejects.toThrow(/have not been published yet/)
  })

  it('reveals a private exam\'s results once published', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'completed',
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'evaluated',
    })

    const res = await getResults(session.id, student.id)
    expect(res.id).toBe(session.id)
    expect(Array.isArray(res.answers)).toBe(true)
  })

  it('shows a public exam\'s results as soon as it is evaluated', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'under_evaluation',
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'evaluated',
    })

    const res = await getResults(session.id, student.id)
    expect(res.id).toBe(session.id)
  })

  it('still rejects an in-progress session before reaching the visibility gate', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    // Even a public, visible exam must reject reads of an unsubmitted session.
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'live',
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })

    await expect(getResults(session.id, student.id)).rejects.toThrow(/has not been submitted yet/)
  })
})

describe('getReportForStudent — report read', () => {
  async function reportForPrivateExam(status: ExamStatus) {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status, totalMarks: 10,
    })
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
    await createReportForSession(session.id)
    return { exam, session, student }
  }

  it('hides the report while the exam is still under evaluation', async () => {
    const { session, student } = await reportForPrivateExam('under_evaluation')
    await expect(getReportForStudent(session.id, student.id)).rejects.toThrow(/have not been published yet/)
  })

  it('reveals the report once results are published', async () => {
    const { exam, session, student } = await reportForPrivateExam('under_evaluation')
    // Teacher publishes results, which completes the exam.
    await db.update(exams).set({ status: 'completed' }).where(eq(exams.id, exam.id))

    const report = await getReportForStudent(session.id, student.id)
    expect(report).not.toBeNull()
    expect(report!.totalScore).toBe(10)
  })
})

describe('listReportsForStudent — list visibility', () => {
  it('lists only published/completed private reports (plus public), never in-flight ones', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers('pro')

    async function reportFor(visibility: 'private' | 'public_free', status: ExamStatus) {
      const exam = await createTestExam({
        tenantId: tenant.id, createdBy: owner.id, visibility, status, totalMarks: 10,
      })
      await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
      const session = await createTestSession({
        examId: exam.id, studentId: student.id, tenantId: tenant.id,
        totalMarks: 10, autoScore: 10, status: 'evaluated',
      })
      await createReportForSession(session.id)
      return exam
    }

    const hiddenPrivate = await reportFor('private', 'under_evaluation') // in-flight → hidden
    const shownPrivate = await reportFor('private', 'completed')         // published → shown
    const publicExam = await reportFor('public_free', 'under_evaluation') // public → always shown

    const list = await listReportsForStudent(student.id)
    const examIds = new Set(list.map((r) => r.examId))

    expect(examIds.has(shownPrivate.id)).toBe(true)
    expect(examIds.has(publicExam.id)).toBe(true)
    expect(examIds.has(hiddenPrivate.id)).toBe(false)
  })
})
