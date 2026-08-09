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
//   scheduled → live                    at scheduledAt
//   live → under_evaluation             at endsAt (force-submitting active sessions)
//   under_evaluation → ready_to_publish once every session is settled
//   ready_to_publish → completed        PUBLIC exams only (see below)
// All transitions go through `transitionExam` with a null (system) actor.
//
// The last two used to be one step. Splitting them is what gives the teacher a
// review window: the worker's job ends at "everything is graded", and a human
// decides whether those grades go out. Private exams therefore STOP at
// `ready_to_publish` and wait — deliberately, possibly forever.
//
// Public (marketplace) exams are the exception. They are self-paced, have no
// coaching teacher standing behind them, and already show results as soon as
// they are evaluated (`assertResultsVisible` exempts them). Parking one in
// `ready_to_publish` would mean waiting for a click nobody is going to make, so
// the worker publishes them itself.

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
export async function runLifecycleTick(): Promise<{
  started: number
  ended: number
  readyToPublish: number
  completed: number
}> {
  const now = new Date()
  let started = 0
  let ended = 0
  let readyToPublish = 0
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

  // under_evaluation → ready_to_publish, once no session is still running or
  // awaiting evaluation. `submitted` means "graded objectively, subjective
  // answers still with the AI evaluator", so it counts as pending — an exam is
  // only ready for the teacher's review when every report is final.
  //
  // An exam nobody attempted has zero sessions and so passes immediately; that
  // is correct (there is nothing left to grade), and the teacher's review screen
  // shows an empty roster.
  const evaluating = await db
    .select({ id: exams.id, tenantId: exams.tenantId })
    .from(exams)
    .where(eq(exams.status, 'under_evaluation'))
  for (const e of evaluating) {
    const [{ pending }] = await db
      .select({ pending: sql<number>`count(*)::int` })
      .from(examSessions)
      .where(and(eq(examSessions.examId, e.id), inArray(examSessions.status, ['in_progress', 'submitted'])))
    if (pending > 0) continue
    try {
      await transitionExam({ examId: e.id, tenantId: e.tenantId, to: 'ready_to_publish', actor: null })
      readyToPublish++
    } catch (err) {
      console.error(`[exam-lifecycle] ready-to-publish failed for ${e.id}:`, err)
    }
  }

  // ready_to_publish → completed, PUBLIC exams only. Private exams wait for the
  // teacher's explicit publish (see the header note).
  const autoPublish = await db
    .select({ id: exams.id, tenantId: exams.tenantId })
    .from(exams)
    .where(
      and(
        eq(exams.status, 'ready_to_publish'),
        inArray(exams.visibility, ['public_free', 'public_paid']),
      ),
    )
  for (const e of autoPublish) {
    try {
      await transitionExam({ examId: e.id, tenantId: e.tenantId, to: 'completed', actor: null })
      completed++
    } catch (err) {
      console.error(`[exam-lifecycle] auto-publish failed for ${e.id}:`, err)
    }
  }

  return { started, ended, readyToPublish, completed }
}
