import { describe, it, expect, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { examSessions } from '@modules/exam-session/exam-session.schema.js'
import { evaluationJobs, questionResults } from '@modules/evaluation/evaluation.schema.js'
import { getEvaluationQueue } from '@modules/evaluation/evaluation.service.js'
import {
  findDrift,
  getReconcilerQueue,
  getReconcilerScheduleHealth,
  runReconcilerTick,
} from '@modules/evaluation/evaluation.reconciler.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createTestExam,
  createTestQuestion,
  createTestSession,
  createTestUser,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// The reconciler is the only thing standing between "a worker died" and "this
// cohort's results never come out". Every test here is a stall the system could
// not previously escape, so the assertions are all some form of "did the row
// become runnable again?" — and, just as importantly, "did we leave alone the
// rows that must stay put?".
//
// The queue is the mock from test/setup.ts. `getJobs` returning [] is the
// default and means "BullMQ has forgotten everything", which is exactly the
// orphan condition; tests that need a live queue entry stub it explicitly.

const queue = getEvaluationQueue() as unknown as { add: Mock; getJobs: Mock }

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
const minutesAhead = (n: number) => new Date(Date.now() + n * 60_000)

beforeEach(() => {
  queue.add.mockClear()
  queue.getJobs.mockReset().mockResolvedValue([])
})

/** Pretend BullMQ still has a live entry for these DB job ids. */
function queueHolds(...jobIds: string[]) {
  queue.getJobs.mockResolvedValue(jobIds.map((jobId) => ({ data: { jobId } })))
}

async function patchJob(jobId: string, fields: Partial<typeof evaluationJobs.$inferInsert>) {
  await db.update(evaluationJobs).set(fields).where(eq(evaluationJobs.id, jobId))
}

async function jobRow(jobId: string) {
  const [row] = await db.select().from(evaluationJobs).where(eq(evaluationJobs.id, jobId))
  return row
}

/** A tenant + exam + one submitted session, the substrate for every case below. */
async function seedSubmittedSession() {
  const { tenant, owner, student } = await seedTenantWithUsers()
  const exam = await createTestExam({ tenantId: tenant.id, createdBy: owner.id })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'submitted',
  })
  return { tenant, owner, student, exam, session }
}

describe('reconciler — expired lease (stall path #3)', () => {
  it('reclaims a `processing` job whose worker died and puts it back on the queue', async () => {
    // The fixture `eval:fixture -- --stuck` reproduces, in prose: claimed 45
    // minutes ago, lease lapsed 35 minutes ago, no queue entry. Before Phase 4
    // nothing in the system could clear this — even `retryJob` answered 409
    // because the row still claimed to be running.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'processing',
    })
    await patchJob(job.id, {
      attempts: 1,
      startedAt: minutesAgo(45),
      leaseExpiresAt: minutesAgo(35),
    })

    const drift = await findDrift()
    expect(drift.expired.map((j) => j.id)).toEqual([job.id])

    const counts = await runReconcilerTick()
    expect(counts.reclaimed).toBe(1)

    const row = await jobRow(job.id)
    expect(row.status).toBe('pending')
    expect(row.leaseExpiresAt).toBeNull()
    expect(queue.add).toHaveBeenCalledTimes(1)
    expect(queue.add.mock.calls[0][1]).toMatchObject({
      jobId: job.id,
      sessionId: session.id,
      tenantId: tenant.id,
    })
  })

  it('treats a `processing` row with no lease at all as abandoned', async () => {
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'processing',
    })
    await patchJob(job.id, { startedAt: minutesAgo(20), leaseExpiresAt: null })

    await runReconcilerTick()
    expect((await jobRow(job.id)).status).toBe('pending')
  })

  it('leaves a live lease alone — a long paper is not a dead worker', async () => {
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'processing',
    })
    await patchJob(job.id, { startedAt: minutesAgo(2), leaseExpiresAt: minutesAhead(8) })

    const counts = await runReconcilerTick()
    expect(counts.reclaimed).toBe(0)
    expect((await jobRow(job.id)).status).toBe('processing')
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('defers to BullMQ when the queue still holds the job', async () => {
    // A lapsed lease plus a live queue entry means BullMQ's own stalled-job
    // detection still owns the lock. Reclaiming underneath it would run the
    // same paper twice.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'processing',
    })
    await patchJob(job.id, { leaseExpiresAt: minutesAgo(30) })
    queueHolds(job.id)

    const drift = await findDrift()
    expect(drift.expired).toHaveLength(0)

    await runReconcilerTick()
    expect((await jobRow(job.id)).status).toBe('processing')
  })
})

