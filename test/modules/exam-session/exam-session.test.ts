import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examSessions, sessionAnswers } from '@modules/exam-session/exam-session.schema.js'
import { exams } from '@modules/exam/exam.schema.js'
import {
  startSession,
  saveAnswer,
  submitSession,
} from '@modules/exam-session/exam-session.service.js'
import {
  createTestExam,
  createTestQuestion,
  createTestSession,
  createTestClass,
  linkExamToClass,
  enrollStudent,
  createTestUser,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// ── startSession ────────────────────────────────────────────────────────────

describe('startSession', () => {
  it('happy path: creates an in_progress session with attempt #1', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'published',
      durationMins: 60, totalMarks: 100, maxAttempts: 2,
    })
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    await linkExamToClass(exam.id, cls.id)

    const session = await startSession(student.id, exam.id, tenant.id)
    expect(session.status).toBe('in_progress')
    expect(session.attemptNumber).toBe(1)
    expect(session.totalMarks).toBe(100)
    expect(session.examId).toBe(exam.id)
    expect(session.studentId).toBe(student.id)
    // expiresAt is roughly now + 60min
    const expectedExpiry = Date.now() + 60 * 60 * 1000
    expect(session.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000)
    expect(session.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000)
  })

  it('rejects unpublished exams', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, status: 'draft',
    })
    await expect(startSession(student.id, exam.id, tenant.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('rejects an exam that has not started yet (scheduledAt in future)', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'published',
    })
    // Patch scheduledAt to future
    await db.update(exams).set({ scheduledAt: future }).where(eq(exams.id, exam.id))

    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    await linkExamToClass(exam.id, cls.id)

    await expect(startSession(student.id, exam.id, tenant.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('rejects an exam that has ended (endsAt in past)', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()
    const past = new Date(Date.now() - 60 * 60 * 1000)
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'published',
    })
    await db.update(exams).set({ endsAt: past }).where(eq(exams.id, exam.id))

    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })
    await linkExamToClass(exam.id, cls.id)

    await expect(startSession(student.id, exam.id, tenant.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('CRITICAL: rejects a student who is not enrolled in any linked class (private exam)', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'private', status: 'published',
    })
    // student is in the tenant but NOT in any class linked to the exam
    await expect(startSession(student.id, exam.id, tenant.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('enforces maxAttempts', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'published',
      maxAttempts: 2,
    })

    // attempt 1
    await startSession(student.id, exam.id, tenant.id)
    // mark as submitted so the "active session" guard doesn't trigger
    await db
      .update(examSessions)
      .set({ status: 'submitted' })
      .where(eq(examSessions.studentId, student.id))

    // attempt 2
    await startSession(student.id, exam.id, tenant.id)
    await db
      .update(examSessions)
      .set({ status: 'submitted' })
      .where(eq(examSessions.studentId, student.id))

    // attempt 3 — should be rejected
    await expect(startSession(student.id, exam.id, tenant.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('rejects when an in-progress session already exists', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, visibility: 'public_free', status: 'published',
      maxAttempts: 5,
    })
    await startSession(student.id, exam.id, tenant.id)

    // Second concurrent start — should conflict
    await expect(startSession(student.id, exam.id, tenant.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})

// ── saveAnswer ──────────────────────────────────────────────────────────────

describe('saveAnswer', () => {
  it('upserts an answer (re-saving replaces previous)', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const q = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'subjective',
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })

    await saveAnswer(session.id, student.id, q.id, { text: 'first attempt' })
    await saveAnswer(session.id, student.id, q.id, { text: 'second attempt' })

    const rows = await db
      .select()
      .from(sessionAnswers)
      .where(eq(sessionAnswers.sessionId, session.id))
    expect(rows).toHaveLength(1)
    expect((rows[0].answer as { text: string }).text).toBe('second attempt')
  })

  it('CRITICAL: rejects saves from a different student', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const q = await createTestQuestion({ examId: exam.id, tenantId: tenant.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })
    const attacker = await createTestUser({ role: 'student' })

    await expect(
      saveAnswer(session.id, attacker.id, q.id, { text: 'hax' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' }) // service queries by (sessionId, studentId), so it's NOT_FOUND not FORBIDDEN
  })

  it('rejects saves on a submitted session', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const q = await createTestQuestion({ examId: exam.id, tenantId: tenant.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted',
    })

    await expect(
      saveAnswer(session.id, student.id, q.id, { text: 'too late' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

// ── submitSession ───────────────────────────────────────────────────────────

describe('submitSession', () => {
  it('auto-scores MCQ questions correctly', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, totalMarks: 10,
    })
    const q = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'mcq_single', marks: 10,
      payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      answerKey: { optionId: 'a' },
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
      totalMarks: 10,
    })

    // Correct answer
    await saveAnswer(session.id, student.id, q.id, { optionId: 'a' })
    const after = await submitSession(session.id, student.id)

    expect(after.status).toBe('evaluated')
    expect(after.autoScore).toBe(10)
    expect(after.manualScore).toBeNull() // no subjective questions

    // The answer should now be flagged correct
    const [savedAnswer] = await db
      .select()
      .from(sessionAnswers)
      .where(eq(sessionAnswers.sessionId, session.id))
    expect(savedAnswer.isCorrect).toBe(true)
    expect(savedAnswer.awardedMarks).toBe(10)
  })

  it('counts wrong MCQ answer as 0 marks', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, totalMarks: 10,
    })
    const q = await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'mcq_single', marks: 10,
      payload: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      answerKey: { optionId: 'a' },
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
      totalMarks: 10,
    })

    await saveAnswer(session.id, student.id, q.id, { optionId: 'b' })
    const after = await submitSession(session.id, student.id)
    expect(after.autoScore).toBe(0)

    const [savedAnswer] = await db
      .select()
      .from(sessionAnswers)
      .where(eq(sessionAnswers.sessionId, session.id))
    expect(savedAnswer.isCorrect).toBe(false)
  })

  it('rejects submit on an already-submitted session', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'submitted',
    })

    await expect(submitSession(session.id, student.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('CRITICAL: a different student cannot submit the session', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
    })
    const attacker = await createTestUser({ role: 'student' })

    await expect(submitSession(session.id, attacker.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('enqueues evaluation when the exam has subjective questions', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    const exam = await createTestExam({
      tenantId: tenant.id, createdBy: owner.id, totalMarks: 20,
    })
    await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'mcq_single', marks: 10, order: 1,
      payload: { options: [{ id: 'a', text: 'A' }] },
      answerKey: { optionId: 'a' },
    })
    await createTestQuestion({
      examId: exam.id, tenantId: tenant.id, type: 'subjective', marks: 10, order: 2,
    })
    const session = await createTestSession({
      examId: exam.id, studentId: student.id, tenantId: tenant.id, status: 'in_progress',
      totalMarks: 20,
    })

    const after = await submitSession(session.id, student.id)
    expect(after.status).toBe('submitted')

    // Evaluation job got created via enqueueEvaluation
    const { evaluationJobs } = await import('@modules/evaluation/evaluation.schema.js')
    const jobs = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.sessionId, session.id))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('pending')
  })
})
