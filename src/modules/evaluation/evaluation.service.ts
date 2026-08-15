import { Queue, UnrecoverableError } from 'bullmq'
import IORedis from 'ioredis'
import { and, desc, eq, sql } from 'drizzle-orm'
import { env } from '@config/env.js'
import { db } from '@shared/db.js'
import { AppError, Errors } from '@shared/errors.js'
import { evaluationJobs, questionResults } from './evaluation.schema.js'
import { examSessions, sessionAnswers } from '@modules/exam-session/exam-session.schema.js'
import { exams, questions } from '@modules/exam/exam.schema.js'
import { getLimitUsage } from '@modules/billing/billing.service.js'
import { recomputeReportForSession } from '@modules/report/report.service.js'
import { assertResultsVisible } from '@modules/exam/exam.service.js'
import { buildOcrFriendlyUrl } from '@modules/storage/index.js'
import { evaluateSteps, indexDocuments as engineIndexDocuments } from './evaluation.engine.js'
import { hasGradeableText, ocrImageCached } from './evaluation.ocr.js'
import { countOpenReviewsForExam } from './evaluation.review.js'
import {
  EVALUATION_JOB_OPTS,
  classifyFailure,
  isTerminal,
  retryDelayMs,
} from './evaluation.retry.js'
import type {
  AiFeedbackPayload,
  EngineEvaluatedStep,
  EngineIndexDocument,
  EvaluationJobPayload,
  EvaluationJobStatus,
} from './evaluation.types.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE HEART OF THE MODULE — where a paper actually gets graded.
//
// Everything else in this folder supports what happens in `processJob` below.
// The full journey of one student's paper:
//
//   1. student submits              → exam-session calls `enqueueEvaluation`
//   2. a row is created             → `evaluation_jobs`, status `pending`
//   3. a worker picks it up         → `processJob`, status `processing`
//   4. per question: read + grade   → OCR, then the AI grader
//   5. marks are saved              → `question_results`, one row per question
//   6. session closed               → `exam_sessions.status = 'evaluated'`
//   7. report built, student told
//
// If step 4 or 5 throws, the catch block at the bottom of `processJob` records
// WHY, decides whether it is worth retrying, and the retry / reconciler /
// backstop files take it from there.
// ─────────────────────────────────────────────────────────────────────────────

// ── The queue connection ──────────────────────────────────────────────────
//
// Created on first use and then reused, so we open one Redis connection per
// process instead of one per job.

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
 * STEP 1 — put a submitted paper in line to be graded.
 *
 * Called by `submitSession` in the exam-session module, right after a student
 * submits a paper that has handwritten questions on it.
 *
 * Three things happen: find which coaching the exam belongs to, INSERT a row
 * into `evaluation_jobs`, then add the job to the queue.
 *
 * Returns null ONLY if the session or its exam no longer exists. In every other
 * case a submitted paper gets a job row — no exceptions.
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

  // THIS ONLY MEASURES USAGE — IT NEVER BLOCKS.
  //
  // A coaching that has gone past its plan's AI evaluation limit still gets its
  // papers graded; we just write a warning to the logs. Blocking here would
  // leave a submitted paper with no job row at all, and that strands the whole
  // exam in `under_evaluation` with nothing anywhere for anyone to retry.
  //
  // The try/catch matters for the same reason: if the billing lookup itself
  // fails, that is not a reason to skip grading a student's paper.
  try {
    const quota = await getLimitUsage(exam.tenantId, 'ai_evaluations')
    if (!quota.within) {
      console.warn(
        `[evaluation] tenant=${exam.tenantId} over ai_evaluations quota ` +
          `(${quota.current}/${quota.max}) — evaluating anyway, session=${sessionId}`,
      )
    }
  } catch (err) {
    console.error(`[evaluation] quota read failed for tenant=${exam.tenantId}:`, err)
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
    EVALUATION_JOB_OPTS,
  )

  return { jobId: job.id }
}