describe('reconciler — orphaned job rows (stall path #4)', () => {
  it('re-enqueues a `pending` row the queue has forgotten', async () => {
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'pending',
    })
    await patchJob(job.id, { createdAt: minutesAgo(10) })

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(1)
    expect(queue.add).toHaveBeenCalledTimes(1)
  })

  it('ignores a just-created `pending` row — the enqueue race window', async () => {
    // enqueueEvaluation inserts the row and *then* adds to BullMQ. A tick
    // landing between those two statements must not enqueue a second copy.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'pending',
    })

    const drift = await findDrift()
    expect(drift.orphans).toHaveLength(0)

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(0)
    expect((await jobRow(job.id)).status).toBe('pending')
  })

  it('re-enqueues a `failed` row whose retry is due but whose queue entry is gone', async () => {
    // The gap the old eval:inspect could not see. Since Phase 2 the DB row sits
    // `failed` *between* attempts while BullMQ holds it in `delayed` — so a
    // failed row with no queue entry is a job whose ladder was cut short.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, {
      attempts: 4,
      lastErrorCode: 'ENGINE_UNREACHABLE',
      failureClass: 'transient',
      nextRetryAt: minutesAgo(1),
    })

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(1)

    const row = await jobRow(job.id)
    expect(row.status).toBe('pending')
    expect(row.nextRetryAt).toBeNull()
  })

  it('leaves a `failed` row whose retry is still in the future', async () => {
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, { failureClass: 'transient', nextRetryAt: minutesAhead(15) })

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(0)
    expect((await jobRow(job.id)).status).toBe('failed')
  })

  it('CRITICAL: never resurrects a terminal job', async () => {
    // `next_retry_at IS NULL` on a failed row is the Phase 2 marker for
    // `permanent` / `needs_human`. Re-running a blank page forever would burn
    // engine calls on an outcome no attempt can change, and — worse — would
    // hide it from the Phase 6 backstop that is supposed to settle it.
    const { tenant, session } = await seedSubmittedSession()
    const needsHuman = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(needsHuman.id, {
      attempts: 3,
      lastErrorCode: 'OCR_EMPTY',
      failureClass: 'needs_human',
      nextRetryAt: null,
    })

    const drift = await findDrift()
    expect(drift.orphans).toHaveLength(0)

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(0)
    expect((await jobRow(needsHuman.id)).status).toBe('failed')
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('CRITICAL: rescues a `transient` job that lost its retry date', async () => {
    // The other half of the rule above, and the one Phase 9 found broken.
    // `next_retry_at IS NULL` means "terminal" only for `permanent` and
    // `needs_human`. On a `transient` row it is a contradiction — "retry me",
    // with nothing saying when — and before this was fixed such a row was
    // invisible to every sweep in the system: not this one (NULLs excluded from
    // the `lte`), not the unclaimed sweep (it has a job row), not the backstop
    // (which needs 30 attempts). 71 of them stranded six exams in
    // `under_evaluation` for 19 hours with every ops counter reading zero.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, {
      attempts: 2,
      lastErrorCode: 'ENGINE_UNREACHABLE',
      failureClass: 'transient',
      nextRetryAt: null,
    })

    const drift = await findDrift()
    expect(drift.orphans).toHaveLength(1)

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(1)
    expect((await jobRow(job.id)).status).toBe('pending')
  })

  it('rescues a `failed` job that was never classified at all', async () => {
    // The other shape only an older writer produces. Same reasoning: a failed
    // row with no class and no date is not a decision anything made, it is a
    // gap, and leaving it alone strands the cohort.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, { attempts: 1, failureClass: null, nextRetryAt: null })

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(1)
    expect((await jobRow(job.id)).status).toBe('pending')
  })

  it('CRITICAL: still never resurrects a `permanent` job', async () => {
    // Guards the widening above from going one class too far. `permanent` means
    // the session or exam is gone; re-enqueuing it forever is the loop the
    // NULL-as-terminal rule exists to prevent.
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, {
      attempts: 1,
      lastErrorCode: 'NOT_FOUND',
      failureClass: 'permanent',
      nextRetryAt: null,
    })

    const drift = await findDrift()
    expect(drift.orphans).toHaveLength(0)

    const counts = await runReconcilerTick()
    expect(counts.requeued).toBe(0)
    expect((await jobRow(job.id)).status).toBe('failed')
  })

  it('never touches a completed job', async () => {
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'completed',
    })
    await patchJob(job.id, { createdAt: minutesAgo(120), completedAt: minutesAgo(119) })

    await runReconcilerTick()
    expect((await jobRow(job.id)).status).toBe('completed')
    expect(queue.add).not.toHaveBeenCalled()
  })
})

