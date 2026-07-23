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
import { processJob as processEvaluationJob } from './modules/evaluation/evaluation.service.js'
import type { EvaluationJobPayload } from './modules/evaluation/evaluation.types.js'
import {
  EXAM_LIFECYCLE_QUEUE,
  ensureLifecycleSchedule,
  runLifecycleTick,
} from './modules/exam/exam.scheduler.js'

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

// ── Evaluation worker ─────────────────────────────────────────────────────────

const evaluationWorker = new Worker<EvaluationJobPayload>(
  'evaluation',
  async (job) => {
    await processEvaluationJob(job.data)
  },
  { connection },
)

// ── Email delivery worker ─────────────────────────────────────────────────────

const emailWorker = new Worker(
  'notification-email',
  async (job) => {
    const { notificationId, userId, type } = job.data

    const [user, notification] = await Promise.all([
      getUserForDelivery(userId),
      getNotificationById(notificationId),
    ])

    if (!user?.email || !notification) {
      // User has no email or notification was deleted — skip silently
      return
    }

    const template = resolveEmailTemplate(type, {
      recipientName: user.name,
      link: notification.link,
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

// ── SMS delivery worker ───────────────────────────────────────────────────────

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
    const templateId = process.env[`MSG91_${type.toUpperCase()}_TEMPLATE_ID`] ?? env.MSG91_TEMPLATE_ID

    await sendSms({
      to: phone,
      body: notification.body,
      templateId,
      vars: {
        name: user.name,
        ...(notification.metadata as Record<string, string> | undefined ?? {}),
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

// ── Bulk notification worker ──────────────────────────────────────────────────
// Expands a classId to individual student rows, bulk-inserts in-app notifications,
// then enqueues per-user email/SMS jobs.

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

// ── Exam lifecycle worker (time-triggered transitions) ────────────────────────

const lifecycleWorker = new Worker(
  EXAM_LIFECYCLE_QUEUE,
  async () => {
    const result = await runLifecycleTick()
    if (result.started || result.ended || result.completed) {
      console.log(
        `[exam-lifecycle] started=${result.started} ended=${result.ended} completed=${result.completed}`,
      )
    }
  },
  { connection },
)

// Register the once-a-minute repeatable tick on boot.
void ensureLifecycleSchedule().catch((err) =>
  console.error('[exam-lifecycle] failed to register schedule:', err),
)

// ── Shared error logging ──────────────────────────────────────────────────────

for (const worker of [evaluationWorker, emailWorker, smsWorker, bulkWorker, lifecycleWorker]) {
  worker.on('error', (err) => console.error(`[worker:${worker.name}] error:`, err))
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  await Promise.all([
    evaluationWorker.close(),
    emailWorker.close(),
    smsWorker.close(),
    bulkWorker.close(),
    lifecycleWorker.close(),
  ])
  connection.disconnect()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log('[worker] started: evaluation, notification-email, notification-sms, notification-bulk, exam-lifecycle')
