import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { evaluationJobs } from '@modules/evaluation/evaluation.schema.js'
import {
  forceRetryJob,
  getEvaluationOverview,
  listActionableJobs,
} from '@modules/evaluation/evaluation.ops.js'
import { getEvaluationQueue } from '@modules/evaluation/evaluation.service.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createTestExam,
  createTestQuestion,
  createTestSession,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — the operator's read model and force-retry.
//
// Two properties carry most of the weight here and neither is visible from the
// happy path: that the overview keeps rendering when Redis is gone (the incident
// it exists for is frequently the incident that broke Redis), and that a
// force-retry preserves the three things the reconciler also refuses to touch.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000

async function seedJob(opts: {
  status?: 'pending' | 'processing' | 'completed' | 'failed'
  attempts?: number
  ageMs?: number
  leaseExpiresAt?: Date | null
  settledAt?: Date | null
  lastErrorCode?: string | null
  failureClass?: string | null
} = {}) {
  const { tenant, teacher, student } = await seedTenantWithUsers()
  const exam = await createTestExam({
    tenantId: tenant.id,
    createdBy: teacher.id,
    status: 'under_evaluation',
  })
  const question = await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'submitted',
  })
  const job = await createEvaluationJob({
    sessionId: session.id,
    tenantId: tenant.id,
    status: opts.status ?? 'failed',
  })

  await db
    .update(evaluationJobs)
    .set({
      attempts: opts.attempts ?? 7,
      lastErrorCode: opts.lastErrorCode ?? 'ENGINE_TIMEOUT',
      failureClass: opts.failureClass ?? 'transient',
      error: 'engine timed out after 120000ms',
      leaseExpiresAt: opts.leaseExpiresAt ?? null,
      settledAt: opts.settledAt ?? null,
      nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(Date.now() - (opts.ageMs ?? 0)),
    })
    .where(eq(evaluationJobs.id, job.id))

  return { tenant, exam, question, session, job }
}

