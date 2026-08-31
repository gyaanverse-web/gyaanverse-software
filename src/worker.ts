import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { env } from './config/env.js'
import { sendEmail } from './modules/notification/channels/email.channel.js'
import { sendSms } from './modules/notification/channels/sms.channel.js'
import { resolveEmailTemplate } from './modules/notification/templates/index.js'
import {
  getUserForDelivery,
  getNotificationById,
  recordDelivery,
  dispatchToUsers,
  getClassMemberIds,
} from './modules/notification/notification.service.js'
import type { BulkNotifyPayload } from './modules/notification/notification.types.js'
import { getTenantById } from './modules/tenant/tenant.service.js'
import { notificationLinkUrl } from './shared/urls.js'
import { processJob as processEvaluationJob } from './modules/evaluation/evaluation.service.js'
import { evaluationBackoffStrategy } from './modules/evaluation/evaluation.retry.js'
import type { EvaluationJobPayload } from './modules/evaluation/evaluation.types.js'
import {
  EXAM_LIFECYCLE_QUEUE,
  ensureLifecycleSchedule,
  runLifecycleTick,
} from './modules/exam/exam.scheduler.js'
import {
  EVALUATION_RECONCILER_QUEUE,
  ensureReconcilerSchedule,
  runReconcilerTick,
} from './modules/evaluation/evaluation.reconciler.js'
import {
  closeFinishedSettledJobs,
  runBackstopSweep,
} from './modules/evaluation/evaluation.backstop.js'
import {
  EVALUATION_DIGEST_JOB,
  ensureDigestSchedule,
  sendReviewDigest,
} from './modules/evaluation/evaluation.digest.js'

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

// ── Roles ─────────────────────────────────────────────────────────────────────
//
// Evaluation is the only queue here whose work is measured in minutes rather
// than milliseconds, and the only one whose throughput has to track an external
// AI quota. Running it in the same process as notifications means you cannot add
// grading capacity without also multiplying email senders and duplicating the
// control-plane ticks — so WORKER_ROLE lets the two halves be deployed and
// scaled as separate services off the same image.
//
//   evaluation  the grading queue. Horizontally scalable: run N of these.
//   general     notifications + the two repeatable ticks (lifecycle,
//               reconciler). Effectively a singleton — the ticks are cheap and
//               nothing is gained by running more than one copy.
//   all         both, in one process. The default, and what local dev wants.
//
// The reconciler sits with `general` rather than with `evaluation` on purpose:
// it is a once-a-minute control-plane sweep, not grading capacity, and pinning
// it to the singleton role keeps N grading replicas from each running their own
// copy of a sweep that is only meant to happen once.

const role = env.WORKER_ROLE
const runsEvaluation = role === 'all' || role === 'evaluation'
const runsGeneral = role === 'all' || role === 'general'

if (!runsEvaluation && !runsGeneral) {
  throw new Error(
    `Invalid WORKER_ROLE="${role}" — expected "all", "evaluation" or "general". ` +
      'Refusing to start a worker that would consume nothing.',
  )
}

const workers: Worker[] = []
const started: string[] = []
/** Timers that re-assert the repeatable schedules. Cleared on shutdown. */
const scheduleGuards: NodeJS.Timeout[] = []

// ── Evaluation worker ─────────────────────────────────────────────────────────

