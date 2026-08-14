import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { evaluationJobs, questionResults } from './evaluation.schema.js'
import { examSessions, sessionAnswers } from '@modules/exam-session/exam-session.schema.js'
import { questions } from '@modules/exam/exam.schema.js'
import { createReportForSession } from '@modules/report/report.service.js'
import { BACKSTOP_AFTER_MS, BACKSTOP_MAX_ATTEMPTS } from './evaluation.retry.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE BACKSTOP — the last resort, when retrying has stopped helping.
//
// WHAT THIS FILE IS FOR
// Every other file in this folder exists to make evaluation KEEP TRYING. This
// one exists to make it STOP. Both were asked for, and they only clash on one
// input — a photo the AI simply cannot read:
//
//   "AI evaluation must never look like it failed"  → never give up
//   "one student must not block the whole class"    → you must give up sometime
//
// WHY THE CLASH MATTERS
// An exam only leaves `under_evaluation` once EVERY session is finished. So one
// unreadable upload out of thirty holds all thirty students' results forever.
// "Being patient" would produce exactly the same dead end as crashing.
//
// WHAT IT DOES
// Once a job has passed BOTH limits in evaluation.retry.ts (30 tries AND 6
// hours), this closes the session out anyway:
//
//   • each answer that never got graded gets a placeholder score of 0, marked
//     `question_results.review_status = 'needs_human'`
//   • the session moves to `evaluated`
//   • the exam can now reach `ready_to_publish`, so the other 29 students' marks
//     are not stuck
//   • the flagged answers appear in an internal review queue
//
// WHO FIXES THEM: **Gyanverse staff, never the coaching's teacher.** That is why
// the flag lives on an internal-only column and is never sent to any tenant
// screen. Asking a teacher to "fix the answer the AI couldn't read" would simply
// be the AI failure made visible again, in politer wording.
// Full write-up: docs/decisions/2026-08-12-evaluation-backstop.md
//
// TWO RULES THAT EVERYTHING ELSE DEPENDS ON:
//
//   1. A PLACEHOLDER IS NOT A MARK. The 0 exists only so the totals add up and
//      the exam can move on. `publishResults` refuses to run while any
//      `needs_human` row is still open, and that refusal is what stops a
//      placeholder ever reaching a student as a real score.
//
//   2. CLOSING A SESSION DOES NOT CANCEL IT. If a later try succeeds, or an
//      operator forces a re-run, the worker writes the real score over the
//      placeholder and clears the flag. This is a floor under the pipeline, not
//      an exit from it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Never close out more than 50 sessions in one sweep.
 *
 * WHY: after a six-hour engine outage on a busy afternoon, every job in the
 * system becomes eligible at the same moment. Closing them all in one go would
 * fire one report notification per student and drop hundreds of items into the
 * review queue in a single second.
 *
 * Nothing is lost — the next sweep takes the rest, oldest first.
 */
const MAX_SETTLES_PER_TICK = 50

/** How many rows we LOOK at. Higher than the 50 above so the reported counts
 *  stay truthful even when only 50 are actually closed out this round. */
const SCAN_LIMIT = 500

export interface BackstopCandidate {
  jobId: string
  sessionId: string
  tenantId: string
  examId: string
  attempts: number
  failureClass: string | null
  lastErrorCode: string | null
  createdAt: Date
}

/**
 * Find the jobs that have used up every automatic rescue the system has.
 *
 * READ-ONLY — it changes nothing. It is exported so the ops panel and the
 * `eval:inspect` script can show operators exactly the list the next sweep is
 * about to act on. Same reason the reconciler exports `findDrift`: two separate
 * versions of "is this beyond saving?" would disagree within a month, and the
 * one on the screen is the one people believe.
 *
 * ONLY `failed` ROWS QUALIFY. A row stuck at `pending`, or at `processing` with
 * a dead worker, is a lost job — the reconciler's problem, and it will put it
 * back on the queue. If this file grabbed those too, it would write a
 * placeholder 0 onto a paper that was about to be graded properly. (Both sweeps
 * run inside the same single worker, so "what if the reconciler is down" is not
 * a case this has to defend against.)
 */
