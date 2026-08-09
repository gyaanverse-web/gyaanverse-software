import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { and, desc, eq, sql } from 'drizzle-orm'
import { env } from '@config/env.js'
import { db } from '@shared/db.js'
import { AppError, Errors } from '@shared/errors.js'
import { evaluationJobs, questionResults } from './evaluation.schema.js'
import { examSessions, sessionAnswers } from '@modules/exam-session/exam-session.schema.js'
import { exams, questions } from '@modules/exam/exam.schema.js'
import { assertWithinLimit } from '@modules/billing/billing.service.js'
import { createReportForSession } from '@modules/report/report.service.js'
import { assertResultsVisible } from '@modules/exam/exam.service.js'
import { buildOcrFriendlyUrl } from '@modules/storage/index.js'
import {
  evaluateSteps,
  indexDocuments as engineIndexDocuments,
  ocrImage,
} from './evaluation.engine.js'
import type {
  AiFeedbackPayload,
  EngineEvaluatedStep,
  EngineIndexDocument,
  EvaluationJobPayload,
  EvaluationJobStatus,
} from './evaluation.types.js'

// ── Queue ─────────────────────────────────────────────────────────────────

let _queue: Queue | null = null

export function getEvaluationQueue(): Queue<EvaluationJobPayload> {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
    _queue = new Queue<EvaluationJobPayload>('evaluation', { connection })
  }
  return _queue
}

// ── Enqueue ───────────────────────────────────────────────────────────────

/**
 * Called by exam-session.submitSession after a submission that has subjective
 * questions. Resolves tenant from the exam, checks plan quota, creates a job
 * row, then enqueues. Soft-fails on quota exhaustion so the submit flow never
 * aborts post-write.
 */
export async function enqueueEvaluation(sessionId: string): Promise<{ jobId: string } | null> {
  const [session] = await db
    .select({ id: examSessions.id, examId: examSessions.examId })
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)
  if (!session) return null

  const [exam] = await db
    .select({ tenantId: exams.tenantId })
    .from(exams)
    .where(eq(exams.id, session.examId))
    .limit(1)
  if (!exam) return null

  try {
    await assertWithinLimit(exam.tenantId, 'ai_evaluations')
  } catch (err) {
    console.warn(
      `[evaluation] tenant=${exam.tenantId} session=${sessionId} skipped: ${(err as Error).message}`,
    )
    return null
  }

  const [job] = await db
    .insert(evaluationJobs)
    .values({
      sessionId,
      tenantId: exam.tenantId,
      status: 'pending',
    })
    .returning({ id: evaluationJobs.id })

  await getEvaluationQueue().add(
    'evaluate-session',
    { jobId: job.id, sessionId, tenantId: exam.tenantId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  )

  return { jobId: job.id }
}

// ── Worker entry ──────────────────────────────────────────────────────────

/**
 * Worker handler. Runs the full AI pipeline:
 *   1. mark job processing
 *   2. for each subjective question with a student image, OCR → evaluate
 *   3. write question_results rows + roll up manualScore on the session
 *   4. mark session evaluated, job completed
 *   5. notify student
 */
export async function processJob(payload: EvaluationJobPayload): Promise<void> {
  const { jobId, sessionId } = payload

  await db
    .update(evaluationJobs)
    .set({ status: 'processing', startedAt: new Date() })
    .where(eq(evaluationJobs.id, jobId))

  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, sessionId))
      .limit(1)
    if (!session) throw new AppError('NOT_FOUND', `Session ${sessionId} not found`, 404)

    const [exam] = await db
      .select({ id: exams.id, subjectId: exams.subjectId })
      .from(exams)
      .where(eq(exams.id, session.examId))
      .limit(1)
    if (!exam) throw new AppError('NOT_FOUND', `Exam ${session.examId} not found`, 404)

    const subjective = await db
      .select({
        questionId: questions.id,
        body: questions.body,
        marks: questions.marks,
        type: questions.type,
        answerImageUrl: sessionAnswers.imageUrl,
      })
      .from(questions)
      .leftJoin(
        sessionAnswers,
        and(
          eq(sessionAnswers.questionId, questions.id),
          eq(sessionAnswers.sessionId, sessionId),
        ),
      )
      .where(and(eq(questions.examId, session.examId), eq(questions.type, 'subjective')))

    const collectionName =
      exam.subjectId ? `subject_${exam.subjectId}` : env.EVAL_DEFAULT_COLLECTION || undefined

    let aiTotal = 0

    for (const q of subjective) {
      if (!q.answerImageUrl) continue

      const ocrUrl = buildOcrFriendlyUrl(q.answerImageUrl)
      const ocr = await ocrImage(ocrUrl)
      if (ocr.length === 0) {
        await db.insert(questionResults).values({
          jobId,
          questionId: q.questionId,
          score: 0,
          maxScore: q.marks,
          aiFeedback: JSON.stringify({ error: 'OCR returned no steps' }),
          imageUrl: q.answerImageUrl,
        })
        continue
      }

      const evaluation = await evaluateSteps({
        ocrData: ocr,
        question: q.body,
        collectionName,
      })

      const score = scoreFromSteps(evaluation.response, q.marks)
      const feedback = buildFeedbackPayload(evaluation.response)
      aiTotal += score

      await db.insert(questionResults).values({
        jobId,
        questionId: q.questionId,
        score,
        maxScore: q.marks,
        aiFeedback: JSON.stringify(feedback),
        imageUrl: q.answerImageUrl,
      })
    }

    await db.transaction(async (tx) => {
      await tx
        .update(examSessions)
        .set({ status: 'evaluated', manualScore: aiTotal })
        .where(eq(examSessions.id, sessionId))

      await tx
        .update(evaluationJobs)
        .set({ status: 'completed', completedAt: new Date(), error: null })
        .where(eq(evaluationJobs.id, jobId))
    })

    // Publish report + notify student (idempotent — safe if report already exists)
    await createReportForSession(sessionId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(evaluationJobs)
      .set({ status: 'failed', completedAt: new Date(), error: message })
      .where(eq(evaluationJobs.id, jobId))
    throw err
  }
}

