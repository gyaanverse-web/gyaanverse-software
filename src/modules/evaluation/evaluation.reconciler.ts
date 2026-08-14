import { Queue } from 'bullmq'
import type { JobType } from 'bullmq'
import IORedis from 'ioredis'
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { env } from '@config/env.js'
import { db } from '@shared/db.js'
import { evaluationJobs } from './evaluation.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { EVALUATION_JOB_OPTS } from './evaluation.retry.js'
import { enqueueEvaluation, getEvaluationQueue } from './evaluation.service.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE RECONCILER — the repair crew that runs once a minute.
//
// THE PROBLEM IT SOLVES
// This pipeline keeps its records in two different places:
//   • Postgres  — the `evaluation_jobs` table: the permanent record.
//   • Redis     — the queue: the list of work waiting to be done.
// The retry rules only protect jobs that Redis still remembers. Redis forgets a
// job if the worker process is killed halfway through, if Redis is flushed or
// restarted, if it evicts data under memory pressure, or if a deploy wipes the
// queue. When that happens Postgres still says "this job is waiting" while Redis
// has no record of it — and neither side notices. Somebody has to compare the
// two lists and put back what is missing. That is this file.
//
// WHY IT MATTERS SO MUCH
// An exam only leaves `under_evaluation` once EVERY student's session is
// finished. So one forgotten job does not hold up one student — it holds up the
// whole class, forever, with no way for anyone to fix it from the UI.
//
// Real example: 40 students submit. Redis restarts. All 40 jobs vanish from the
// queue but their rows still sit `pending` in `evaluation_jobs`. Without this
// file, that exam never gets results. With it, the next tick (within 60 seconds)
// notices all 40 and puts them back.
//
// THE THREE PROBLEMS IT LOOKS FOR
//   expired    row says `processing`, but the worker's lease has run out
//              → the worker died mid-job
//   orphan     the job row exists, but the queue has no entry for it
//              → Redis lost it
//   unclaimed  a session is `submitted` but has no row in `evaluation_jobs`
//              → the job was never created in the first place
//
// WHY `findDrift` IS A SEPARATE FUNCTION
// The ops panel and the `eval:inspect` script call it too. That way what an
// operator sees on screen is exactly the same list this file is about to repair.
// If we wrote the "is this stuck?" logic twice, the two copies would disagree
// within a month, and the screen would be lying.
// ─────────────────────────────────────────────────────────────────────────────

export const EVALUATION_RECONCILER_QUEUE = 'evaluation-reconciler'
const TICK_JOB = 'reconciler-tick'
const TICK_EVERY_MS = 60_000

/**
 * A brand-new `pending` row gets 30 seconds of grace before we treat it as lost.
 *
 * WHY: `enqueueEvaluation` does two things in a row — first it INSERTs the row
 * into `evaluation_jobs`, then it adds the job to the queue. There is a gap of a
 * few milliseconds between those two steps. If a reconciler tick happened to run
 * in that gap it would see a row with no queue entry and add a second copy of
 * the same job.
 *
 * A duplicate is not dangerous (the second run finds every question already
 * scored and makes zero AI calls), but it is still wasted work. 30 seconds is
 * far more than that gap ever needs, and a genuinely lost job is still picked up
 * on the next tick or two.
 */
const ORPHAN_GRACE_MS = 30_000

/**
 * A `submitted` session with no job row at all gets 2 minutes before we create
 * one for it.
 *
 * Longer than the 30 seconds above because this sweep CREATES work instead of
 * re-running it, and creating a duplicate job is worse than re-queuing one.
 * The only way to land here is a crash in `submitSession` between saving the
 * session and creating its evaluation job.
 */
const UNCLAIMED_GRACE_MS = 2 * 60_000

/**
 * Never repair more than 100 jobs in a single tick — shared across all three
 * sweeps.
 *
 * WHY: Redis restarting during a 200-student exam produces 200 lost jobs at the
 * same instant. Throwing all 200 at an AI engine that may itself be the thing
 * that just broke turns a recovery into a second outage.
 *
 * Nothing is lost by capping it — the next tick (60 seconds later) takes the
 * rest, oldest first. So a big backlog drains over a few minutes instead of
 * arriving as one spike.
 */
const MAX_REPAIRS_PER_TICK = 100

/** How many rows we LOOK at per sweep. Much higher than the repair cap above so
 *  that the numbers written to the logs stay truthful even when we only fix 100. */
const SCAN_LIMIT = 1_000