export async function findBackstopCandidates(
  opts: { examId?: string; limit?: number } = {},
): Promise<BackstopCandidate[]> {
  const cutoff = new Date(Date.now() - BACKSTOP_AFTER_MS)

  return db
    .select({
      jobId: evaluationJobs.id,
      sessionId: evaluationJobs.sessionId,
      tenantId: evaluationJobs.tenantId,
      examId: examSessions.examId,
      attempts: evaluationJobs.attempts,
      failureClass: evaluationJobs.failureClass,
      lastErrorCode: evaluationJobs.lastErrorCode,
      createdAt: evaluationJobs.createdAt,
    })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(
      and(
        opts.examId ? eq(examSessions.examId, opts.examId) : undefined,
        // The SESSION is what holds the exam back. Once it is already
        // `evaluated` there is nothing here to close out, no matter what the job
        // row says.
        eq(examSessions.status, 'submitted'),
        eq(evaluationJobs.status, 'failed'),
        // `settled_at` empty = we have not already closed this one out.
        isNull(evaluationJobs.settledAt),
        // THE TIME LIMIT. Measured from `evaluation_jobs.created_at`, i.e. from
        // when the student submitted — "how long has this student been waiting?".
        // Measuring from the last attempt instead would never work, because the
        // retries keep resetting that clock and six hours would never arrive.
        lte(evaluationJobs.createdAt, cutoff),
        or(
          // Already finished failing: retrying cannot improve a blank photo or a
          // deleted exam. These rows are only here to wait out the time limit.
          inArray(evaluationJobs.failureClass, ['needs_human', 'permanent']),
          // THE TRY LIMIT. Still marked `transient` — meaning "worth retrying" —
          // yet still failing after 30 tries spread over six hours. At that point
          // the engine is not coming back in time to save this class.
          gte(evaluationJobs.attempts, BACKSTOP_MAX_ATTEMPTS),
        ),
      ),
    )
    .orderBy(asc(evaluationJobs.createdAt))
    .limit(opts.limit ?? SCAN_LIMIT)
}

export interface BackstopCounts {
  /** Sessions closed out so their exam could move forward. */
  settled: number
  /** Answers given a placeholder 0 and marked `needs_human`. */
  flagged: number
  /** Ones a real worker finished first. Normal and fine, NOT errors. */
  raced: number
  /** Attempts that threw an error. They stay open and are retried next sweep. */
  errors: number
  /** True when there was more to do than the 50-per-sweep limit allowed. */
  capped: boolean
}

/**
 * Run ONE backstop sweep.
 *
 * Safe to run twice, and safe to run while workers are grading. Every write is
 * conditional, so if a worker finishes a job in the middle of this, the worker
 * wins and we count it as `raced`.
 */
export async function runBackstopSweep(): Promise<BackstopCounts> {
  const counts: BackstopCounts = {
    settled: 0,
    flagged: 0,
    raced: 0,
    errors: 0,
    capped: false,
  }

  const candidates = await findBackstopCandidates()
  if (candidates.length > MAX_SETTLES_PER_TICK) counts.capped = true

  for (const candidate of candidates.slice(0, MAX_SETTLES_PER_TICK)) {
    try {
      const result = await settleJob(candidate)
      if (!result) {
        counts.raced++
        continue
      }
      counts.settled++
      counts.flagged += result.flagged
    } catch (err) {
      counts.errors++
      console.error(`[evaluation-backstop] settle failed for job ${candidate.jobId}:`, err)
    }
  }

  return counts
}

/**
 * Close out ONE session. Four steps:
 *   1. write a placeholder 0 for every answer that never got graded
 *   2. add up the session's total from its `question_results` rows
 *   3. move the session to `evaluated`
 *   4. stamp `evaluation_jobs.settled_at` so we never do this twice
 *
 * Returns null when someone else got there first — either the job graded
 * successfully between the scan and this write, or another sweep already closed
 * it. Both are correct outcomes, neither is an error.
 *
 * WHICH ANSWERS GET A PLACEHOLDER: only subjective questions the student
 * ACTUALLY ANSWERED (there is an image in `session_answers`) that never got
 * scored. A question the student left blank is not a review task — it already
 * scores 0 because nothing was written, and flagging it would bury the real
 * problems in a queue full of unanswered questions.
 */