// ── The worker: grading one paper ─────────────────────────────────────────

/**
 * How long a worker's claim on a job stays valid: 10 minutes.
 *
 * The worker pushes this forward after EVERY question, so the length of the
 * paper never decides whether the claim survives — only whether the worker is
 * still alive does. Once this time passes while the row still says `processing`,
 * that worker is gone and the reconciler may safely take the job back.
 */
const LEASE_MS = 10 * 60 * 1000

/**
 * GRADE ONE PAPER. This is what the worker runs for each job on the queue.
 *
 *   1. claim the job — add 1 to `attempts`, take the lease, set `processing`
 *   2. for every handwritten question the student answered: read it, grade it
 *   3. save a row per question in `question_results`, add up the total
 *   4. set the session to `evaluated` and the job to `completed`
 *   5. build the report and notify the student
 *
 * **SAFE TO RUN TWICE, AND IT PICKS UP WHERE IT LEFT OFF.**
 * Step 2 skips any question that already has a result for this job, and every
 * OCR read is saved in `ocr_cache`.
 *
 * Example: a 10-question paper dies on question 8. The retry does NOT re-read
 * questions 1-7 — it costs 8 questions' worth of AI calls in total, not 8 on
 * every one of its 50 tries. And running this again on an already-completed job
 * makes zero AI calls and changes nothing.
 */
