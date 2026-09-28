import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { Errors } from '@shared/errors.js'
import { evaluationJobs, ocrCache, questionResults } from './evaluation.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { exams } from '@modules/exam/exam.schema.js'
import { tenants } from '@modules/tenant/tenant.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { findDrift, getReconcilerScheduleHealth } from './evaluation.reconciler.js'
import { findBackstopCandidates, findUnclosedSettledJobs } from './evaluation.backstop.js'
import { getReviewQueueSummary } from './evaluation.review.js'
import {
  BACKSTOP_AFTER_MS,
  BACKSTOP_MAX_ATTEMPTS,
  EVALUATION_JOB_OPTS,
} from './evaluation.retry.js'
import { getEvaluationQueue } from './evaluation.service.js'

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A GYAANVERSE OPERATOR SEES, AND THE BUTTON THEY CAN PRESS.
//
// This file has two jobs:
//   1. `getEvaluationOverview` + `listActionableJobs` — the read-only picture of
//      how evaluation is doing right now, across every coaching.
//   2. `forceRetryJob` — the one manual "run it again" left in the product.
//
// Used only by the internal ops panel, by `super_admin` accounts.
//
// ONE ENDPOINT, NOT FOUR. Failure counts, jobs stuck over an hour, the top error
// codes of the last 24 hours and the per-coaching failure rate were originally
// planned as four separate reads. They are one screen answering one question —
// *"is this one bad photo, or is the engine down?"* — so they are one response.
// It grows by adding keys, never by adding routes.
//
// NOTHING HERE WORKS OUT "IS THIS STUCK?" FOR ITSELF. It calls `findDrift` and
// `findBackstopCandidates` — the exact same functions the reconciler and the
// backstop act on. So what an operator reads on screen IS, by construction, the
// list the next sweep will handle. If we wrote that logic a second time here,
// the two versions would disagree within a month, and the screen is the one
// people believe.
// ─────────────────────────────────────────────────────────────────────────────

/** How long an unfinished job has to sit before a person should be told: 1 hour. */
const STUCK_AFTER_MS = 60 * 60 * 1000

/** The look-back window for the error-code and per-coaching breakdowns. */
const WINDOW_24H_MS = 24 * 60 * 60 * 1000

/** Never list more than 50 stuck jobs — this is a snapshot, not a work queue. */
const STUCK_LIMIT = 50

/**
 * Run one part of the overview. If it throws, return `{ error }` for that part
 * instead of letting the whole page fail.
 *
 * WHY: this page is read DURING incidents — which is exactly when one of the
 * things it depends on is likely to be the broken one. If Redis is down, that
 * must not blank out the Postgres half of the picture, because the Postgres half
 * is where the operator finds out how many students are waiting. That is the
 * number they need most on precisely the day the queue is unreachable.
 *
 * So a broken section reports itself, and everything else still renders.
 */