export async function settleJob(
  candidate: BackstopCandidate,
): Promise<{ flagged: number; score: number } | null> {
  const { jobId, sessionId } = candidate

  // CLAIM IT FIRST. This one UPDATE is the entire protection against two things
  // happening at once: it only succeeds if the row is still `failed` AND
  // `settled_at` is still empty. Whoever wins this write owns the close-out.
  // A worker that graded the job in the meantime has already moved it off
  // `failed`, so this matches nothing and we back out.
  const claimed = await db
    .update(evaluationJobs)
    .set({ settledAt: new Date() })
    .where(
      and(
        eq(evaluationJobs.id, jobId),
        eq(evaluationJobs.status, 'failed'),
        isNull(evaluationJobs.settledAt),
      ),
    )
    .returning({ id: evaluationJobs.id })
  if (claimed.length === 0) return null

  const [session] = await db
    .select({ id: examSessions.id, examId: examSessions.examId, status: examSessions.status })
    .from(examSessions)
    .where(eq(examSessions.id, sessionId))
    .limit(1)
  if (!session || session.status !== 'submitted') return null

  const subjective = await db
    .select({
      questionId: questions.id,
      marks: questions.marks,
      answerImageUrl: sessionAnswers.imageUrl,
    })
    .from(questions)
    .leftJoin(
      sessionAnswers,
      and(eq(sessionAnswers.questionId, questions.id), eq(sessionAnswers.sessionId, sessionId)),
    )
    .where(and(eq(questions.examId, session.examId), eq(questions.type, 'subjective')))

  const scored = new Set(
    (
      await db
        .select({ questionId: questionResults.questionId })
        .from(questionResults)
        .where(eq(questionResults.jobId, jobId))
    ).map((r) => r.questionId),
  )

  const placeholders = subjective
    .filter((q) => q.answerImageUrl && !scored.has(q.questionId))
    .map((q) => ({
      jobId,
      questionId: q.questionId,
      // A placeholder, NOT the student's mark. `publishResults` refuses to run
      // while any `needs_human` row is still open, so this 0 can never reach a
      // student as a real score.
      score: 0,
      maxScore: q.marks,
      aiFeedback: null,
      imageUrl: q.answerImageUrl!,
      reviewStatus: 'needs_human',
    }))

  if (placeholders.length > 0) {
    // "Do nothing on conflict" instead of "overwrite on conflict", and the
    // difference is important: if a row appeared between the read above and this
    // insert, it came from a worker that ACTUALLY graded that question. A real
    // score must never be overwritten by a placeholder 0.
    await db.insert(questionResults).values(placeholders).onConflictDoNothing({
      target: [questionResults.jobId, questionResults.questionId],
    })
  }

  const [rollup] = await db
    .select({ total: sql<number>`coalesce(sum(${questionResults.score}), 0)::int` })
    .from(questionResults)
    .where(eq(questionResults.jobId, jobId))
  const total = rollup?.total ?? 0

  await db.transaction(async (tx) => {
    await tx
      .update(examSessions)
      .set({ status: 'evaluated', manualScore: total })
      .where(and(eq(examSessions.id, sessionId), eq(examSessions.status, 'submitted')))

    // `failure_class` is rewritten to `needs_human` even for a job that arrived
    // here on the 30-try limit rather than on a blank photo. Whatever the
    // engine's excuse was, what this paper needs NOW is a person.
    //
    // `error`, `last_error_code` and `attempts` are deliberately left alone —
    // they are the only record of WHY a person is needed, and the review queue
    // displays them to the operator.
    if (placeholders.length > 0) {
      await tx
        .update(evaluationJobs)
        .set({ failureClass: 'needs_human' })
        .where(eq(evaluationJobs.id, jobId))
    }
  })

  console.warn(
    `[evaluation-backstop] settled session=${sessionId} job=${jobId} ` +
      `attempts=${candidate.attempts} code=${candidate.lastErrorCode ?? 'none'} ` +
      `flagged=${placeholders.length} score=${total}`,
  )

  // BUILD THE REPORT ONLY IF NOTHING WAS FLAGGED.
  //
  // A row in `reports` is the thing the STUDENT reads. For a public (marketplace)
  // exam it becomes visible the moment it exists, because those exams are
  // self-paced and have no teacher to press publish — `assertResultsVisible`
  // lets them through the publish gate.
  //
  // So writing a report here would hand a student a placeholder 0 as their
  // finished mark, which is the single outcome this whole design exists to
  // prevent.
  //
  // A flagged session therefore just has no report yet. Everywhere downstream —
  // the teacher's panel, the student's results screen — that shows as "still
  // being processed", which is exactly what it is. The report gets built later,
  // when the operator's score is entered (see evaluation.review.ts).
  if (placeholders.length === 0) await createReportForSession(sessionId)

  return { flagged: placeholders.length, score: total }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSING THE JOB ROW — the other end of `settleJob`.
//
// THE HALF-OPEN STATE THIS EXISTS FOR
// `settleJob` above leaves the job at `status = 'failed'` on purpose: at the
// moment it runs, the paper really is unfinished, and a person still has to look
// at it. What was missing is the step that says "…and now it IS finished".
//
// That mattered more than it looks, because `publicJobStatus` shows `failed` to
// students and teachers as `processing`. So a job left at `failed` after the
// work was actually done tells the student "AI is reviewing your answer" —
// forever, underneath a mark that is already published. The results screen also
// polls every 4 seconds for a status that is never coming.
//
// TWO WAYS A SETTLED JOB BECOMES FINISHED, AND ONLY ONE OF THEM SELF-HEALS:
//   1. An operator scores the flagged answers by hand. `overrideQuestionResult`
//      now closes the job itself when it clears the last one — that is the
//      first-class path, done synchronously so the student never sees a stale
//      status even for a second.
//   2. `settleJob` flagged NOTHING. This happens when every subjective answer
//      was already scored before the job died, or the student left them all
//      blank. The session is closed, the report is built and published, and the
//      job row is left at `failed` with no flagged answer anywhere — so there is
//      no override coming to fix it, ever. Nothing but this sweep catches that.
//
// So this is not only a safety net for (1). It is the ONLY thing that resolves
// (2), and it is the backfill for rows already stranded before either existed.
//
// WHY IT LIVES HERE AND NOT IN THE RECONCILER
// The reconciler's whole job is Postgres and Redis disagreeing about work that
// is still to be RUN, and every repair it makes ends in a queue add. This sweep
// touches no queue, runs nothing, and repairs a state that this file created.
// Keeping both ends of the backstop's lifecycle in one file is what makes that
// lifecycle readable.
// ─────────────────────────────────────────────────────────────────────────────

export interface UnclosedSettledJob {
  jobId: string
  sessionId: string
  tenantId: string
  examId: string
  settledAt: Date
}

/**
 * Settled jobs that have nothing left to wait for, but are still sitting at
 * `failed`.
 *
 * READ-ONLY — same contract as `findBackstopCandidates` and the reconciler's
 * `findDrift`, and for the same reason: the ops panel shows this exact list, so
 * what an operator reads on screen is what the next sweep is about to change.
 *
 * THE THREE CONDITIONS, AND WHY EACH ONE IS LOAD-BEARING:
 *   • `status = 'failed'`        — a `completed` row is already right, and
 *                                  `pending`/`processing` means a live worker
 *                                  owns it and will write its own outcome.
 *   • `settled_at IS NOT NULL`   — CONFINES THIS TO BACKSTOPPED JOBS. A `failed`
 *                                  row without the stamp is somewhere in the
 *                                  retry ladder, which belongs to the reconciler.
 *                                  Closing one of those would end a job that was
 *                                  still going to be retried.
 *   • no `needs_human` rows      — the paper is genuinely finished. A paper with
 *                                  one of two answers scored is NOT, and must
 *                                  keep reading as "still being worked on".
 */
export async function findUnclosedSettledJobs(
  opts: { limit?: number } = {},
): Promise<UnclosedSettledJob[]> {
  return db
    .select({
      jobId: evaluationJobs.id,
      sessionId: evaluationJobs.sessionId,
      tenantId: evaluationJobs.tenantId,
      examId: examSessions.examId,
      settledAt: sql<Date>`${evaluationJobs.settledAt}`,
    })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(
      and(
        eq(evaluationJobs.status, 'failed'),
        isNotNull(evaluationJobs.settledAt),
        sql`not exists (
          select 1 from question_results qr
          where qr.job_id = ${evaluationJobs.id} and qr.review_status = 'needs_human'
        )`,
      ),
    )
    .orderBy(asc(evaluationJobs.settledAt))
    .limit(opts.limit ?? SCAN_LIMIT)
}

/**
 * Move those rows to `completed`.
 *
 * ONCE THE OVERRIDE PATH IS DOING ITS JOB, THIS SHOULD ALWAYS FIND ZERO — except
 * for case (2) in the header, which has no other route out. That makes a non-zero
 * count worth logging: it is either a blank-flagged settle, or a new way for a
 * paper to finish that nobody wired up. Both are things an operator wants to see.
 *
 * Only `status` and `completed_at` change. `failure_class`, `error`,
 * `last_error_code` and `settled_at` are all left exactly as they are — unlike
 * the worker's success path, which wipes them because a genuine re-grade proves
 * the job was never beyond saving. Nothing was re-graded here. Those columns are
 * the record of what this paper went through, and the review queue reads them.
 */
export async function closeFinishedSettledJobs(): Promise<{ closed: number }> {
  const candidates = await findUnclosedSettledJobs()
  if (candidates.length === 0) return { closed: 0 }

  // The `failed` + `settled_at` guards are repeated here, on the write, so a
  // worker that moved the row between the scan and now wins instead of being
  // stamped over.
  //
  // The "no flagged answers" half is NOT re-checked, and does not need to be:
  // `settleJob` is the only writer of `needs_human`, and it refuses to touch a
  // row that already has `settled_at`. So no new flag can appear on these rows.
  const closed = await db
    .update(evaluationJobs)
    .set({ status: 'completed', completedAt: new Date() })
    .where(
      and(
        inArray(
          evaluationJobs.id,
          candidates.map((c) => c.jobId),
        ),
        eq(evaluationJobs.status, 'failed'),
        isNotNull(evaluationJobs.settledAt),
      ),
    )
    .returning({ id: evaluationJobs.id })

  if (closed.length > 0)
    console.warn(
      `[evaluation-backstop] closed ${closed.length} settled job(s) that were ` +
        `finished but still marked failed`,
    )

  return { closed: closed.length }
}