export async function processJob(payload: EvaluationJobPayload): Promise<void> {
  const { jobId, sessionId } = payload

  // `attempts` is counted here in the database rather than taken from the queue
  // library's own counter. WHY: the reconciler and the force-retry button put
  // jobs back on the queue outside of the queue's counting, which resets it. This
  // count has to survive that, because it is what decides when an unreadable
  // photo has had its three chances. We read the new value straight back, since
  // `classifyFailure` needs it further down.
  const [claimed] = await db
    .update(evaluationJobs)
    .set({
      status: 'processing',
      startedAt: new Date(),
      attempts: sql`${evaluationJobs.attempts} + 1`,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      nextRetryAt: null,
    })
    .where(eq(evaluationJobs.id, jobId))
    .returning({ attempts: evaluationJobs.attempts })

  const attemptsMade = claimed?.attempts ?? 1

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

    // WHAT THIS JOB HAS ALREADY GRADED.
    //
    // We resume question by question. A row in `question_results` means the AI
    // ran all the way through for that question, so calling the AI again would
    // just buy the same number back at full price.
    //
    // ONE EXCEPTION — `needs_human` rows are filtered OUT of this list. Those are
    // the backstop's placeholder zeros, written so the class could move on. They
    // are explicitly NOT a score. If we treated one as "already graded", a
    // flagged answer could never be rescued: an operator's force-retry after an
    // engine fix would skip the exact question it was run for.
    const priorResults = await db
      .select({
        questionId: questionResults.questionId,
        imageUrl: questionResults.imageUrl,
        reviewStatus: questionResults.reviewStatus,
      })
      .from(questionResults)
      .where(eq(questionResults.jobId, jobId))
    const scored = new Map(
      priorResults
        .filter((r) => r.reviewStatus !== 'needs_human')
        .map((r) => [r.questionId, r.imageUrl]),
    )

    let reused = 0
    let graded = 0
    let ocrCacheHits = 0

    for (const q of subjective) {
      if (!q.answerImageUrl) continue

      // Skip it ONLY if the saved row is about the SAME image. If the student
      // re-uploaded their answer, that is a different photo and has to be read
      // again.
      //
      // A `resolved` row (one an operator graded by hand) also lands here, and
      // skipping it is deliberate: once a person has scored an answer, no later
      // re-run may quietly replace their number with the machine's. The only
      // thing that can overturn a human's score is the student's image actually
      // changing — that is a different answer, not a second opinion on the same
      // one.
      if (scored.get(q.questionId) === q.answerImageUrl) {
        reused++
        continue
      }

      await renewLease(jobId)

      const ocrUrl = buildOcrFriendlyUrl(q.answerImageUrl)
      const { steps: ocr, cached } = await ocrImageCached(ocrUrl)
      if (cached) ocrCacheHits++

      // DOOR 1 onto a silent zero. A blank page does NOT come back as an empty
      // list — the engine returns one step whose text is empty (verified against
      // the real engine, 2026-08-12). So checking the list length would let an
      // unreadable paper straight through to the grader, which scores it 0.
      // Check the text, not the list.
      if (!hasGradeableText(ocr)) {
        // This used to write a score of 0 and mark the job completed — a student
        // silently given nothing, with no warning anywhere. Now it is a failure:
        // the job is retried, and only once the 3 tries are used up does
        // `classifyFailure` turn it into `needs_human` for a person to look at.
        throw new AppError(
          'OCR_EMPTY',
          `OCR returned no readable text for question ${q.questionId}`,
          422,
        )
      }

      const evaluation = await evaluateSteps({
        ocrData: ocr,
        question: q.body,
        collectionName,
      })

      // DOOR 2 onto the same silent zero: the text WAS read, but the grader
      // returned no scored steps at all. `scoreFromSteps` would return 0 for an
      // empty list, and once that 0 is saved it is indistinguishable from
      // "the student answered and got everything wrong".
      if (evaluation.response.length === 0) {
        throw new AppError(
          'EVAL_EMPTY',
          `Engine returned no evaluated steps for question ${q.questionId}`,
          422,
        )
      }

      const score = scoreFromSteps(evaluation.response, q.marks)
      const feedback = buildFeedbackPayload(evaluation.response)
      graded++

      // "Insert, or update if it already exists" — not a plain insert. The skip
      // above handles the ordinary re-run, but a re-uploaded image lands on a
      // row that already exists, and the database's one-row-per-question rule
      // would reject a second insert outright. The most recent grading of a
      // question wins.
      await db
        .insert(questionResults)
        .values({
          jobId,
          questionId: q.questionId,
          score,
          maxScore: q.marks,
          aiFeedback: JSON.stringify(feedback),
          imageUrl: q.answerImageUrl,
        })
        .onConflictDoUpdate({
          target: [questionResults.jobId, questionResults.questionId],
          set: {
            score,
            maxScore: q.marks,
            aiFeedback: JSON.stringify(feedback),
            imageUrl: q.answerImageUrl,
            // A real score cancels the review. Getting to this line means the
            // engine DID read the page, so any `needs_human` placeholder sitting
            // on it is out of date and the operator has nothing left to do.
            // Leaving the flag set would keep the teacher's publish button
            // locked over an answer that graded perfectly well.
            reviewStatus: 'ai',
            aiScore: null,
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: null,
          },
        })
    }

    // Add the total up from every `question_results` row this job owns — never
    // by keeping a running total inside the loop above.
    //
    // Why: a partial re-run only touches the questions it actually graded. A
    // running total would either miss the skipped ones or double-count the
    // re-graded ones, depending on where the previous try happened to die.
    const [rollup] = await db
      .select({ total: sql<number>`coalesce(sum(${questionResults.score}), 0)::int` })
      .from(questionResults)
      .where(eq(questionResults.jobId, jobId))
    const aiTotal = rollup?.total ?? 0

    console.log(
      `[evaluation] job=${jobId} graded=${graded} reused=${reused} ` +
        `ocrCacheHits=${ocrCacheHits} score=${aiTotal}`,
    )

    await db.transaction(async (tx) => {
      await tx
        .update(examSessions)
        .set({ status: 'evaluated', manualScore: aiTotal })
        .where(eq(examSessions.id, sessionId))

      await tx
        .update(evaluationJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          error: null,
          // A success wipes every trace of the failed tries before it, so the
          // reconciler and the ops screens never treat a finished job as one
          // still needing attention.
          lastErrorCode: null,
          failureClass: null,
          nextRetryAt: null,
          leaseExpiresAt: null,
          // Including the backstop's stamp. If this job had been closed out with
          // a placeholder and has now graded for real, it was never beyond
          // saving — leaving the stamp would keep reporting it on the ops screens
          // as a paper that needed a person.
          settledAt: null,
        })
        .where(eq(evaluationJobs.id, jobId))
    })

    // Build the student's report — or UPDATE it, if this run changed marks that
    // an earlier report already froze.
    //
    // This was `createReportForSession`, which is idempotent by *early return*:
    // if a report existed it handed back the old one untouched. That is right for
    // two paths that both just want a report to exist, and wrong here, because a
    // job can succeed with a report already on the table:
    //
    //   • the student re-uploaded an answer, so this run re-graded a question
    //     that was already scored and reported
    //   • the backstop settled this session with nothing flagged (which DOES
    //     write a report), and an operator later forced a re-run that worked
    //
    // In both, `exam_sessions.manual_score` ended up correct while
    // `reports.total_score` kept the old number — and the report is the thing the
    // student actually reads. Recompute writes the totals and the per-question
    // rows through. Creation still goes through `createReportForSession`
    // underneath, so the first-time path and its notification are unchanged.
    await recomputeReportForSession(sessionId)
  } catch (err) {
    // ── SOMETHING WENT WRONG ────────────────────────────────────────────────
    // Everything below records WHAT went wrong and WHEN to try again. It does
    // not decide those things itself — evaluation.retry.ts does.
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof AppError ? err.code : 'UNKNOWN'
    const failureClass = classifyFailure(code, attemptsMade)
    const terminal = isTerminal(failureClass)

    await db
      .update(evaluationJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        error: message,
        lastErrorCode: code,
        failureClass,
        // When this job may next be touched. It is deliberately the SAME wait
        // the queue is about to apply, so the reconciler does not see a job the
        // queue is simply holding and add a second copy of it.
        //
        // A failure that cannot be retried gets NO date at all. That empty value
        // is the marker meaning "finished failing" — nothing picks it up again
        // except a person or the backstop.
        nextRetryAt: terminal ? null : new Date(Date.now() + retryDelayMs(attemptsMade)),
        // Let the lease go, so the reconciler never mistakes this failed job for
        // one a live worker is still holding.
        leaseExpiresAt: null,
      })
      .where(eq(evaluationJobs.id, jobId))

    console.warn(
      `[evaluation] job=${jobId} attempt=${attemptsMade} ${failureClass} ${code}: ${message}`,
    )

    // `UnrecoverableError` is the queue library's way of being told "stop, do
    // not retry this one". `permanent` and `needs_human` cannot be improved by
    // running again, and spending 50 tries on them would delay every other
    // student's paper waiting behind them.
    if (terminal) throw new UnrecoverableError(`${code}: ${message}`)
    // Anything else is thrown normally, which is what tells the queue to apply
    // the wait and try again.
    throw err
  }
}