const reread = async (jobId: string) => {
  const [row] = await db.select().from(evaluationJobs).where(eq(evaluationJobs.id, jobId))
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('forceRetryJob — the reviewer\'s other tool', () => {
  it('resets a failed job to pending and re-enqueues it', async () => {
    const { job } = await seedJob({ status: 'failed' })

    const result = await forceRetryJob(job.id)

    expect(result.previousStatus).toBe('failed')
    const row = await reread(job.id)
    expect(row.status).toBe('pending')
    expect(row.nextRetryAt).toBeNull()
    expect(row.leaseExpiresAt).toBeNull()
    expect(getEvaluationQueue().add).toHaveBeenCalledTimes(1)
  })

  it('does NOT reset attempts — one force-retry is one attempt', async () => {
    // Resetting the count here is what would make a genuinely blank page immortal:
    // classifyFailure would grant it a fresh ladder on every operator click
    // instead of parking it straight back at needs_human.
    const { job } = await seedJob({ attempts: 30 })

    const result = await forceRetryJob(job.id)

    expect(result.attempts).toBe(30)
    expect((await reread(job.id)).attempts).toBe(30)
  })

  it('keeps the error trail, unlike the retry it replaced', async () => {
    // The old tenant-facing retry nulled these. Wiping the diagnosis on the way
    // to re-running is how
    // a recurring failure becomes invisible — and this is the surface built to see it.
    const { job } = await seedJob({ lastErrorCode: 'ENGINE_UNREACHABLE' })

    await forceRetryJob(job.id)

    const row = await reread(job.id)
    expect(row.lastErrorCode).toBe('ENGINE_UNREACHABLE')
    expect(row.failureClass).toBe('transient')
    expect(row.error).toContain('engine timed out')
  })

  it('leaves settled_at alone so the backstop cannot settle the session twice', async () => {
    const settledAt = new Date(Date.now() - HOUR)
    const { job } = await seedJob({ settledAt })

    await forceRetryJob(job.id)

    expect((await reread(job.id)).settledAt).not.toBeNull()
  })

  it('ignores the processing guard, and reports that it raced a live lease', async () => {
    const { job } = await seedJob({
      status: 'processing',
      leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })

    const result = await forceRetryJob(job.id)

    expect(result.leaseWasLive).toBe(true)
    expect((await reread(job.id)).status).toBe('pending')
  })

  it('reports a dead lease as not live', async () => {
    const { job } = await seedJob({
      status: 'processing',
      leaseExpiresAt: new Date(Date.now() - 5 * 60 * 1000),
    })

    expect((await forceRetryJob(job.id)).leaseWasLive).toBe(false)
  })

  it('counts the flagged answers the re-run is expected to clear', async () => {
    const { job, question } = await seedJob()
    await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 0,
      maxScore: 10,
      imageUrl: 'https://cdn.test/a.jpg',
      reviewStatus: 'needs_human',
    })

    expect((await forceRetryJob(job.id)).flaggedAnswers).toBe(1)
  })

  it('404s on an unknown job', async () => {
    await expect(
      forceRetryJob('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('getEvaluationOverview', () => {
  it('returns every section', async () => {
    await seedJob()

    const o = await getEvaluationOverview()

    expect(o.generatedAt).toBeTruthy()
    for (const key of ['drift', 'backstop', 'review', 'jobs', 'queue', 'ocrCache'] as const) {
      expect(o).toHaveProperty(key)
      expect(o[key]).not.toHaveProperty('error')
    }
    expect(o.failures).toHaveProperty('byClass')
    expect(o.failures).toHaveProperty('topErrors24h')
    expect(o.failures).toHaveProperty('byTenant24h')
    expect(o.failures).toHaveProperty('stuck')
  })

  it('CRITICAL: a dead queue degrades only its own sections', async () => {
    // The whole point. Redis being down is a common cause of the incident this
    // page is opened for, and the Postgres half — how many students are waiting —
    // is exactly what the operator needs on that day. A single try/catch around
    // the whole handler would return a 500 and tell them nothing.
    await seedJob()
    const queue = getEvaluationQueue()
    vi.mocked(queue.getJobCounts).mockRejectedValueOnce(new Error('Redis unreachable'))
    vi.mocked(queue.getJobs).mockRejectedValueOnce(new Error('Redis unreachable'))

    const o = await getEvaluationOverview()

    expect(o.queue).toEqual({ error: 'Redis unreachable' })
    expect(o.drift).toEqual({ error: 'Redis unreachable' })
    // ...and the half that does not need Redis is intact.
    expect(o.jobs).not.toHaveProperty('error')
    expect((o.jobs as { total: number }).total).toBeGreaterThan(0)
    expect(o.review).not.toHaveProperty('error')
  })

  it('counts jobs by status', async () => {
    await seedJob({ status: 'failed' })
    await seedJob({ status: 'completed' })

    const jobs = (await getEvaluationOverview()).jobs as {
      byStatus: Record<string, number>
      total: number
    }

    expect(jobs.byStatus.failed).toBeGreaterThanOrEqual(1)
    expect(jobs.byStatus.completed).toBeGreaterThanOrEqual(1)
  })

  it('lists an unfinished job older than an hour as stuck, and not a fresh one', async () => {
    const { job: old } = await seedJob({ status: 'failed', ageMs: 3 * HOUR })
    const { job: fresh } = await seedJob({ status: 'failed', ageMs: 0 })

    const stuck = (await getEvaluationOverview()).failures.stuck as Array<{ jobId: string }>
    const ids = stuck.map((s) => s.jobId)

    expect(ids).toContain(old.id)
    expect(ids).not.toContain(fresh.id)
  })

  it('does not call a completed job stuck, however old', async () => {
    const { job } = await seedJob({ status: 'completed', ageMs: 10 * HOUR })

    const stuck = (await getEvaluationOverview()).failures.stuck as Array<{ jobId: string }>

    expect(stuck.map((s) => s.jobId)).not.toContain(job.id)
  })

  it('groups failures by class and surfaces the top error codes', async () => {
    await seedJob({ failureClass: 'needs_human', lastErrorCode: 'OCR_EMPTY' })

    const { byClass, topErrors24h } = (await getEvaluationOverview()).failures as {
      byClass: Array<{ failureClass: string | null; n: number }>
      topErrors24h: Array<{ code: string | null; n: number }>
    }

    expect(byClass.some((c) => c.failureClass === 'needs_human')).toBe(true)
    expect(topErrors24h.some((e) => e.code === 'OCR_EMPTY')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The gap this list was added to close.
//
// A `needs_human` job is terminal after three attempts but the backstop will not
// settle it for six hours, and only settling writes the flagged `question_results`
// row the review queue is keyed on. So for those six hours the failure was real,
// visible as a count on the overview, and unreachable by every action the panel
// had — `forceRetryJob` takes a jobId and nothing on screen carried one.
//
// These tests pin the property that fixes it: a job is actionable from the moment
// it fails, not from the moment an answer gets flagged.
// ─────────────────────────────────────────────────────────────────────────────

describe('listActionableJobs', () => {
  it('lists a needs_human job that has no flagged answer yet — the six-hour blind spot', async () => {
    const { job } = await seedJob({
      status: 'failed',
      failureClass: 'needs_human',
      lastErrorCode: 'OCR_EMPTY',
      attempts: 3,
      ageMs: 5 * 60 * 1000,
    })

    const { items } = await listActionableJobs({ failureClass: 'needs_human' })
    const row = items.find((i) => i.jobId === job.id)

    expect(row).toBeDefined()
    // The exact state that made it invisible: nothing to review, and yet here it is.
    expect(row!.flaggedAnswers).toBe(0)
    expect(row!.firstFlaggedResultId).toBeNull()
    // And the row carries what the operator has to decide with.
    expect(row!.lastErrorCode).toBe('OCR_EMPTY')
    expect(row!.backstopEta).toBeInstanceOf(Date)
  })

  it('excludes completed jobs unless asked for them by name', async () => {
    const { job } = await seedJob({ status: 'completed' })

    const unfiltered = await listActionableJobs()
    expect(unfiltered.items.map((i) => i.jobId)).not.toContain(job.id)

    const asked = await listActionableJobs({ status: 'completed' })
    expect(asked.items.map((i) => i.jobId)).toContain(job.id)
  })

  it('reports no backstop ETA for a job the sweep will never pick up', async () => {
    // Already settled: the backstop has had its turn, so this one is the
    // operator's or nobody's. The UI says so rather than implying a rescue.
    const { job } = await seedJob({
      status: 'failed',
      failureClass: 'needs_human',
      settledAt: new Date(),
    })

    const { items } = await listActionableJobs()

    expect(items.find((i) => i.jobId === job.id)!.backstopEta).toBeNull()
  })

  it('links straight to the review screen once an answer is flagged', async () => {
    const { job, question } = await seedJob({ status: 'failed', failureClass: 'needs_human' })
    const result = await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 0,
      maxScore: 10,
      imageUrl: 'https://example.test/answer.jpg',
      reviewStatus: 'needs_human',
    })

    const { items } = await listActionableJobs()
    const row = items.find((i) => i.jobId === job.id)!

    expect(row.flaggedAnswers).toBe(1)
    expect(row.firstFlaggedResultId).toBe(result.id)
  })
})
