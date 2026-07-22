import { eq, and, count, desc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { examSessions, sessionAnswers } from './exam-session.schema.js'
import { exams, questions } from '../exam/exam.schema.js'
import { canStudentAccess, assertResultsVisible } from '../exam/exam.service.js'
import { enqueueEvaluation } from '../evaluation/evaluation.service.js'
import { gradeQuestion, isObjectiveType } from './exam-session.grader.js'
import { validateStudentAnswer } from '../exam/exam.validators.js'
import { createReportForSession } from '@modules/report/report.service.js'
import { refreshSuccessRates } from '../question-bank/index.js'

// ── Start session ──────────────────────────────────────────────────────────

export async function startSession(
  studentId: string,
  examId: string,
  tenantId: string | null,
) {
  const [exam] = await db.select().from(exams).where(eq(exams.id, examId)).limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (exam.status !== 'live')
    throw new AppError('VALIDATION', 'This exam is not currently available', 422)

  // Scheduled window check
  const now = new Date()
  if (exam.scheduledAt && now < exam.scheduledAt)
    throw new AppError('VALIDATION', 'This exam has not started yet', 422)
  if (exam.endsAt && now > exam.endsAt)
    throw new AppError('VALIDATION', 'This exam has ended', 422)

  const hasAccess = await canStudentAccess(studentId, examId)
  if (!hasAccess)
    throw new AppError('FORBIDDEN', 'You do not have access to this exam', 403)

  // Count existing non-abandoned attempts
  const [{ value: attemptCount }] = await db
    .select({ value: count() })
    .from(examSessions)
    .where(
      and(
        eq(examSessions.examId, examId),
        eq(examSessions.studentId, studentId),
      ),
    )

  if (attemptCount >= exam.maxAttempts)
    throw new AppError('VALIDATION', `You have used all ${exam.maxAttempts} attempt(s) for this exam`, 422)

  // Check no active in-progress session
  const [activeSession] = await db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(
      and(
        eq(examSessions.examId, examId),
        eq(examSessions.studentId, studentId),
        eq(examSessions.status, 'in_progress'),
      ),
    )
    .limit(1)
  if (activeSession)
    throw new AppError('CONFLICT', 'You already have an active session for this exam', 409)

  const expiresAt = new Date(now.getTime() + exam.durationMins * 60 * 1000)
  const attemptNumber = attemptCount + 1

  const [session] = await db
    .insert(examSessions)
    .values({
      examId,
      studentId,
      tenantId,
      attemptNumber,
      status: 'in_progress',
      startedAt: now,
      expiresAt,
      totalMarks: exam.totalMarks,
    })
    .returning()

  return session
}

// ── Save answer ────────────────────────────────────────────────────────────

export async function saveAnswer(
  sessionId: string,
  studentId: string,
  questionId: string,
  answer: Record<string, unknown> | null,
  imageUrl?: string,
) {
  const [session] = await db
    .select()
    .from(examSessions)
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId)))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')
  if (session.status !== 'in_progress')
    throw new AppError('VALIDATION', 'Session is not active', 422)
  if (new Date() > session.expiresAt)
    throw new AppError('VALIDATION', 'Session has expired', 422)

  // Verify question belongs to this exam
  const [question] = await db
    .select({ id: questions.id, type: questions.type })
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.examId, session.examId)))
    .limit(1)
  if (!question) throw Errors.NOT_FOUND('Question')

  // Validate answer shape if provided
  if (answer !== null) {
    const validation = validateStudentAnswer(question.type, answer)
    if ('error' in validation) throw new AppError('VALIDATION_ERROR', validation.error, 422)
  }

  // Upsert
  const existing = await db
    .select({ id: sessionAnswers.id })
    .from(sessionAnswers)
    .where(and(eq(sessionAnswers.sessionId, sessionId), eq(sessionAnswers.questionId, questionId)))
    .limit(1)

  if (existing.length > 0) {
    const [updated] = await db
      .update(sessionAnswers)
      .set({ answer, imageUrl: imageUrl ?? null, isCorrect: null, awardedMarks: null, updatedAt: new Date() })
      .where(eq(sessionAnswers.id, existing[0].id))
      .returning()
    return updated
  }

  const [inserted] = await db
    .insert(sessionAnswers)
    .values({
      sessionId,
      questionId,
      answer,
      imageUrl: imageUrl ?? null,
    })
    .returning()

  return inserted
}

// ── Submit session ─────────────────────────────────────────────────────────

export async function submitSession(sessionId: string, studentId: string) {
  const [session] = await db
    .select()
    .from(examSessions)
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId)))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')
  if (session.status !== 'in_progress')
    throw new AppError('VALIDATION', 'Session is already submitted', 422)

  return finalizeSession(session)
}