describe('reconciler — a repair preserves the work already paid for', () => {
  it('keeps attempts and question_results when re-enqueuing', async () => {
    // Both are load-bearing. `attempts` is what stops a blank page retrying
    // forever (classifyFailure reads it); the result rows are what stop a retry
    // re-OCRing questions it already read. A reconciler that reset either would
    // undo Phases 2 and 3 on every repair.
    const { tenant, exam, session } = await seedSubmittedSession()
    const question = await createTestQuestion({
      examId: exam.id,
      tenantId: tenant.id,
      order: 1,
      type: 'subjective',
    })
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'processing',
    })
    await patchJob(job.id, { attempts: 7, leaseExpiresAt: minutesAgo(30) })
    await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 8,
      maxScore: 10,
      imageUrl: 'https://example.test/answer.jpg',
    })

    await runReconcilerTick()

    const row = await jobRow(job.id)
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(7)

    const results = await db
      .select()
      .from(questionResults)
      .where(eq(questionResults.jobId, job.id))
    expect(results).toHaveLength(1)
    expect(results[0].score).toBe(8)
  })

  it('keeps the error trail so a recurring failure stays diagnosable', async () => {
    const { tenant, session } = await seedSubmittedSession()
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, {
      error: 'engine unreachable',
      lastErrorCode: 'ENGINE_UNREACHABLE',
      failureClass: 'transient',
      nextRetryAt: minutesAgo(1),
    })

    await runReconcilerTick()

    const row = await jobRow(job.id)
    expect(row.lastErrorCode).toBe('ENGINE_UNREACHABLE')
    expect(row.error).toBe('engine unreachable')
  })
})

describe('reconciler — unclaimed sessions', () => {
  it('creates a job row for a submitted session that never got one', async () => {
    const { session } = await seedSubmittedSession()
    await db
      .update(examSessions)
      .set({ submittedAt: minutesAgo(30) })
      .where(eq(examSessions.id, session.id))

    const drift = await findDrift()
    expect(drift.unclaimed.map((s) => s.sessionId)).toEqual([session.id])

    const counts = await runReconcilerTick()
    expect(counts.enqueued).toBe(1)

    const rows = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.sessionId, session.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
  })

  it('ignores a session submitted moments ago', async () => {
    // createTestSession stamps submittedAt = now, i.e. inside the grace window.
    await seedSubmittedSession()

    const counts = await runReconcilerTick()
    expect(counts.enqueued).toBe(0)
  })

  it('does not double-enqueue a session that already has a terminal job', async () => {
    // A session parked at needs_human still reads `submitted`. It has a job row,
    // so it is Phase 6's problem, not a missing-enqueue.
    const { tenant, session } = await seedSubmittedSession()
    await db
      .update(examSessions)
      .set({ submittedAt: minutesAgo(30) })
      .where(eq(examSessions.id, session.id))
    const job = await createEvaluationJob({
      sessionId: session.id,
      tenantId: tenant.id,
      status: 'failed',
    })
    await patchJob(job.id, { failureClass: 'needs_human', nextRetryAt: null })

    const counts = await runReconcilerTick()
    expect(counts.enqueued).toBe(0)

    const rows = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.sessionId, session.id))
    expect(rows).toHaveLength(1)
  })
})

