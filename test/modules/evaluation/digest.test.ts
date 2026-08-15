import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { env } from '@config/env.js'
import { evaluationJobs, questionResults } from '@modules/evaluation/evaluation.schema.js'
import {
  buildReviewDigest,
  getDigestRecipients,
  sendReviewDigest,
} from '@modules/evaluation/evaluation.digest.js'
import { sendEmail } from '@modules/notification/channels/email.channel.js'
import {
  createEvaluationJob,
  createQuestionResult,
  createTestExam,
  createTestQuestion,
  createTestSession,
  createTestUser,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — the push signal.
//
// Two properties carry this file and neither shows up on the happy path:
//
//   - **Silence when the queue is empty.** This is the one that decays quietly.
//     A digest that arrives every morning saying "0 open" gets filtered inside a
//     fortnight, and a filtered alert is worse than no alert because everyone
//     believes it is still working. There is a test named for it.
//   - **Loud when there is work and nobody to do it.** That is the Phase 7
//     discovery recurring — a review queue with no `super_admin` in existence —
//     and it must not present as a quiet successful run.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@modules/notification/channels/email.channel.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}))

const mockSendEmail = vi.mocked(sendEmail)

const HOUR = 60 * 60 * 1000

/** One exam with `flagged` answers parked `needs_human`, as the backstop leaves them. */
async function seedFlagged(opts: { flagged?: number; ageMs?: number; lastErrorCode?: string } = {}) {
  const { tenant, teacher, student } = await seedTenantWithUsers()
  const exam = await createTestExam({
    tenantId: tenant.id,
    createdBy: teacher.id,
    status: 'ready_to_publish',
  })
  const session = await createTestSession({
    examId: exam.id,
    studentId: student.id,
    tenantId: tenant.id,
    status: 'evaluated',
  })
  const job = await createEvaluationJob({
    sessionId: session.id,
    tenantId: tenant.id,
    status: 'failed',
  })

  await db
    .update(evaluationJobs)
    .set({
      attempts: 30,
      lastErrorCode: opts.lastErrorCode ?? 'OCR_EMPTY',
      failureClass: 'needs_human',
      settledAt: new Date(),
      createdAt: new Date(Date.now() - (opts.ageMs ?? 2 * HOUR)),
    })
    .where(eq(evaluationJobs.id, job.id))

  for (let i = 0; i < (opts.flagged ?? 1); i++) {
    const question = await createTestQuestion({ examId: exam.id, tenantId: tenant.id, marks: 10 })
    await createQuestionResult({
      jobId: job.id,
      questionId: question.id,
      score: 0,
      maxScore: 10,
      imageUrl: `https://cdn.test/answer-${i}.jpg`,
      reviewStatus: 'needs_human',
    })
  }

  return { tenant, exam, session, job }
}

const originalDigestEmails = env.OPS_DIGEST_EMAILS

beforeEach(() => {
  vi.clearAllMocks()
  env.OPS_DIGEST_EMAILS = ''
})

afterEach(() => {
  env.OPS_DIGEST_EMAILS = originalDigestEmails
})

describe('buildReviewDigest', () => {
  it('returns null when nothing is waiting on a human', async () => {
    // The rule the whole design rests on: no news is no email.
    expect(await buildReviewDigest()).toBeNull()
  })

  it('returns null when every flagged answer has been resolved', async () => {
    // `resolved` carries a human's score and is as final as anything the AI
    // produces — it must not keep pulling an operator's attention.
    const { job } = await seedFlagged({ flagged: 2 })
    await db
      .update(questionResults)
      .set({ reviewStatus: 'resolved' })
      .where(eq(questionResults.jobId, job.id))

    expect(await buildReviewDigest()).toBeNull()
  })

  it('counts open reviews and breaks them down by code and coaching', async () => {
    const { tenant } = await seedFlagged({ flagged: 2, lastErrorCode: 'OCR_EMPTY' })
    await seedFlagged({ flagged: 1, lastErrorCode: 'ENGINE_TIMEOUT' })

    const digest = await buildReviewDigest()
    expect(digest).not.toBeNull()
    expect(digest!.open).toBe(3)

    const codes = Object.fromEntries(digest!.byCode.map((r) => [r.code, r.n]))
    expect(codes).toEqual({ OCR_EMPTY: 2, ENGINE_TIMEOUT: 1 })

    const first = digest!.byTenant.find((t) => t.tenantName === tenant.name)
    expect(first?.n).toBe(2)
  })

  it('reports the age of the queue head, not of the newest item', async () => {
    await seedFlagged({ ageMs: 3 * HOUR })
    await seedFlagged({ ageMs: 50 * HOUR })

    const digest = await buildReviewDigest()
    // 50h, not 3h — the number that says whether the queue is being worked.
    expect(digest!.oldestWaitingHours).toBeGreaterThanOrEqual(49)
  })

  it('reports an UNKNOWN code rather than dropping a row with no error code', async () => {
    const { job } = await seedFlagged({ flagged: 1 })
    await db
      .update(evaluationJobs)
      .set({ lastErrorCode: null })
      .where(eq(evaluationJobs.id, job.id))

    const digest = await buildReviewDigest()
    expect(digest!.open).toBe(1)
    expect(digest!.byCode).toEqual([{ code: 'UNKNOWN', n: 1 }])
  })
})

describe('getDigestRecipients', () => {
  it('is empty when no operator has been minted', async () => {
    await seedTenantWithUsers()
    expect(await getDigestRecipients()).toEqual([])
  })

  it('resolves super_admins from the live table, ignoring every other role', async () => {
    await createTestUser({ role: 'super_admin', email: 'ops1@gyaanverse.test' })
    await createTestUser({ role: 'super_admin', email: 'ops2@gyaanverse.test' })
    await seedTenantWithUsers()

    expect((await getDigestRecipients()).sort()).toEqual([
      'ops1@gyaanverse.test',
      'ops2@gyaanverse.test',
    ])
  })

  it('ADDS OPS_DIGEST_EMAILS to the operators rather than replacing them', async () => {
    // The trap this guards: pointing the env var at a shared alias must not
    // silently unsubscribe the people who can actually clear the queue.
    await createTestUser({ role: 'super_admin', email: 'ops1@gyaanverse.test' })
    env.OPS_DIGEST_EMAILS = 'alerts@gyaanverse.test, oncall@gyaanverse.test'

    expect((await getDigestRecipients()).sort()).toEqual([
      'alerts@gyaanverse.test',
      'oncall@gyaanverse.test',
      'ops1@gyaanverse.test',
    ])
  })

  it('deduplicates case-insensitively so an operator listed twice is mailed once', async () => {
    await createTestUser({ role: 'super_admin', email: 'ops1@gyaanverse.test' })
    env.OPS_DIGEST_EMAILS = 'OPS1@GYAANVERSE.TEST'

    expect(await getDigestRecipients()).toEqual(['ops1@gyaanverse.test'])
  })
})

describe('sendReviewDigest', () => {
  it('sends NOTHING on a clean queue', async () => {
    await createTestUser({ role: 'super_admin', email: 'ops@gyaanverse.test' })

    const result = await sendReviewDigest()

    expect(result).toEqual({ open: 0, sent: 0, skipped: 'queue-empty' })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('sends one message per recipient, never one with everyone in `to`', async () => {
    // The payload names other coachings by implication; a recipient list is not
    // something to hand every recipient a copy of.
    await createTestUser({ role: 'super_admin', email: 'ops1@gyaanverse.test' })
    await createTestUser({ role: 'super_admin', email: 'ops2@gyaanverse.test' })
    await seedFlagged({ flagged: 2 })

    const result = await sendReviewDigest()

    expect(result.sent).toBe(2)
    expect(result.open).toBe(2)
    expect(mockSendEmail).toHaveBeenCalledTimes(2)
    expect(mockSendEmail.mock.calls.map((c) => c[0].to).sort()).toEqual([
      'ops1@gyaanverse.test',
      'ops2@gyaanverse.test',
    ])
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('2 answers need manual review')
  })

  it('links to the review queue and never blames the coaching', async () => {
    await createTestUser({ role: 'super_admin', email: 'ops@gyaanverse.test' })
    await seedFlagged({ flagged: 1 })

    await sendReviewDigest()

    const html = mockSendEmail.mock.calls[0][0].html
    expect(html).toContain('#/review')
    expect(html).toContain('publish')
  })

  it('escalates the copy once the head of the queue is over a day old', async () => {
    await createTestUser({ role: 'super_admin', email: 'ops@gyaanverse.test' })
    await seedFlagged({ flagged: 1, ageMs: 30 * HOUR })

    await sendReviewDigest()

    expect(mockSendEmail.mock.calls[0][0].html).toContain('disabled publish button')
  })

  it('reports no-recipients loudly instead of returning a quiet success', async () => {
    // Phase 7's founding discovery, recurring: work in the queue and nobody on
    // Earth able to do it. A silent "sent 0" here is indistinguishable from a
    // healthy day, which is the exact failure this whole surface exists to end.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedFlagged({ flagged: 3 })

    const result = await sendReviewDigest()

    expect(result).toEqual({ open: 3, sent: 0, skipped: 'no-recipients' })
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(err.mock.calls[0][0]).toContain('ops:promote')
    err.mockRestore()
  })

  it('does not retry the whole send because one address bounced', async () => {
    // Throwing here would make BullMQ re-run the job and deliver the digest a
    // second time to everyone it already reached.
    await createTestUser({ role: 'super_admin', email: 'good@gyaanverse.test' })
    await createTestUser({ role: 'super_admin', email: 'bad@gyaanverse.test' })
    await seedFlagged({ flagged: 1 })

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSendEmail.mockImplementation(async ({ to }) => {
      if (to === 'bad@gyaanverse.test') throw new Error('550 mailbox unavailable')
    })

    const result = await sendReviewDigest()

    expect(result.sent).toBe(1)
    err.mockRestore()
  })

  it('throws when nobody could be reached, so the job retries', async () => {
    await createTestUser({ role: 'super_admin', email: 'ops@gyaanverse.test' })
    await seedFlagged({ flagged: 1 })
    mockSendEmail.mockRejectedValue(new Error('Resend error: service unavailable'))

    await expect(sendReviewDigest()).rejects.toThrow(/failed for every recipient/)
  })
})
