import { and, asc, count, eq, sql } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { AppError, Errors } from '@shared/errors.js'
import { evaluationJobs, questionResults } from './evaluation.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { exams, questions } from '@modules/exam/exam.schema.js'
import { tenants } from '@modules/tenant/tenant.schema.js'
import { users } from '@modules/auth/auth.schema.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN REVIEW QUEUE — where a person finishes what the AI could not.
//
// WHAT THIS FILE IS
// The backstop parks unreadable answers by writing `question_results.review_status
// = 'needs_human'`. This file is everything that happens to them afterwards:
//   • count them (that count is what blocks the publish button)
//   • list them for an operator to work through
//   • summarise them ("is this one bad photo, or is the engine down?")
//   • let an operator type in the correct score
//
// WHO USES IT: Gyanverse staff only. Never the coaching's teacher or owner.
//
// WHY NOT THE TEACHER? A "fix the score the AI couldn't produce" button cannot
// exist without telling the teacher the AI failed — which is exactly the thing
// the client asked us to hide. Moving that button to Gyanverse staff keeps the
// promise on the coaching's side of the wall, and puts the work with the only
// people who can act on a systemic problem (e.g. "all four coachings are failing
// on the same OCR error"). Client decision, 2026-08-12.
//
// So: these functions work ACROSS tenants, they require the `super_admin` role,
// and their routes live under `/internal/*`, never under `/tenant/*`.
//
// ONE STRUCTURAL RULE — THIS FILE MUST STAY A "LEAF"
// It may import the database and the table definitions, and nothing else from
// other modules. Reason: `exam.service` imports `countOpenReviewsForExam` from
// here for its publish gate. If this file imported `report.service` (which
// imports `exam.service`), the imports would form a circle and the app would
// fail to start. That is why rebuilding a student's report after an override is
// done by the ROUTE, as a second call, rather than inside `overrideQuestionResult`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many answers in this exam are still waiting for a Gyanverse operator.
 *
 * THIS IS THE PUBLISH GATE. Any number above 0 means at least one student's mark
 * on this paper is still the backstop's placeholder 0. If the teacher were
 * allowed to publish now, that 0 would go out as a real result.
 *
 * It counts `needs_human` only, never `resolved`. Once an operator has typed in
 * a score the answer is `resolved`, and a human's score is every bit as final as
 * the AI's — so it must not keep the exam locked.
 */
export async function countOpenReviewsForExam(examId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(and(eq(examSessions.examId, examId), eq(questionResults.reviewStatus, 'needs_human')))
  return row?.n ?? 0
}

export interface ReviewQueueItem {
  resultId: string
  jobId: string
  sessionId: string
  questionId: string
  examId: string
  examTitle: string
  tenantId: string
  tenantName: string
  studentName: string
  questionBody: string
  maxScore: number
  imageUrl: string
  /** Why the AI gave up on this one — OCR_EMPTY, ENGINE_TIMEOUT, and so on. */
  lastErrorCode: string | null
  attempts: number
  flaggedAt: Date | null
  waitingSince: Date
}

/**
 * The review queue itself: every answer the backstop parked, oldest first.
 *
 * It spans ALL coachings on purpose. This is Gyanverse's own to-do list, and
 * splitting it per coaching would hide the most useful thing it shows — that one
 * particular coaching's uploads are all failing for the same reason (bad scanner
 * settings, for example).
 *
 * The `tenantId` / `examId` options narrow it down when an operator is chasing a
 * specific complaint.
 */