// ── Scoring helpers ───────────────────────────────────────────────────────

function scoreFromSteps(steps: EngineEvaluatedStep[], maxMarks: number): number {
  const totalWeight = steps.reduce((sum, s) => sum + (s.step_weight ?? 0), 0)
  if (totalWeight <= 0) return 0

  const rightWeight = steps
    .filter((s) => s.step_status === 'right')
    .reduce((sum, s) => sum + (s.step_weight ?? 0), 0)

  return Math.round((rightWeight / totalWeight) * maxMarks)
}

function buildFeedbackPayload(steps: EngineEvaluatedStep[]): AiFeedbackPayload {
  const summary = steps.reduce(
    (acc, s) => {
      acc.totalSteps += 1
      acc.totalWeight += s.step_weight ?? 0
      if (s.step_status === 'right') {
        acc.rightSteps += 1
        acc.rightWeight += s.step_weight ?? 0
      } else if (s.step_status === 'wrong') acc.wrongSteps += 1
      else if (s.step_status === 'incomplete') acc.incompleteSteps += 1
      else if (s.step_status === 'unknown') acc.unknownSteps += 1
      return acc
    },
    {
      totalSteps: 0,
      rightSteps: 0,
      wrongSteps: 0,
      incompleteSteps: 0,
      unknownSteps: 0,
      rightWeight: 0,
      totalWeight: 0,
    },
  )

  const topics = Array.from(
    new Set(steps.map((s) => s.topic).filter((t): t is string => Boolean(t))),
  )

  return { steps, topics, summary }
}

// ── Read APIs ─────────────────────────────────────────────────────────────

export async function getJobStatus(sessionId: string) {
  const [job] = await db
    .select()
    .from(evaluationJobs)
    .where(eq(evaluationJobs.sessionId, sessionId))
    .orderBy(desc(evaluationJobs.createdAt))
    .limit(1)
  return job ?? null
}

export async function getJobForTenant(jobId: string, tenantId: string) {
  const [job] = await db
    .select()
    .from(evaluationJobs)
    .where(and(eq(evaluationJobs.id, jobId), eq(evaluationJobs.tenantId, tenantId)))
    .limit(1)
  if (!job) throw Errors.NOT_FOUND('Evaluation job')

  const results = await db
    .select()
    .from(questionResults)
    .where(eq(questionResults.jobId, jobId))

  return {
    ...job,
    results: results.map((r) => ({
      ...r,
      aiFeedback: r.aiFeedback ? safeParseFeedback(r.aiFeedback) : null,
    })),
  }
}

export async function getSessionEvaluation(sessionId: string, studentId: string) {
  const [session] = await db
    .select({ id: examSessions.id, studentId: examSessions.studentId, examId: examSessions.examId })
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)
  if (!session) throw Errors.NOT_FOUND('Session')
  if (session.studentId !== studentId) throw Errors.FORBIDDEN()

  // Hide AI feedback/scores for private exams until results are published.
  await assertResultsVisible(session.examId)

  const job = await getJobStatus(sessionId)
  if (!job) return null

  const results = await db
    .select()
    .from(questionResults)
    .where(eq(questionResults.jobId, job.id))

  return {
    status: job.status as EvaluationJobStatus,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    results: results.map((r) => ({
      questionId: r.questionId,
      score: r.score,
      maxScore: r.maxScore,
      aiFeedback: r.aiFeedback ? safeParseFeedback(r.aiFeedback) : null,
    })),
  }
}