/**
 * The queue states that mean "something is still going to run this job".
 *
 * Notice which two are missing: `completed` and `failed`. A job the queue plans
 * to retry sits in `delayed`, never in `failed`. `failed` in the queue means it
 * used up all its tries or was told to stop permanently.
 *
 * So a job row whose only queue entry is a failed one has nothing coming for it,
 * and counting it as an orphan is correct.
 *
 * Only checking live states also keeps this fast: the list is as long as the work
 * actually in progress, not as long as the 10,000 failed jobs we keep for
 * 7 days (see `removeOnFail` in evaluation.retry.ts).
 */
const LIVE_STATES: JobType[] = [
  'waiting',
  'waiting-children',
  'prioritized',
  'active',
  'delayed',
  'paused',
]

const LIVE_SCAN_LIMIT = 10_000

// ── Queue ─────────────────────────────────────────────────────────────────

let _queue: Queue | null = null

export function getReconcilerQueue(): Queue {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
    _queue = new Queue(EVALUATION_RECONCILER_QUEUE, { connection })
  }
  return _queue
}

/**
 * Tell the queue to run one sweep every 60 seconds.
 *
 * Safe to call as many times as you like — the repeat key is always the same, so
 * calling it ten times still gives you one schedule, not ten.
 */
export async function ensureReconcilerSchedule(): Promise<void> {
  await getReconcilerQueue().add(
    TICK_JOB,
    {},
    {
      repeat: { every: TICK_EVERY_MS },
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    },
  )
}

/**
 * Is the 60-second sweep actually scheduled right now?
 *
 * WHY THIS EXISTS: the dangerous failure is not "the reconciler crashed" — a
 * crash writes an error we can see. The dangerous one is "the reconciler is not
 * scheduled at all", which produces no error, no failed job and no log line.
 * A healthy sweep is silent too, so silence alone cannot tell the two apart.
 *
 * This actually happened: a Redis flush deleted the repeat entry, the worker
 * process stayed up and looked perfectly healthy, and jobs quietly piled up.
 *
 * `worker.ts` now re-registers the schedule on a timer, so this should fix
 * itself within a few minutes of any Redis flush. We still report it, because a
 * self-healing mechanism nobody can see is one careless edit away from being a
 * self-healing mechanism that silently stopped working.
 *
 * READING IT: `scheduled: false` is bad. `nextRunAt` sitting more than a minute
 * or two in the past means the re-registering timer is not running either.
 */
export async function getReconcilerScheduleHealth(): Promise<{
  scheduled: boolean
  everyMs: number
  nextRunAt: string | null
}> {
  const schedulers = await getReconcilerQueue().getJobSchedulers(0, 50)
  const mine = schedulers.find((s) => s.name === TICK_JOB) ?? schedulers[0]
  return {
    scheduled: Boolean(mine),
    everyMs: TICK_EVERY_MS,
    nextRunAt: mine?.next ? new Date(mine.next).toISOString() : null,
  }
}

// ── Drift detection ───────────────────────────────────────────────────────

export interface DriftJob {
  id: string
  sessionId: string
  tenantId: string
  status: string
  attempts: number
  nextRetryAt: Date | null
  leaseExpiresAt: Date | null
  createdAt: Date
  examId: string
}

export interface DriftSession {
  sessionId: string
  examId: string
  submittedAt: Date | null
}

export interface DriftReport {
  /** Job rows the queue has forgotten about, but that still need to run. */
  orphans: DriftJob[]
  /** Rows stuck at `processing` because the worker running them died. */
  expired: DriftJob[]
  /** Submitted sessions that never got an `evaluation_jobs` row at all. */
  unclaimed: DriftSession[]
}

/**
 * Compare the `evaluation_jobs` table against the queue and return everything
 * that will never move on its own.
 *
 * READ-ONLY — it changes nothing. Safe to call from a script, a health check, or
 * the sweep itself. Only `runReconcilerTick` below actually repairs anything.
 */