/**
 * Grade + finalize an already-loaded, confirmed-`in_progress` session. Shared by
 * the student submit path and the admin force-submit / end-exam controls so all
 * three routes run identical scoring, report, and analytics logic.
 */
async function finalizeSession(session: typeof examSessions.$inferSelect) {
  const sessionId = session.id

  // Load questions and answers
  const examQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.examId, session.examId))

  const answers = await db
    .select()
    .from(sessionAnswers)
    .where(eq(sessionAnswers.sessionId, sessionId))

  const answerByQuestionId = new Map(answers.map((a) => [a.questionId, a]))

  let autoScore = 0
  let hasSubjective = false
  const answerUpdates: Array<{
    id: string
    isCorrect: boolean
    awardedMarks: number
  }> = []

  for (const q of examQuestions) {
    const savedAnswer = answerByQuestionId.get(q.id)

    if (!isObjectiveType(q.type)) {
      hasSubjective = true
      continue
    }

    const result = gradeQuestion(
      q.type,
      q.answerKey as Record<string, unknown>,
      savedAnswer?.answer ?? null,
      q.marks,
      q.negativeMarks,
    )

    autoScore += result.awardedMarks

    if (savedAnswer) {
      answerUpdates.push({
        id: savedAnswer.id,
        isCorrect: result.isCorrect,
        awardedMarks: result.awardedMarks,
      })
    }
  }

  await db.transaction(async (tx) => {
    for (const upd of answerUpdates) {
      await tx
        .update(sessionAnswers)
        .set({ isCorrect: upd.isCorrect, awardedMarks: upd.awardedMarks, updatedAt: new Date() })
        .where(eq(sessionAnswers.id, upd.id))
    }

    await tx
      .update(examSessions)
      .set({
        status: hasSubjective ? 'submitted' : 'evaluated',
        submittedAt: new Date(),
        autoScore,
      })
      .where(eq(examSessions.id, sessionId))
  })

  if (hasSubjective) {
    await enqueueEvaluation(sessionId)
  } else {
    // No subjective questions — score is final, publish report + notify student
    await createReportForSession(sessionId)
  }

  // Update bank analytics from the objective answers just graded (best-effort).
  const gradedBankIds = examQuestions
    .filter((q) => isObjectiveType(q.type) && q.bankQuestionId)
    .map((q) => q.bankQuestionId as string)
  try {
    await refreshSuccessRates(gradedBankIds)
  } catch (err) {
    console.error('[exam-session] refreshSuccessRates failed:', err)
  }

  const [updated] = await db
    .select()
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)

  return updated
}

// ── Admin / system force-submit ──────────────────────────────────────────────

/**
 * Force-submit a single session regardless of its owner. Idempotent: a session
 * that is not `in_progress` is returned unchanged. Used by admin live controls
 * and by end-exam.
 */
export async function forceSubmitSession(sessionId: string) {
  const [session] = await db
    .select()
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')
  if (session.status !== 'in_progress') return session
  return finalizeSession(session)
}

/**
 * Force-submit every still-active (`in_progress`) session for an exam. Called
 * when an admin ends an exam early so no attempt is left ungraded.
 */
export async function forceSubmitActiveSessions(examId: string) {
  const active = await db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.examId, examId), eq(examSessions.status, 'in_progress')))

  for (const s of active) {
    await forceSubmitSession(s.id)
  }
  return { submitted: active.length }
}

// ── Get session / results ──────────────────────────────────────────────────

export async function getSession(sessionId: string, studentId: string) {
  const [session] = await db
    .select()
    .from(examSessions)
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId)))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')

  const answers = await db
    .select()
    .from(sessionAnswers)
    .where(eq(sessionAnswers.sessionId, sessionId))

  return { ...session, answers }
}

export async function getResults(sessionId: string, studentId: string) {
  const [session] = await db
    .select()
    .from(examSessions)
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId)))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')
  if (session.status === 'in_progress')
    throw new AppError('VALIDATION', 'Session has not been submitted yet', 422)

  // Scores stay hidden for private exams until the teacher publishes results.
  await assertResultsVisible(session.examId)

  const answers = await db
    .select()
    .from(sessionAnswers)
    .where(eq(sessionAnswers.sessionId, sessionId))

  return { ...session, answers }
}

// ── Teacher-facing ─────────────────────────────────────────────────────────

export async function listSessionsForExam(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const [exam] = await db
    .select({ id: exams.id, createdBy: exams.createdBy })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (requesterRole !== 'coaching_owner' && exam.createdBy !== requesterId)
    throw new AppError('FORBIDDEN', 'You can only view sessions for exams you created', 403)

  return db
    .select()
    .from(examSessions)
    .where(eq(examSessions.examId, examId))
    .orderBy(desc(examSessions.startedAt))
}