async function section<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[evaluation-ops] overview section '${name}' failed:`, err)
    return { error: message }
  }
}

export async function getEvaluationOverview() {
  const now = new Date()
  const stuckCutoff = new Date(now.getTime() - STUCK_AFTER_MS)
  const windowStart = new Date(now.getTime() - WINDOW_24H_MS)

  const [
    drift,
    backstopPending,
    review,
    jobs,
    byClass,
    topErrors,
    stuck,
    byTenant,
    queue,
    ocr,
    reconcilerSchedule,
  ] = await Promise.all([
      // This one talks to Redis, which is usually the first thing to break in
      // the kind of incident this page exists for. Hence the wrapper.
      section('drift', async () => {
        const d = await findDrift()
        return {
          orphans: d.orphans.length,
          expired: d.expired.length,
          unclaimed: d.unclaimed.length,
        }
      }),

      // `pending` — papers the next sweep is about to close out with placeholders.
      // `unclosed` — papers that ARE finished but whose job row still says
      // `failed`, which students read as "AI is reviewing your answer". This
      // should sit at 0; anything else means a paper finished by a route that
      // forgot to close its job. See evaluation.backstop.ts.
      section('backstop', async () => ({
        pending: (await findBackstopCandidates({ limit: 500 })).length,
        unclosed: (await findUnclosedSettledJobs({ limit: 500 })).length,
      })),

      section('review', () => getReviewQueueSummary()),

      section('jobs', async () => {
        const rows = await db
          .select({ status: evaluationJobs.status, n: count() })
          .from(evaluationJobs)
          .groupBy(evaluationJobs.status)
        const byStatus: Record<string, number> = {}
        let total = 0
        for (const r of rows) {
          byStatus[r.status] = r.n
          total += r.n
        }
        return { byStatus, total }
      }),

      // `failure_class` is overwritten on every failure, so this is a snapshot of
      // each job's LATEST try, not a history. That is the useful reading:
      //   `transient` piling up    → an outage is happening right now
      //   `needs_human` piling up  → people are uploading unreadable photos
      section('byClass', () =>
        db
          .select({ failureClass: evaluationJobs.failureClass, n: count() })
          .from(evaluationJobs)
          .where(isNotNull(evaluationJobs.failureClass))
          .groupBy(evaluationJobs.failureClass)
          .orderBy(desc(count())),
      ),

      section('topErrors', () =>
        db
          .select({ code: evaluationJobs.lastErrorCode, n: count() })
          .from(evaluationJobs)
          .where(
            and(
              isNotNull(evaluationJobs.lastErrorCode),
              gte(evaluationJobs.createdAt, windowStart),
            ),
          )
          .groupBy(evaluationJobs.lastErrorCode)
          .orderBy(desc(count()))
          .limit(10),
      ),

      // "Which students have been waiting more than an hour?"
      //
      // Measured from `evaluation_jobs.created_at` — when the student submitted —
      // and NOT from the last attempt. The retries keep resetting that second
      // clock, so a job being retried every 30 minutes forever would never look
      // old, which is exactly backwards.
      section('stuck', () =>
        db
          .select({
            jobId: evaluationJobs.id,
            status: evaluationJobs.status,
            attempts: evaluationJobs.attempts,
            lastErrorCode: evaluationJobs.lastErrorCode,
            failureClass: evaluationJobs.failureClass,
            settledAt: evaluationJobs.settledAt,
            createdAt: evaluationJobs.createdAt,
            tenantId: evaluationJobs.tenantId,
            tenantName: tenants.name,
            examId: examSessions.examId,
            examTitle: exams.title,
          })
          .from(evaluationJobs)
          .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
          .innerJoin(exams, eq(exams.id, examSessions.examId))
          .innerJoin(tenants, eq(tenants.id, evaluationJobs.tenantId))
          .where(
            and(
              ne(evaluationJobs.status, 'completed'),
              lte(evaluationJobs.createdAt, stuckCutoff),
            ),
          )
          .orderBy(evaluationJobs.createdAt)
          .limit(STUCK_LIMIT),
      ),

      // ⚠️ READ `failingNow` CAREFULLY. It counts the state jobs are in RIGHT
      // NOW, not how many failures have ever happened. A job that failed four
      // times and then succeeded counts as healthy here.
      //
      // That is correct for the question this answers — "whose students are stuck
      // right now?" — and wrong for "how unreliable has the engine been today?".
      // It is named `failingNow` so nobody reads it as the second one.
      section('byTenant', () =>
        db
          .select({
            tenantId: evaluationJobs.tenantId,
            tenantName: tenants.name,
            total: count(),
            failingNow: sql<number>`count(*) filter (where ${evaluationJobs.status} = 'failed')::int`,
          })
          .from(evaluationJobs)
          .innerJoin(tenants, eq(tenants.id, evaluationJobs.tenantId))
          .where(gte(evaluationJobs.createdAt, windowStart))
          .groupBy(evaluationJobs.tenantId, tenants.name)
          .orderBy(desc(sql`count(*) filter (where ${evaluationJobs.status} = 'failed')`))
          .limit(20),
      ),

      section('queue', () => getEvaluationQueue().getJobCounts()),

      section('ocrCache', async () => {
        const [row] = await db
          .select({
            images: count(),
            hits: sql<number>`coalesce(sum(${ocrCache.hits}), 0)::int`,
          })
          .from(ocrCache)
        return { images: row?.images ?? 0, hits: row?.hits ?? 0 }
      }),

      // IS THE REPAIR SWEEP ITSELF STILL RUNNING?
      //
      // `drift: 0` is only good news if something is still checking. A Redis
      // flush deletes the repeat schedule without dropping the connection, so
      // the worker keeps looking perfectly healthy and nothing else on this page
      // would tell you otherwise.
      //
      // This is not hypothetical — it was found in testing: seven stranded jobs,
      // a worker reporting itself healthy, and no sweep running at all.
      section('reconcilerSchedule', () => getReconcilerScheduleHealth()),
    ])

  return {
    generatedAt: now.toISOString(),
    /** The system fixes these itself within a minute. A number that stays high
     *  means the reconciler is not working. */
    drift,
    /** Past both retry limits — the next sweep closes these out with a
     *  placeholder 0 and hands them to a person. */
    backstop: backstopPending,
    /** Waiting on a PERSON. Every open review is a teacher who cannot publish. */
    review,
    jobs,
    failures: { byClass, topErrors24h: topErrors, byTenant24h: byTenant, stuck },
    queue,
    ocrCache: ocr,
    /** `scheduled: false` means nothing is repairing anything and every number
     *  above this line is out of date. Check this first. */
    reconcilerSchedule,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OPERATOR'S WORKING LIST — one row per JOB (i.e. per student's paper).
//
// WHY THIS EXISTS WHEN THERE IS ALREADY A REVIEW QUEUE:
// The review queue in evaluation.review.ts lists flagged ANSWERS, and those rows
// only come into existence when the backstop closes a session out. So a job that
// fails as `needs_human` on its third try has NO flagged answer for the next six
// hours — and never gets one at all if its session has already moved past
// `submitted`, or if the close-out wrote no placeholders.
//
// During that whole window the failure was visible on the overview (a `1` under
// `needs_human`) and completely impossible to act on, because the only way to
// reach the retry button went through an answer id that did not exist yet. That
// is a screen that shows you the problem and hides the tool.
//
// This is the missing half. It lists the same trouble, but addressed the way the
// repair tool is addressed — by `jobId`, which is what `force-retry` takes.
//
//   the overview answers  "is this one bad photo, or an outage?"
//   this list answers     "which papers need me, and what can I do about each?"
//
// It is a separate paged, filterable route rather than another key on the
// overview, because the overview is a fixed-size snapshot polled on a timer, and
// this is a backlog someone works through page by page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which session states still have a job worth repairing.
 *
 * `submitted` — a paper still waiting for its marks. Obvious.
 * `evaluated` — less obvious, and it must stay in this list: when the backstop
 *               closes a session out, it sets the session to `evaluated` and
 *               leaves the flagged answers behind. Those are exactly the ones an
 *               operator has to finish. Dropping `evaluated` would hide the
 *               backstop's own output from the screen built to clear it.
 */
const ACTIONABLE_SESSION_STATUSES = ['submitted', 'evaluated']

export interface ActionableJob {
  jobId: string
  sessionId: string
  status: string
  attempts: number
  /** The full error message. The panel keeps it collapsed under the code. */
  error: string | null
  lastErrorCode: string | null
  failureClass: string | null
  nextRetryAt: Date | null
  leaseExpiresAt: Date | null
  settledAt: Date | null
  createdAt: Date
  tenantId: string
  tenantName: string
  examId: string
  examTitle: string
  studentName: string
  sessionStatus: string
  /** How many answers on this job are already flagged for a person. It is 0
   *  until the backstop has run on it. */
  flaggedAnswers: number
  /** The id the panel links to so an operator can open the review screen.
   *  Empty while nothing is flagged yet. */
  firstFlaggedResultId: string | null
}

/**
 * Will the backstop take care of this job by itself, and if so, when?
 *
 * Returns a date, or null meaning "no automatic help is coming — this one is
 * yours to sort out". Null happens when the job is not `failed`, or has already
 * been closed out, or its session has moved on.
 *
 * WHY IT IS CALCULATED HERE rather than written as text in the UI: the number an
 * operator needs before deciding to step in is "how long until the machine
 * handles this?". It is worked out from the same two limits
 * `findBackstopCandidates` filters on, so it stays correct automatically. A
 * hand-written "about six hours" in the interface is the sentence that goes
 * stale the day someone changes the limit.
 */
function backstopEta(job: {
  status: string
  attempts: number
  failureClass: string | null
  settledAt: Date | null
  createdAt: Date
  sessionStatus: string
}): Date | null {
  if (job.status !== 'failed') return null
  if (job.settledAt !== null) return null
  if (job.sessionStatus !== 'submitted') return null

  const eligibleByClass =
    job.failureClass === 'needs_human' ||
    job.failureClass === 'permanent' ||
    job.attempts >= BACKSTOP_MAX_ATTEMPTS
  if (!eligibleByClass) return null

  return new Date(job.createdAt.getTime() + BACKSTOP_AFTER_MS)
}

export interface ActionableJobRow extends ActionableJob {
  /** When the backstop will close this out on its own, or null if it never will. */
  backstopEta: Date | null
}

/**
 * List the jobs that have not finished cleanly, oldest first.
 *
 * Spans every coaching, like everything else on this internal surface.
 *
 * Oldest first for the same reason as the review queue: every row is a student
 * waiting for a mark, and the fair way to clear a queue of people is the order
 * they joined it.
 *
 * `completed` jobs are left out unless someone explicitly filters for them — a
 * finished job is not work.
 */
export async function listActionableJobs(
  opts: {
    status?: string
    failureClass?: string
    tenantId?: string
    limit?: number
    offset?: number
  } = {},
): Promise<{ items: ActionableJobRow[]; total: number }> {
  const where = and(
    opts.status ? eq(evaluationJobs.status, opts.status) : ne(evaluationJobs.status, 'completed'),
    opts.failureClass ? eq(evaluationJobs.failureClass, opts.failureClass) : undefined,
    opts.tenantId ? eq(evaluationJobs.tenantId, opts.tenantId) : undefined,
    // A job whose session was abandoned, or is still being written, is not a
    // repair task — re-running it would grade a paper nobody ever submitted.
    inArray(examSessions.status, ACTIONABLE_SESSION_STATUSES),
  )

  // These two counts are written as small sub-queries rather than as another
  // join with a GROUP BY. The main query already pulls from five tables, and
  // grouping it would force every single selected column into the GROUP BY
  // clause just to produce one number.
  const flagged = sql<number>`(
    select count(*) from ${questionResults}
    where ${questionResults.jobId} = ${evaluationJobs.id}
      and ${questionResults.reviewStatus} = 'needs_human'
  )::int`

  const firstFlagged = sql<string | null>`(
    select ${questionResults.id} from ${questionResults}
    where ${questionResults.jobId} = ${evaluationJobs.id}
      and ${questionResults.reviewStatus} = 'needs_human'
    limit 1
  )`

  const rows = await db
    .select({
      jobId: evaluationJobs.id,
      sessionId: evaluationJobs.sessionId,
      status: evaluationJobs.status,
      attempts: evaluationJobs.attempts,
      error: evaluationJobs.error,
      lastErrorCode: evaluationJobs.lastErrorCode,
      failureClass: evaluationJobs.failureClass,
      nextRetryAt: evaluationJobs.nextRetryAt,
      leaseExpiresAt: evaluationJobs.leaseExpiresAt,
      settledAt: evaluationJobs.settledAt,
      createdAt: evaluationJobs.createdAt,
      tenantId: evaluationJobs.tenantId,
      tenantName: tenants.name,
      examId: examSessions.examId,
      examTitle: exams.title,
      studentName: users.name,
      sessionStatus: examSessions.status,
      flaggedAnswers: flagged,
      firstFlaggedResultId: firstFlagged,
    })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(tenants, eq(tenants.id, evaluationJobs.tenantId))
    .innerJoin(users, eq(users.id, examSessions.studentId))
    .where(where)
    .orderBy(asc(evaluationJobs.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)

  const [totalRow] = await db
    .select({ n: count() })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(where)

  return {
    items: rows.map((r) => ({ ...r, backstopEta: backstopEta(r) })),
    total: totalRow?.n ?? 0,
  }
}

export interface ForceRetryResult {
  jobId: string
  previousStatus: string
  /** True if a worker was still actively holding this job — the retry is now
   *  running alongside it. Reported so a genuine double-run is visible rather
   *  than a surprise. */
  leaseWasLive: boolean
  /** Deliberately unchanged by this call. See the note below. */
  attempts: number
  /** How many answers on this job are flagged for a person — i.e. what a
   *  successful re-run is expected to clear. */
  flaggedAnswers: number
}

/**
 * Put one job back on the queue by hand.
 *
 * THE OPERATOR'S OTHER TOOL. `overrideQuestionResult` is "type in the score
 * yourself"; this one is "the photo is fine, the engine was broken, just run it
 * again" — and it is the one to try FIRST, because a successful re-grade clears
 * the flag, clears `settled_at` and unlocks the teacher's publish button without
 * anybody having had to read a student's handwriting.
 *
 * It is the ONLY manual retry left in the product. The teacher-facing version was
 * deleted along with its routes and its button. The four rules below were written
 * against that old endpoint, and each is kept because this one still has to
 * honour it:
 *
 *   1. **IT WORKS ACROSS COACHINGS.** There is no tenant filter. The operator
 *      works a queue that spans coachings and cannot be expected to know which
 *      one a job id belongs to.
 *
 *   2. **IT DOES NOT REFUSE A `processing` JOB.** The old version returned 409
 *      there. That was right for a teacher and useless for the person cleaning up
 *      after a worker that died holding the job. Running a job twice is safe
 *      (the worker skips graded questions, and reading is cached), so the risk is
 *      affordable — and `leaseWasLive` in the response says when it happened.
 *
 *   3. **IT KEEPS THE ERROR HISTORY.** The old version blanked `error`,
 *      `last_error_code` and `failure_class`. This does not. Wiping the diagnosis
 *      on the way to re-running is how a recurring problem becomes invisible, and
 *      this is the very screen built to see it. The worker overwrites those
 *      columns with its next result anyway.
 *
 *   4. **IT DOES NOT RESET `attempts` TO 0.** One force-retry is one attempt, on
 *      purpose. If the photo really is unreadable, `classifyFailure` parks it
 *      straight back at `needs_human` instead of granting it 50 fresh tries.
 *      Resetting the count here is what would make a blank page immortal.
 *
 * `settled_at` is also left alone. The worker clears it on success; if the re-run
 * fails, the backstop must still see this job as already closed out, or it would
 * close the same session a second time.
 */
export async function forceRetryJob(jobId: string): Promise<ForceRetryResult> {
  const [job] = await db
    .select()
    .from(evaluationJobs)
    .where(eq(evaluationJobs.id, jobId))
    .limit(1)
  if (!job) throw Errors.NOT_FOUND('Evaluation job')

  const [flagged] = await db
    .select({ n: count() })
    .from(questionResults)
    .where(
      and(eq(questionResults.jobId, jobId), eq(questionResults.reviewStatus, 'needs_human')),
    )

  const leaseWasLive =
    job.status === 'processing' &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt.getTime() > Date.now()

  await db
    .update(evaluationJobs)
    .set({
      status: 'pending',
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      leaseExpiresAt: null,
    })
    .where(eq(evaluationJobs.id, jobId))

  // Database first, queue second — the same order the reconciler uses, for the
  // same reason. If adding to the queue fails here, what is left behind is a
  // `pending` row with no queue entry, which is exactly the case the reconciler
  // already repairs. So the failure fixes itself within a minute instead of
  // stranding the job.
  await getEvaluationQueue().add(
    'evaluate-session',
    { jobId: job.id, sessionId: job.sessionId, tenantId: job.tenantId },
    EVALUATION_JOB_OPTS,
  )

  return {
    jobId,
    previousStatus: job.status,
    leaseWasLive,
    attempts: job.attempts,
    flaggedAnswers: flagged?.n ?? 0,
  }
}