export async function findDrift(opts: { examId?: string } = {}): Promise<DriftReport> {
  const now = new Date()
  const orphanCutoff = new Date(now.getTime() - ORPHAN_GRACE_MS)
  const unclaimedCutoff = new Date(now.getTime() - UNCLAIMED_GRACE_MS)

  const candidates = await db
    .select({
      id: evaluationJobs.id,
      sessionId: evaluationJobs.sessionId,
      tenantId: evaluationJobs.tenantId,
      status: evaluationJobs.status,
      attempts: evaluationJobs.attempts,
      nextRetryAt: evaluationJobs.nextRetryAt,
      leaseExpiresAt: evaluationJobs.leaseExpiresAt,
      createdAt: evaluationJobs.createdAt,
      examId: examSessions.examId,
    })
    .from(evaluationJobs)
    .innerJoin(examSessions, eq(examSessions.id, evaluationJobs.sessionId))
    .where(
      and(
        opts.examId ? eq(examSessions.examId, opts.examId) : undefined,
        or(
          // CASE 1 — a worker picked this up and then died.
          // `lease_expires_at` is a "I am still alive" stamp the worker keeps
          // pushing forward. If it has passed, or was never set at all, nobody
          // is holding this job any more.
          and(
            eq(evaluationJobs.status, 'processing'),
            or(
              isNull(evaluationJobs.leaseExpiresAt),
              lte(evaluationJobs.leaseExpiresAt, now),
            ),
          ),
          // CASE 2 — still sitting at `pending` and older than the 30-second
          // grace window, so this is not the insert-then-enqueue gap.
          and(eq(evaluationJobs.status, 'pending'), lte(evaluationJobs.createdAt, orphanCutoff)),
          // CASE 3 — `failed`, and its next retry time has arrived.
          //
          // IMPORTANT: in SQL, `next_retry_at <= now` does NOT match rows where
          // `next_retry_at` is NULL, and leaving those out is deliberate. A NULL
          // there on a failed row is our marker for "this is finished failing"
          // (`permanent` or `needs_human`) — nobody is coming for it and the
          // reconciler must not drag it back. Do not "simplify" this into a
          // check that accepts every NULL; the narrow exception below is the
          // only safe widening.
          and(
            eq(evaluationJobs.status, 'failed'),
            or(
              lte(evaluationJobs.nextRetryAt, now),
              // ...the exception. That NULL only means "finished" for the two
              // classes above. A row that says `failure_class = 'transient'`
              // with no `next_retry_at` is self-contradictory: "retry me", with
              // nothing saying when.
              //
              // This is not theoretical. 71 such rows were found on the dev
              // database, stranding six exams in `under_evaluation` for 19
              // hours, while the drift count, the backstop count and the ops
              // overview ALL read zero. Nothing could reach them: not this
              // sweep, not the unclaimed sweep (they had a job row), and not
              // the backstop (it needs 30 attempts; these had 1-6).
              //
              // Today's code cannot create that shape — a transient failure
              // always writes `next_retry_at`. An OLD version of the worker can:
              // it wrote `failure_class` without the date. That makes this a
              // deploy hazard, because during every rolling deploy an old
              // instance runs alongside the new one for a minute or two.
              //
              // `failure_class IS NULL` is included for the same reason: a
              // failed row that was never classified is the other shape only an
              // older worker produces. Both are matched by class, so
              // `permanent` and `needs_human` keep meaning "finished".
              and(
                isNull(evaluationJobs.nextRetryAt),
                or(
                  eq(evaluationJobs.failureClass, 'transient'),
                  isNull(evaluationJobs.failureClass),
                ),
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(evaluationJobs.createdAt))
    .limit(SCAN_LIMIT)

  const live = await liveQueueJobIds()

  const orphans: DriftJob[] = []
  const expired: DriftJob[] = []
  for (const job of candidates) {
    // If the queue still has this job, leave it completely alone — the queue is
    // going to run it. Even for a dead worker, the queue's own stalled-job
    // detection handles it better than we can from here, because the queue still
    // holds the lock on it.
    if (live.has(job.id)) continue
    if (job.status === 'processing') expired.push(job)
    else orphans.push(job)
  }

  // This one starts from `exam_sessions`, not from `evaluation_jobs`, and that is
  // the whole point: a session that never got a job row is invisible to every
  // other screen and query in the system — including the candidate query above,
  // which only looks at jobs that exist.
  const unclaimed = await db
    .select({
      sessionId: examSessions.id,
      examId: examSessions.examId,
      submittedAt: examSessions.submittedAt,
    })
    .from(examSessions)
    .where(
      and(
        eq(examSessions.status, 'submitted'),
        opts.examId ? eq(examSessions.examId, opts.examId) : undefined,
        // `submitted_at` can be empty (for example when a session is force-
        // submitted by the system), but `started_at` is always filled in. Fall
        // back to it so a missing timestamp never hides a session from this
        // sweep.
        sql`coalesce(${examSessions.submittedAt}, ${examSessions.startedAt}) <= ${unclaimedCutoff}`,
        sql`not exists (select 1 from evaluation_jobs ej where ej.session_id = ${examSessions.id})`,
      ),
    )
    .orderBy(asc(examSessions.startedAt))
    .limit(SCAN_LIMIT)

  return { orphans, expired, unclaimed }
}

async function liveQueueJobIds(): Promise<Set<string>> {
  const jobs = await getEvaluationQueue().getJobs(LIVE_STATES, 0, LIVE_SCAN_LIMIT)
  const ids = new Set<string>()
  for (const job of jobs) {
    const jobId = (job?.data as { jobId?: string } | undefined)?.jobId
    if (jobId) ids.add(jobId)
  }
  return ids
}

// ── The tick ──────────────────────────────────────────────────────────────

export interface ReconcilerCounts {
  /** Rows taken back from a dead worker and put on the queue again. */
  reclaimed: number
  /** Job rows the queue had forgotten, put back on the queue. */
  requeued: number
  /** Submitted sessions that were given an `evaluation_jobs` row for the first time. */
  enqueued: number
  /** Repairs where a real worker got there first. Normal and fine, NOT errors. */
  raced: number
  /** Repairs that threw an error. They stay broken and are retried next tick. */
  errors: number
  /** True when there was more to fix than the 100-per-tick limit allowed. */
  capped: boolean
}

/**
 * Run ONE repair sweep.
 *
 * Safe to run at the same time as the workers it is repairing, and safe to run
 * twice. Every write below is conditional on the row still having the status it
 * had when we scanned it — so if a real worker grabbed the job in between, the
 * worker wins and our repair quietly does nothing (counted as `raced`).
 *
 * The three sweeps run most-stuck-first. A dead worker's job is the only case
 * with no other rescue anywhere in the system, so it gets the budget first; a
 * forgotten job might still turn out to be in the queue.
 */
export async function runReconcilerTick(): Promise<ReconcilerCounts> {
  const counts: ReconcilerCounts = {
    reclaimed: 0,
    requeued: 0,
    enqueued: 0,
    raced: 0,
    errors: 0,
    capped: false,
  }

  const drift = await findDrift()
  let budget = MAX_REPAIRS_PER_TICK
  const wanted = drift.expired.length + drift.orphans.length + drift.unclaimed.length
  if (wanted > budget) counts.capped = true

  for (const job of drift.expired) {
    if (budget <= 0) break
    budget--
    try {
      if (await requeue(job)) counts.reclaimed++
      else counts.raced++
    } catch (err) {
      counts.errors++
      console.error(`[evaluation-reconciler] reclaim failed for job ${job.id}:`, err)
    }
  }

  for (const job of drift.orphans) {
    if (budget <= 0) break
    budget--
    try {
      if (await requeue(job)) counts.requeued++
      else counts.raced++
    } catch (err) {
      counts.errors++
      console.error(`[evaluation-reconciler] requeue failed for job ${job.id}:`, err)
    }
  }

  for (const session of drift.unclaimed) {
    if (budget <= 0) break
    budget--
    try {
      const result = await enqueueEvaluation(session.sessionId)
      if (result) counts.enqueued++
      else counts.raced++ // the session or its exam was deleted while we worked
    } catch (err) {
      counts.errors++
      console.error(
        `[evaluation-reconciler] enqueue failed for session ${session.sessionId}:`,
        err,
      )
    }
  }

  return counts
}

/**
 * Put an existing job row back on the queue.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *
 *   1. It does not reset `attempts` back to 0.
 *      That count is what decides an unreadable photo has had its three chances.
 *      It lives in Postgres rather than in the queue precisely because repairs
 *      like this one happen outside the queue's own counting. If we reset it
 *      here, a blank photo would be retried forever and never reach a human.
 *
 *   2. It does not delete the `question_results` rows.
 *      Those rows are what make a re-run cheap: the worker skips every question
 *      that already has one, so a job that died on question 8 of 10 only pays
 *      for the last two. Deleting them would mean paying the full AI cost again
 *      on every repair.
 *
 *   3. It does not clear `error`, `last_error_code` or `failure_class`.
 *      Wiping the diagnosis on every automatic repair is exactly how a recurring
 *      problem becomes invisible. The worker overwrites these itself on its next
 *      result anyway.
 *
 * The `status` check in the WHERE clause is the safety catch: between the scan
 * and this write, a real worker may have grabbed the row. If so, this UPDATE
 * matches nothing, we return false, and the worker wins — which is correct.
 */
async function requeue(job: DriftJob): Promise<boolean> {
  const reset = await db
    .update(evaluationJobs)
    .set({
      status: 'pending',
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(evaluationJobs.id, job.id), eq(evaluationJobs.status, job.status)))
    .returning({ id: evaluationJobs.id })

  if (reset.length === 0) return false

  // Database first, queue second — and that order matters. If adding to the
  // queue fails here, what we are left with is a `pending` row with no queue
  // entry, which is exactly the "orphan" case this same file already knows how
  // to fix. So the failure repairs itself on the next tick instead of leaving
  // the job stranded.
  await getEvaluationQueue().add(
    'evaluate-session',
    { jobId: job.id, sessionId: job.sessionId, tenantId: job.tenantId },
    EVALUATION_JOB_OPTS,
  )

  return true
}