if (runsEvaluation) {
  // `backoff: { type: 'custom' }` on the job options resolves to this strategy —
  // capped exponential, so a long engine outage cannot exhaust a job's attempts
  // in the first half-minute. See evaluation.retry.ts.
  //
  // `concurrency` was previously unset, which meant BullMQ's default of one job
  // at a time: a 200-session exam graded strictly in series, each session paying
  // up to EVAL_ENGINE_TIMEOUT_MS per question. Since Phase 8 removes the screen
  // that would have told the teacher anything was slow, "eventually correct" is
  // not enough on its own — it has to finish in a wall-clock a teacher would
  // describe as "processing" rather than as "broken".
  //
  // `limiter` is what keeps that from becoming a different failure. BullMQ
  // enforces it in Redis, so the ceiling is queue-global across every replica
  // rather than per-process — the only version of this that survives scaling the
  // evaluation role horizontally.
  //
  // Note precisely what it counts: **job starts**, not engine calls. One job is
  // one session, and a session makes up to two engine calls per subjective
  // question. The true call rate is therefore roughly
  // `EVAL_RATE_MAX × questions × 2` per window, and EVAL_RATE_MAX has to be set
  // against that, not against the provider's requests-per-minute number
  // directly. A per-call limiter belongs in evaluation.engine.ts if a provider
  // quota ever becomes the binding constraint; the circuit breaker there is the
  // safety net until it does.
  const evaluationWorker = new Worker<EvaluationJobPayload>(
    'evaluation',
    async (job) => {
      await processEvaluationJob(job.data)
    },
    {
      connection,
      concurrency: env.EVAL_WORKER_CONCURRENCY,
      limiter: { max: env.EVAL_RATE_MAX, duration: env.EVAL_RATE_DURATION_MS },
      settings: { backoffStrategy: evaluationBackoffStrategy },
    },
  )

  workers.push(evaluationWorker)
  started.push('evaluation')
}