/**
 * Push the worker's 10-minute claim forward another 10 minutes.
 *
 * Called between questions. A long paper is not evidence that the worker died,
 * and if the reconciler took a job back in the middle of a run, we would pay the
 * AI bill for that paper twice.
 */
async function renewLease(jobId: string): Promise<void> {
  await db
    .update(evaluationJobs)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
    .where(eq(evaluationJobs.id, jobId))
}

// ── Turning the AI's verdict into a mark ──────────────────────────────────

/**
 * Convert the AI's per-step verdicts into a mark out of the question's total.
 *
 * The AI gives every step a weight (how much of the answer it represents) and a
 * status. We add up the weight of the steps marked `right`, divide by the total
 * weight, and scale that to the question's marks.
 *
 * Example: a 10-mark question comes back as 3 steps with weights 2, 3 and 5.
 * Steps 1 and 2 are `right`, step 3 is `wrong`. (2 + 3) / 10 × 10 = 5 marks.
 *
 * Note that only `right` earns anything — `incomplete` and `unknown` count for
 * nothing, the same as `wrong`.
 */
function scoreFromSteps(steps: EngineEvaluatedStep[], maxMarks: number): number {
  const totalWeight = steps.reduce((sum, s) => sum + (s.step_weight ?? 0), 0)
  if (totalWeight <= 0) return 0

  const rightWeight = steps
    .filter((s) => s.step_status === 'right')
    .reduce((sum, s) => sum + (s.step_weight ?? 0), 0)

  return Math.round((rightWeight / totalWeight) * maxMarks)
}

