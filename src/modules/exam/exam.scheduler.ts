import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { and, eq, lte, isNotNull, inArray, sql } from 'drizzle-orm'
import { env } from '@config/env.js'
import { db } from '@shared/db.js'
import { exams } from './exam.schema.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { transitionExam } from './exam.service.js'
import { forceSubmitActiveSessions } from '@modules/exam-session/exam-session.service.js'

// Time-triggered exam lifecycle. A repeatable BullMQ job ("tick") runs every
// minute and drives the automatic transitions the PRD requires:
//   scheduled → live              at scheduledAt
//   live → under_evaluation       at endsAt (force-submitting active sessions)
//   results_published → completed once every session is settled
// All transitions go through `transitionExam` with a null (system) actor.

export const EXAM_LIFECYCLE_QUEUE = 'exam-lifecycle'
const TICK_JOB = 'lifecycle-tick'

let _queue: Queue | null = null

export function getExamLifecycleQueue(): Queue {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
    _queue = new Queue(EXAM_LIFECYCLE_QUEUE, { connection })
  }
  return _queue
}

/** Register the once-a-minute repeatable tick. Idempotent (stable repeat key). */
export async function ensureLifecycleSchedule(): Promise<void> {
  await getExamLifecycleQueue().add(
    TICK_JOB,
    {},
    {
      repeat: { every: 60_000 },
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    },
  )
}

/**
 * One sweep of the exam lifecycle. Safe to run concurrently with admin
 * overrides: `transitionExam` rejects any transition that no longer applies, so
 * a race just no-ops. Returns per-bucket counts for logging.
 */
export async function runLifecycleTick(): Promise<{ started: number; ended: number; completed: number }> {
  const now = new Date()
  let started = 0
  let ended = 0
  let completed = 0

  // scheduled → live (start of window)
  const toStart = await db
    .select({ id: exams.id, tenantId: exams.tenantId })
    .from(exams)
    .where(and(eq(exams.status, 'scheduled'), isNotNull(exams.scheduledAt), lte(exams.scheduledAt, now)))
  for (const e of toStart) {
    try {
      await transitionExam({ examId: e.id, tenantId: e.tenantId, to: 'live', actor: null })
      started++
    } catch (err) {
      console.error(`[exam-lifecycle] go-live failed for ${e.id}:`, err)
    }
  }

  // live → under_evaluation (end of window) + drain active sessions
  const toEnd = await db
    .select({ id: exams.id, tenantId: exams.tenantId })
    .from(exams)
    .where(and(eq(exams.status, 'live'), isNotNull(exams.endsAt), lte(exams.endsAt, now)))
  for (const e of toEnd) {
    try {
      await transitionExam({ examId: e.id, tenantId: e.tenantId, to: 'under_evaluation', actor: null })
      await forceSubmitActiveSessions(e.id)
      ended++
    } catch (err) {
      console.error(`[exam-lifecycle] end failed for ${e.id}:`, err)
    }
  }

  // results_published → completed, once no session is still running/awaiting eval
  const published = await db
    .select({ id: exams.id, tenantId: exams.tenantId })
    .from(exams)
    .where(eq(exams.status, 'results_published'))
  for (const e of published) {
    const [{ pending }] = await db
      .select({ pending: sql<number>`count(*)::int` })
      .from(examSessions)
      .where(and(eq(examSessions.examId, e.id), inArray(examSessions.status, ['in_progress', 'submitted'])))
    if (pending > 0) continue
    try {
      await transitionExam({ examId: e.id, tenantId: e.tenantId, to: 'completed', actor: null })
      completed++
    } catch (err) {
      console.error(`[exam-lifecycle] complete failed for ${e.id}:`, err)
    }
  }

  return { started, ended, completed }
}