export async function listReviewQueue(
  opts: { tenantId?: string; examId?: string; limit?: number; offset?: number } = {},
): Promise<{ items: ReviewQueueItem[]; total: number }> {
  const where = and(
    eq(questionResults.reviewStatus, 'needs_human'),
    opts.tenantId ? eq(evaluationJobs.tenantId, opts.tenantId) : undefined,
    opts.examId ? eq(examSessions.examId, opts.examId) : undefined,
  )

  const items = await db
    .select({
      resultId: questionResults.id,
      jobId: questionResults.jobId,
      sessionId: evaluationJobs.sessionId,
      questionId: questionResults.questionId,
      examId: examSessions.examId,
      examTitle: exams.title,
      tenantId: evaluationJobs.tenantId,
      tenantName: tenants.name,
      studentName: users.name,
      questionBody: questions.body,
      maxScore: questionResults.maxScore,
      imageUrl: questionResults.imageUrl,
      lastErrorCode: evaluationJobs.lastErrorCode,
      attempts: evaluationJobs.attempts,
      flaggedAt: evaluationJobs.settledAt,
      waitingSince: evaluationJobs.createdAt,
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(tenants, eq(tenants.id, evaluationJobs.tenantId))
    .innerJoin(users, eq(users.id, examSessions.studentId))
    .innerJoin(questions, eq(questions.id, questionResults.questionId))
    .where(where)
    // Oldest first. Every row here is a student waiting for a mark, and the fair
    // way to clear a queue of people is the order they joined it.
    .orderBy(asc(evaluationJobs.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)

  const [totalRow] = await db
    .select({ n: count() })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(where)

  return { items, total: totalRow?.n ?? 0 }
}

/**
 * The same queue as counts instead of rows, so an operator can tell at a glance
 * what kind of problem they are looking at.
 *
 * Example: 40 open, all with `lastErrorCode = 'ENGINE_TIMEOUT'` and spread over
 * six coachings → the engine had an outage. 2 open, both `OCR_EMPTY` and both
 * from the same coaching → two genuinely bad photos.
 */
export async function getReviewQueueSummary() {
  const byCode = await db
    .select({
      lastErrorCode: evaluationJobs.lastErrorCode,
      n: count(),
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .where(eq(questionResults.reviewStatus, 'needs_human'))
    .groupBy(evaluationJobs.lastErrorCode)

  const byTenant = await db
    .select({
      tenantId: evaluationJobs.tenantId,
      tenantName: tenants.name,
      n: count(),
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(tenants, eq(tenants.id, evaluationJobs.tenantId))
    .where(eq(questionResults.reviewStatus, 'needs_human'))
    .groupBy(evaluationJobs.tenantId, tenants.name)
    .orderBy(sql`count(*) desc`)

  const [open] = await db
    .select({ n: count() })
    .from(questionResults)
    .where(eq(questionResults.reviewStatus, 'needs_human'))

  return { open: open?.n ?? 0, byCode, byTenant }
}

export interface OverrideResult {
  resultId: string
  sessionId: string
  examId: string
  tenantId: string
  score: number
  aiScore: number | null
  /** The session's new subjective total, after this correction. */
  sessionScore: number
  /** How many answers on this exam are STILL waiting for a person after this one. */
  remainingForExam: number
  /**
   * True when this correction was the last one THIS PAPER was waiting for, so the
   * job row moved to `completed`. False while other answers on the same paper are
   * still flagged — and also false if a worker had already moved the row off
   * `failed` on its own, which needs nothing from us.
   */
  jobClosed: boolean
}

/**
 * An operator types in the correct score for one flagged answer.
 *
 * IT ONLY WORKS ON `needs_human` ROWS, on purpose. This is a repair tool for
 * answers the AI could not read — not a general "edit any score" button.
 * Gyanverse staff quietly rewriting a grade the AI produced correctly, for a
 * coaching that never asked, would be a completely different and much worse
 * product.
 *
 * HOW THE WRITE IS SHAPED so nothing downstream has to know an override
 * happened:
 *   • `question_results.score`    — stays the one real, effective mark that
 *                                   reports, totals and analytics already read
 *   • `question_results.ai_score` — keeps whatever the AI had produced, so the
 *                                   evidence of the miss is not destroyed
 *   • `review_status`             — becomes `resolved`, which releases the
 *                                   publish gate for that answer
 *   • `evaluation_jobs.status`    — becomes `completed`, but ONLY once no answer
 *                                   on that paper is still flagged. This is what
 *                                   stops the student's results screen saying
 *                                   "AI is reviewing your answer" forever over a
 *                                   mark a person already finalised.
 */
export async function overrideQuestionResult(params: {
  resultId: string
  score: number
  note?: string
  reviewerId: string
}): Promise<OverrideResult> {
  const { resultId, score, note, reviewerId } = params

  const [row] = await db
    .select({
      id: questionResults.id,
      jobId: questionResults.jobId,
      score: questionResults.score,
      maxScore: questionResults.maxScore,
      aiScore: questionResults.aiScore,
      reviewStatus: questionResults.reviewStatus,
      sessionId: evaluationJobs.sessionId,
      tenantId: evaluationJobs.tenantId,
      examId: examSessions.examId,
    })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(eq(questionResults.id, resultId))
    .limit(1)
  if (!row) throw Errors.NOT_FOUND('Evaluation result')

  if (row.reviewStatus !== 'needs_human')
    throw new AppError(
      'CONFLICT',
      row.reviewStatus === 'resolved'
        ? 'This answer has already been reviewed'
        : 'This answer was graded by the AI and is not open for manual review',
      409,
    )

  if (!Number.isInteger(score) || score < 0 || score > row.maxScore)
    throw Errors.VALIDATION(`score must be an integer between 0 and ${row.maxScore}`)

  const now = new Date()

  // The WHERE clause repeats the `needs_human` check so that two operators
  // clearing the queue at the same moment cannot both claim the same item — the
  // second UPDATE matches no rows and throws the 409 below.
  const updated = await db
    .update(questionResults)
    .set({
      score,
      // `??` means "keep the existing value if there is one". So `ai_score` is
      // only ever filled in from the AI's own number the FIRST time. If an
      // operator corrects the same answer twice, reading `ai_score` later still
      // tells you what the machine produced, not what the previous operator typed.
      aiScore: row.aiScore ?? row.score,
      reviewStatus: 'resolved',
      reviewedBy: reviewerId,
      reviewedAt: now,
      reviewNote: note ?? null,
    })
    .where(and(eq(questionResults.id, resultId), eq(questionResults.reviewStatus, 'needs_human')))
    .returning({ id: questionResults.id })
  if (updated.length === 0) throw new AppError('CONFLICT', 'This answer has already been reviewed', 409)

  // Recalculate the session total by ADDING UP every `question_results` row for
  // this job — never by taking the old total and adjusting it by the difference.
  //
  // Why: a total added up from the rows is correct no matter what else has been
  // re-graded in between. A total maintained by arithmetic is correct only until
  // something else changes underneath it, and then it is silently wrong forever.
  const [rollup] = await db
    .select({ total: sql<number>`coalesce(sum(${questionResults.score}), 0)::int` })
    .from(questionResults)
    .where(eq(questionResults.jobId, row.jobId))
  const sessionScore = rollup?.total ?? 0

  await db
    .update(examSessions)
    .set({ manualScore: sessionScore })
    .where(eq(examSessions.id, row.sessionId))

  // CLOSE THE JOB IF THIS WAS THE LAST ANSWER IT WAS WAITING ON.
  //
  // Nothing else does this, and without it the correction is invisible to the
  // student. `settleJob` parks the row at `failed` and only stamps `settled_at`;
  // the worker's success path is the sole other writer of `completed`, and it
  // never runs for a paper a person finished by hand. So the row would sit at
  // `failed` forever — and because `publicJobStatus` shows `failed` as
  // `processing`, the student is told "AI is reviewing your answer" underneath a
  // score that is already published and final.
  //
  // THE CONDITION IS PER-PAPER, NOT PER-ANSWER. A paper with two flagged answers
  // is not finished until both are scored, and until then "still being worked on"
  // is the truthful thing to show. Hence the count over the whole job.
  const [stillOpen] = await db
    .select({ n: count() })
    .from(questionResults)
    .where(
      and(eq(questionResults.jobId, row.jobId), eq(questionResults.reviewStatus, 'needs_human')),
    )

  let jobClosed = false
  if ((stillOpen?.n ?? 0) === 0) {
    const closed = await db
      .update(evaluationJobs)
      .set({
        status: 'completed',
        completedAt: now,
        // `settled_at` IS DELIBERATELY LEFT IN PLACE — the opposite of what the
        // worker's success path does. The worker clears it because a real
        // re-grade proves the paper was never beyond the machine's reach. Here it
        // genuinely was, and a person finished it; that stamp is the only record
        // that this paper ever went through the backstop.
        //
        // `failure_class`, `error` and `last_error_code` stay for the same reason
        // (see the note in evaluation.backstop.ts): they are the record of WHY a
        // person was needed.
      })
      // Only a `failed` row is ours to close. `pending` or `processing` means a
      // worker is mid-flight — most likely a force-retry the operator started
      // before typing a score — and it will write its own terminal status when it
      // lands. Stamping `completed` over a live worker would be a guess. If that
      // worker then fails, the row comes out as `failed` with nothing flagged,
      // which is exactly what `closeFinishedSettledJobs` sweeps up next tick.
      .where(and(eq(evaluationJobs.id, row.jobId), eq(evaluationJobs.status, 'failed')))
      .returning({ id: evaluationJobs.id })
    jobClosed = closed.length > 0
  }

  const remainingForExam = await countOpenReviewsForExam(row.examId)

  console.log(
    `[evaluation-review] resolved result=${resultId} session=${row.sessionId} ` +
      `by=${reviewerId} score=${score}/${row.maxScore} (ai=${row.score}) ` +
      `sessionScore=${sessionScore} remainingForExam=${remainingForExam} ` +
      `jobClosed=${jobClosed}`,
  )

  return {
    resultId,
    sessionId: row.sessionId,
    examId: row.examId,
    tenantId: row.tenantId,
    score,
    aiScore: row.aiScore ?? row.score,
    sessionScore,
    remainingForExam,
    jobClosed,
  }
}