/**
 * Package the AI's step-by-step verdict, plus a small tally, for saving into
 * `question_results.ai_feedback`. This is what the student's report screen reads
 * to show them which step went wrong.
 */
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

// ── Reading data back out (for the API) ───────────────────────────────────

/**
 * Translate the internal job status into what people outside Gyaanverse are
 * allowed to see. It maps `failed` → `processing` and passes everything else
 * through unchanged.
 *
 * WHY `failed` IS NEVER SHOWN: inside the system it only means "the most recent
 * try didn't land". It does not mean the job is over — a row sits at `failed`
 * between tries, while the queue is holding it and counting down to the next one.
 *
 * Showing that word caused a real bug: a student was told their paper had failed
 * at the exact moment the system was busy retrying it, and the results screen
 * stopped checking for updates and sat on "Pending" forever.
 *
 * The genuinely finished failures collapse the same way on purpose. A job the
 * backstop closes out STAYS at `failed`, with its answers flagged for a Gyaanverse
 * operator — so "still being worked on" is the honest reading of a `failed` row,
 * not a white lie.
 *
 * ⚠️ THAT IS ONLY HONEST WHILE SOMETHING STILL MOVES THE ROW OFF `failed` WHEN
 * THE WORK ENDS. It did not, once: `settleJob` parks the row and nothing closed
 * it afterwards, so a paper an operator had scored by hand — published, final,
 * done — went on telling the student "AI is reviewing your answer" indefinitely.
 * Two things now close it: `overrideQuestionResult` when a person clears the last
 * flagged answer, and `closeFinishedSettledJobs` for the settle that flagged
 * nothing at all. If you add a third way for a paper to finish, it has to close
 * the job too, or it lands straight back in this bug.
 */
function publicJobStatus(status: EvaluationJobStatus): EvaluationJobStatus {
  return status === 'failed' ? 'processing' : status
}

export async function getJobStatus(sessionId: string) {
  const [job] = await db
    .select()
    .from(evaluationJobs)
    .where(eq(evaluationJobs.sessionId, sessionId))
    .orderBy(desc(evaluationJobs.createdAt))
    .limit(1)
  return job ?? null
}