// ── Exam-level progress ───────────────────────────────────────────────────

/**
 * Per-exam evaluation progress, for the teacher's Under Evaluation view.
 *
 * This exists because the lifecycle stalls silently otherwise. An exam only
 * leaves `under_evaluation` when EVERY session is settled, so a single session
 * whose AI evaluation crashed keeps the whole exam out of the teacher's
 * "Ready to Publish" bucket — and without this read there is no screen anywhere
 * that would show them why, or even that anything is wrong. Surfacing
 * "13 of 15 evaluated, 1 failed" plus a retry turns an invisible stall into
 * something the teacher can clear themselves.
 */
export async function getExamEvaluationProgress(examId: string, tenantId: string) {
  const [exam] = await db
    .select({ id: exams.id, status: exams.status })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      inProgress: sql<number>`count(*) filter (where ${examSessions.status} = 'in_progress')::int`,
      awaitingEvaluation: sql<number>`count(*) filter (where ${examSessions.status} = 'submitted')::int`,
      evaluated: sql<number>`count(*) filter (where ${examSessions.status} = 'evaluated')::int`,
      abandoned: sql<number>`count(*) filter (where ${examSessions.status} = 'abandoned')::int`,
    })
    .from(examSessions)
    .where(eq(examSessions.examId, examId))

  // Only the latest job per session matters — a retried session has older rows.
  const failed = await db
    .selectDistinctOn([evaluationJobs.sessionId], {
      jobId: evaluationJobs.id,
      sessionId: evaluationJobs.sessionId,
      status: evaluationJobs.status,
      error: evaluationJobs.error,
      completedAt: evaluationJobs.completedAt,
    })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(and(eq(examSessions.examId, examId), eq(evaluationJobs.tenantId, tenantId)))
    .orderBy(evaluationJobs.sessionId, desc(evaluationJobs.createdAt))

  const failedJobs = failed.filter((j) => j.status === 'failed')

  return {
    examId,
    status: exam.status,
    sessions: counts,
    // `pending` mirrors exactly what the lifecycle worker blocks on, so the
    // number the teacher sees is the number holding the exam back.
    pending: counts.inProgress + counts.awaitingEvaluation,
    failedJobs,
  }
}

// ── Retry ─────────────────────────────────────────────────────────────────

/**
 * Re-enqueue every failed evaluation job for an exam. The bulk companion to
 * `retryJob` — a failing engine usually takes out several sessions at once, and
 * clearing them one at a time is busywork.
 */
export async function retryFailedEvaluationsForExam(examId: string, tenantId: string) {
  const { failedJobs } = await getExamEvaluationProgress(examId, tenantId)

  const retried: string[] = []
  for (const job of failedJobs) {
    try {
      await retryJob(job.jobId, tenantId)
      retried.push(job.jobId)
    } catch (err) {
      console.error(`[evaluation] retry failed for job ${job.jobId}:`, err)
    }
  }

  return { requested: failedJobs.length, retried: retried.length, jobIds: retried }
}

export async function retryJob(jobId: string, tenantId: string) {
  const [job] = await db
    .select()
    .from(evaluationJobs)
    .where(and(eq(evaluationJobs.id, jobId), eq(evaluationJobs.tenantId, tenantId)))
    .limit(1)
  if (!job) throw Errors.NOT_FOUND('Evaluation job')
  if (job.status === 'processing')
    throw new AppError('CONFLICT', 'Job is already running', 409)

  await db.delete(questionResults).where(eq(questionResults.jobId, jobId))
  await db
    .update(evaluationJobs)
    .set({ status: 'pending', error: null, startedAt: null, completedAt: null })
    .where(eq(evaluationJobs.id, jobId))

  await getEvaluationQueue().add(
    'evaluate-session',
    { jobId, sessionId: job.sessionId, tenantId: job.tenantId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  )

  return { jobId, status: 'pending' as EvaluationJobStatus }
}

// ── Syllabus indexing ─────────────────────────────────────────────────────

export async function indexSyllabus(params: {
  documents: EngineIndexDocument[]
  collectionName?: string
}) {
  if (!params.documents || params.documents.length === 0)
    throw Errors.VALIDATION('documents must be a non-empty list')
  return engineIndexDocuments(params)
}

// ── Internal ──────────────────────────────────────────────────────────────

function safeParseFeedback(raw: string): AiFeedbackPayload | { error: string } | string {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