describe('reconciler — storm guard', () => {
  it('caps repairs per tick and drains the rest on later ticks', async () => {
    // A Redis flush during a large exam orphans every job at once. Shoving all
    // of them back at an engine that may itself be the reason they failed turns
    // a recovery into a second outage.
    const { tenant, owner, exam } = await seedSubmittedSession()

    const jobIds: string[] = []
    for (let i = 0; i < 105; i++) {
      const student = await createTestUser({ role: 'student' })
      const session = await createTestSession({
        examId: exam.id,
        studentId: student.id,
        tenantId: tenant.id,
        status: 'submitted',
      })
      const job = await createEvaluationJob({
        sessionId: session.id,
        tenantId: tenant.id,
        status: 'pending',
      })
      await patchJob(job.id, { createdAt: minutesAgo(10) })
      jobIds.push(job.id)
    }
    expect(owner).toBeDefined()

    const first = await runReconcilerTick()
    expect(first.requeued).toBe(100)
    expect(first.capped).toBe(true)

    queue.add.mockClear()
    const second = await runReconcilerTick()
    // The 105 originals minus the 100 already repaired. Repaired rows are back
    // to `pending` with a queue entry the mock does not report, so they look
    // orphaned again — which is why the tick is ordered oldest-first and why
    // this asserts the remainder was reached at all rather than an exact total.
    expect(second.requeued).toBeGreaterThanOrEqual(5)
    expect(jobIds).toHaveLength(105)
  }, 60_000)
})

// ── Is the sweep even scheduled? ──────────────────────────────────────────────
//
// Every test above asks "does the tick do the right thing". Phase 9 found the
// question nobody was asking: whether the tick runs at all. `FLUSHALL` deletes
// the repeat entry and does NOT drop the connection, so ioredis never
// reconnects, nothing throws, and the sweep silently stops forever — while the
// worker process stays up and every drift counter keeps reading a stale zero.
//
// `worker.ts` now re-asserts the schedule on a timer. This reports it, because
// a self-healing mechanism nobody can observe is one refactor away from being a
// broken one.

describe('reconciler schedule health', () => {
  // Deliberately the *reconciler* queue, not the evaluation one — they are
  // separate BullMQ queues and separate mock instances, and mocking the wrong
  // one reads as "nothing is scheduled" no matter what the code does.
  const q = getReconcilerQueue() as unknown as { getJobSchedulers: Mock }

  it('reports `scheduled: false` when the repeat entry is gone', async () => {
    q.getJobSchedulers.mockResolvedValueOnce([])

    const health = await getReconcilerScheduleHealth()
    expect(health.scheduled).toBe(false)
    expect(health.nextRunAt).toBeNull()
  })

  it('reports `scheduled: true` and the next run when it is registered', async () => {
    const next = Date.now() + 30_000
    q.getJobSchedulers.mockResolvedValueOnce([{ name: 'reconciler-tick', next }])

    const health = await getReconcilerScheduleHealth()
    expect(health.scheduled).toBe(true)
    expect(health.nextRunAt).toBe(new Date(next).toISOString())
    expect(health.everyMs).toBeGreaterThan(0)
  })
})