/**
 * One job, for the teacher or owner whose coaching it belongs to.
 *
 * NOTE THE HAND-PICKED COLUMNS. It would be shorter to spread the whole row with
 * `...job`, and that would be a mistake: the row also carries `error`,
 * `last_error_code`, `failure_class`, `attempts` and the lease timestamps.
 * Spreading it would publish all of that to the coaching — the same "the AI
 * failed" detail we removed from the screens, arriving through the API instead.
 *
 * A spread is also unsafe in the future tense: the next column anyone adds to the
 * table would start leaking automatically, with nobody noticing. The diagnostic
 * view of a job lives at `/internal/evaluation/*`, for Gyaanverse staff only.
 */
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
    id: job.id,
    sessionId: job.sessionId,
    tenantId: job.tenantId,
    status: publicJobStatus(job.status as EvaluationJobStatus),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    results: results.map((r) => ({
      questionId: r.questionId,
      score: r.score,
      maxScore: r.maxScore,
      imageUrl: r.imageUrl,
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

  // For a private (coaching) exam, hide the AI's scores and feedback until the
  // teacher has published results. Public marketplace exams are exempt — they
  // are self-paced and have no teacher to press the button.
  await assertResultsVisible(session.examId)

  const job = await getJobStatus(sessionId)
  if (!job) return null

  const results = await db
    .select()
    .from(questionResults)
    .where(eq(questionResults.jobId, job.id))

  return {
    status: publicJobStatus(job.status as EvaluationJobStatus),
    startedAt: job.startedAt,
    completedAt: job.completedAt,
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
 * How far along an exam's evaluation is — this feeds the teacher's "Under
 * Evaluation" panel.
 *
 * IT REPORTS PROGRESS ONLY: how many sessions are done, and how many answers
 * Gyaanverse is finishing by hand. No error messages, no error codes, no job ids.
 *
 * It used to also return every failed job so the teacher could press a retry
 * button. That existed because, back then, a crashed evaluation really would
 * hold an exam in `under_evaluation` forever with nothing anyone could click.
 * The reconciler and the backstop removed that dead end, and with it the reason
 * to ever tell a teacher the AI failed: retrying is now the system's job, and
 * the one case a machine cannot finish goes to Gyaanverse staff, not to the
 * coaching.
 *
 * ⚠️ Adding a failure count back into this response is not a small change — it
 * reverses that whole decision. See
 * docs/decisions/2026-08-12-evaluation-backstop.md
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

  // Answers the backstop parked for a Gyaanverse operator.
  //
  // This is the only number here the teacher can do nothing about, and the only
  // one that keeps `publishResults` locked — so the UI needs it in order to
  // explain a greyed-out publish button without ever saying the word "failed".
  //
  // It is a COUNT and nothing else: no error codes, no question ids, no student
  // names.
  const underReview = await countOpenReviewsForExam(examId)

  return {
    examId,
    status: exam.status,
    sessions: counts,
    // `pending` is exactly what the exam-lifecycle worker waits on, so the number
    // the teacher sees on screen is literally the number holding their exam back.
    pending: counts.inProgress + counts.awaitingEvaluation,
    underReview,
  }
}

// ── Retry: why there is none here ─────────────────────────────────────────
//
// There is deliberately NO retry a teacher or owner can trigger. `retryJob` and
// `retryFailedEvaluationsForExam` used to live here and were deleted along with
// their routes and the buttons that called them.
//
// The reason: between them, the queue's own retries, the reconciler and the
// backstop already re-run every job that can be re-run. A teacher-triggered
// retry could therefore only do one of two useless things — race the machinery
// that was already handling it, or re-run something that has already been parked
// for a person to look at.
//
// The one manual retry that still exists is `forceRetryJob` in
// `evaluation.ops.ts`: `super_admin` only, works across coachings, recorded in
// the audit log, and it deliberately KEEPS the error history that the old
// teacher-facing version used to wipe.

// ── Syllabus indexing (the AI's reference material) ───────────────────────
//
// Uploads a coaching's syllabus text into the vector database, so the grader can
// check a student's answer against the material it was actually taught from.
// This is the one function here that has nothing to do with grading a paper.

export async function indexSyllabus(params: {
  documents: EngineIndexDocument[]
  collectionName?: string
}) {
  if (!params.documents || params.documents.length === 0)
    throw Errors.VALIDATION('documents must be a non-empty list')
  return engineIndexDocuments(params)
}

// ── Small helpers ─────────────────────────────────────────────────────────

/**
 * Read the saved JSON in `question_results.ai_feedback` back into an object.
 *
 * If the text is not valid JSON — an old row, or one written by a previous
 * version — hand back the raw text instead of throwing. One unreadable feedback
 * blob must never break the whole results screen.
 */
function safeParseFeedback(raw: string): AiFeedbackPayload | { error: string } | string {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