if (runsGeneral) {
  // ── Email delivery worker ───────────────────────────────────────────────────

  const emailWorker = new Worker(
    'notification-email',
    async (job) => {
      // The review-queue digest rides this queue rather than getting one of its
      // own: it is an email on a schedule, and this is the process that sends
      // email. It branches first because it carries no `notificationId` — it is
      // platform-level, addressed to Gyaanverse staff, and has no in-app
      // counterpart, so the per-user delivery path below would read fields it
      // does not have. See evaluation.digest.ts.
      if (job.name === EVALUATION_DIGEST_JOB) {
        const d = await sendReviewDigest()
        // Silent on the common case (`skipped: 'queue-empty'`). A line every
        // morning saying nothing happened is a line nobody reads by March.
        if (d.sent > 0) console.log(`[evaluation-digest] notified ${d.sent} operator(s), open=${d.open}`)
        return
      }

      const { notificationId, userId, type } = job.data

      const [user, notification] = await Promise.all([
        getUserForDelivery(userId),
        getNotificationById(notificationId),
      ])

      if (!user?.email || !notification) {
        // User has no email or notification was deleted — skip silently
        return
      }

      // `notification.link` is a bare frontend path (correct for the in-app
      // bell's own navigation) — an email needs a full URL, resolved onto the
      // tenant's own subdomain so it matches what the dashboard UI would show.
      const tenant = notification.tenantId ? await getTenantById(notification.tenantId) : null
      const link = notification.link
        ? notificationLinkUrl(notification.link, tenant?.slug ?? null)
        : null

      const template = resolveEmailTemplate(type, {
        recipientName: user.name,
        link,
        ...(notification.metadata ?? {}),
        title: notification.title,
        body: notification.body,
      })

      await sendEmail({ to: user.email, ...template })

      await recordDelivery({
        notificationId,
        userId,
        channel: 'email',
        status: 'sent',
        attempts: job.attemptsMade + 1,
      })
    },
    { connection },
  )

  emailWorker.on('failed', async (job, err) => {
    if (!job) return
    // No `notification_deliveries` row to write — the digest is not addressed to
    // a user of the product. Logged instead, which is where the operator who
    // notices the missing email will look.
    if (job.name === EVALUATION_DIGEST_JOB) {
      console.error(`[evaluation-digest] send failed (attempt ${job.attemptsMade}):`, err.message)
      return
    }
    const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1)
    if (isFinal) {
      await recordDelivery({
        notificationId: job.data.notificationId,
        userId: job.data.userId,
        channel: 'email',
        status: 'failed',
        attempts: job.attemptsMade,
        lastError: err.message,
      })
    }
  })

  // ── SMS delivery worker ─────────────────────────────────────────────────────

  const smsWorker = new Worker(
    'notification-sms',
    async (job) => {
      const { notificationId, userId, type } = job.data

      const [user, notification] = await Promise.all([
        getUserForDelivery(userId),
        getNotificationById(notificationId),
      ])

      if (!user?.phoneNumber || !notification) return

      // Normalize phone: strip leading + so MSG91 receives digits only
      const phone = user.phoneNumber.replace(/^\+/, '')

      // Template ID from env — each notification type that uses SMS needs one
      const templateId =
        process.env[`MSG91_${type.toUpperCase()}_TEMPLATE_ID`] ?? env.MSG91_TEMPLATE_ID

      await sendSms({
        to: phone,
        body: notification.body,
        templateId,
        vars: {
          name: user.name,
          ...((notification.metadata as Record<string, string> | undefined) ?? {}),
        },
      })

      await recordDelivery({
        notificationId,
        userId,
        channel: 'sms',
        status: 'sent',
        attempts: job.attemptsMade + 1,
      })
    },
    { connection },
  )

  smsWorker.on('failed', async (job, err) => {
    if (!job) return
    const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1)
    if (isFinal) {
      await recordDelivery({
        notificationId: job.data.notificationId,
        userId: job.data.userId,
        channel: 'sms',
        status: 'failed',
        attempts: job.attemptsMade,
        lastError: err.message,
      })
    }
  })

  // ── Bulk notification worker ────────────────────────────────────────────────
  // Expands a classId to individual student rows, bulk-inserts in-app
  // notifications, then enqueues per-user email/SMS jobs.

  const bulkWorker = new Worker(
    'notification-bulk',
    async (job) => {
      const payload = job.data as BulkNotifyPayload
      const userIds = await getClassMemberIds(payload.classId)
      if (userIds.length === 0) return

      // Process in chunks of 500 to keep single DB inserts manageable
      const CHUNK = 500
      for (let i = 0; i < userIds.length; i += CHUNK) {
        await dispatchToUsers(userIds.slice(i, i + CHUNK), {
          type: payload.type,
          tenantId: payload.tenantId,
          data: payload.data,
        })
      }
    },
    { connection },
  )

  // ── Exam lifecycle worker (time-triggered transitions) ──────────────────────

  const lifecycleWorker = new Worker(
    EXAM_LIFECYCLE_QUEUE,
    async () => {
      const result = await runLifecycleTick()
      if (result.started || result.ended || result.readyToPublish || result.completed) {
        console.log(
          `[exam-lifecycle] started=${result.started} ended=${result.ended} ` +
            `readyToPublish=${result.readyToPublish} completed=${result.completed}`,
        )
      }
    },
    { connection },
  )

  // Its once-a-minute tick is registered by `assertSchedules` below, together
  // with the reconciler's and the digest's — see the note there for why
  // registering these on boot alone was not enough.

  // ── Evaluation reconciler (self-healing sweeps) ─────────────────────────────
  //
  // Its own queue rather than another branch of runLifecycleTick: this sweep
  // talks to Redis to decide what is drifted, so a Redis hiccup here must not
  // take the exam state machine down with it. Quiet by design — a healthy
  // pipeline logs nothing, so any line at all is worth reading.

  const reconcilerWorker = new Worker(
    EVALUATION_RECONCILER_QUEUE,
    async () => {
      const r = await runReconcilerTick()
      if (r.reclaimed || r.requeued || r.enqueued || r.errors) {
        console.log(
          `[evaluation-reconciler] reclaimed=${r.reclaimed} requeued=${r.requeued} ` +
            `enqueued=${r.enqueued} raced=${r.raced} errors=${r.errors}` +
            (r.capped ? ' (capped — more next tick)' : ''),
        )
      }

      // The backstop rides the reconciler's tick — same 60s cadence, same
      // singleton role — but is deliberately a separate call with its own log
      // prefix. The reconciler puts work BACK; the backstop gives up on it. A
      // line from one is routine, a line from the other means a student's paper
      // is waiting on a person, and collapsing them into one counter would bury
      // the second inside the first.
      //
      // Sequenced after the reconciler, not before: a job the reconciler is
      // about to re-enqueue should get that attempt before anything considers
      // settling it.
      const b = await runBackstopSweep()
      if (b.settled || b.errors) {
        console.warn(
          `[evaluation-backstop] settled=${b.settled} flagged=${b.flagged} ` +
            `raced=${b.raced} errors=${b.errors}` +
            (b.capped ? ' (capped — more next tick)' : ''),
        )
      }

      // The other end of the backstop: settled jobs that have since finished but
      // are still sitting at `failed`, which reads to the student as "AI is
      // reviewing your answer" forever. Runs last because the sweep above is what
      // creates the state it looks for.
      //
      // `overrideQuestionResult` already closes the job the moment an operator
      // clears the last flagged answer, so on a healthy system this finds
      // nothing and logs nothing. It exists for the settle that flagged NOTHING
      // — which has no other route out — and as the backfill for rows stranded
      // before either existed.
      await closeFinishedSettledJobs()
    },
    { connection },
  )

  // ── Keeping the schedules alive ─────────────────────────────────────────────
  //
  // Every repeatable tick above lives entirely in Redis, and registering them
  // once at boot was not enough. Phase 9 found the hole: `FLUSHALL` deletes the
  // repeat entries and **does not drop the connection**, so ioredis never
  // reconnects, nothing throws, no worker restarts — and the reconciler, the
  // lifecycle tick and the digest simply never run again. The process stays
  // alive and healthy-looking while every self-healing guarantee in this module
  // is quietly switched off.
  //
  // So the schedules are re-asserted on a timer rather than assumed. Each
  // `ensure*Schedule` is an `add` with the same repeat options, which produces
  // the same repeat key — a no-op when the entry is there, a repair when it is
  // not. `allSettled` because one failing registration must not skip the others.
  //
  // The `ready` hook is the fast path for an actual failover (reconnect repairs
  // in seconds instead of waiting out the interval). It is deliberately NOT the
  // only mechanism: the failure this exists for produces no connection event at
  // all, so a reconnect-only fix would look right and catch nothing.
  const SCHEDULE_GUARD_MS = 5 * 60_000

  async function assertSchedules(): Promise<void> {
    const results = await Promise.allSettled([
      ensureLifecycleSchedule(),
      ensureReconcilerSchedule(),
      ensureDigestSchedule(),
    ])
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[worker] failed to assert a repeatable schedule:', r.reason)
      }
    }
  }

  void assertSchedules()
  const scheduleGuard = setInterval(() => void assertSchedules(), SCHEDULE_GUARD_MS)
  scheduleGuard.unref()
  connection.on('ready', () => void assertSchedules())
  scheduleGuards.push(scheduleGuard)

  workers.push(emailWorker, smsWorker, bulkWorker, lifecycleWorker, reconcilerWorker)
  started.push(
    'notification-email',
    'notification-sms',
    'notification-bulk',
    EXAM_LIFECYCLE_QUEUE,
    EVALUATION_RECONCILER_QUEUE,
  )
}

// ── Shared error logging ──────────────────────────────────────────────────────

for (const worker of workers) {
  worker.on('error', (err) => console.error(`[worker:${worker.name}] error:`, err))
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  for (const guard of scheduleGuards) clearInterval(guard)
  await Promise.all(workers.map((w) => w.close()))
  connection.disconnect()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log(
  `[worker] role=${role} started: ${started.join(', ')}` +
    (runsEvaluation
      ? ` (evaluation concurrency=${env.EVAL_WORKER_CONCURRENCY}, ` +
        `limit=${env.EVAL_RATE_MAX}/${env.EVAL_RATE_DURATION_MS}ms)`
      : ''),
)
