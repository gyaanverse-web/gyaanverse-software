import { asc, eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { env } from '@config/env.js'
import { users } from '@modules/auth/auth.schema.js'
import { sendEmail } from '@modules/notification/channels/email.channel.js'
import { getEmailQueue } from '@modules/notification/notification.queues.js'
import { evaluationJobs, questionResults } from './evaluation.schema.js'
import { findBackstopCandidates } from './evaluation.backstop.js'
import { getReviewQueueSummary } from './evaluation.review.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE DAILY EMAIL THAT TELLS GYANVERSE STAFF THERE IS WORK WAITING.
//
// WHY IT EXISTS
// Every open review is an answer a Gyanverse operator has to grade by hand, and
// behind each one is a teacher looking at a publish button they cannot press for
// a reason we deliberately never explain to them. So the number of open reviews
// that never goes down is the single most important thing to watch in this whole
// module.
//
// A screen only helps someone who opens it. The review queue lives inside an
// internal panel on a domain nobody visits on a good day — exactly the kind of
// page that goes unread for a week and then explains an angry phone call. So the
// count goes TO the operator instead of waiting to be found.
//
// TWO RULES, AND THEY ARE THE ENTIRE DESIGN:
//
//   1. **NOTHING IS SENT WHEN THE COUNT IS 0.** A daily "all clear" is how a
//      daily email turns into a filter rule, and a filtered alert is worse than
//      no alert — it is a warning system everybody believes is working. The
//      inbox stays empty until there is genuinely something to do in it.
//
//   2. **IT GOES TO THE `super_admin` ACCOUNTS**, looked up fresh at send time —
//      i.e. exactly the people who can actually act on it. The
//      `OPS_DIGEST_EMAILS` setting ADDS to that list and never replaces it, so
//      pointing it at a shared mailbox cannot accidentally unsubscribe the real
//      operators.
//
// It is sent through the existing `notification-email` queue rather than getting
// one of its own — it is an email on a schedule, and that is the process that
// sends email. Using the queue's repeat schedule (rather than a plain timer in
// code) is what guarantees it goes out exactly once per day no matter how many
// worker processes are running.
// ─────────────────────────────────────────────────────────────────────────────

export const EVALUATION_DIGEST_JOB = 'evaluation-review-digest'

/**
 * Set up the daily send. Safe to call as many times as you like — the repeat key
 * never changes, so ten calls still give you one schedule, not ten emails.
 *
 * The time of day and timezone come from the OPS_DIGEST_CRON and OPS_DIGEST_TZ
 * environment settings.
 */
export async function ensureDigestSchedule(): Promise<void> {
  await getEmailQueue().add(
    EVALUATION_DIGEST_JOB,
    {},
    {
      repeat: { pattern: env.OPS_DIGEST_CRON, tz: env.OPS_DIGEST_TZ },
      // Only 3 tries, then give up and let tomorrow's send carry the news. A
      // summary that arrives six hours late is a summary about the wrong day.
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  )
}

export interface ReviewDigest {
  open: number
  byCode: { code: string; n: number }[]
  byTenant: { tenantName: string; n: number }[]
  /** When the longest-waiting flagged answer was submitted. */
  oldestWaitingSince: Date | null
  oldestWaitingHours: number
  /** Sessions the backstop is about to close out and flag — i.e. what this queue
   *  is going to look like shortly. */
  backstopPending: number
}

/**
 * Gather the numbers for the email, or return null when there is nothing to say.
 *
 * NULL IS THE NORMAL, INTENDED ANSWER on a healthy day.
 *
 * Rule 1 from the header (never send when the count is 0) is enforced HERE
 * rather than at the point of sending, so that anything else that ever wants
 * this data — a Slack alert, the panel's home page — inherits the same silence
 * automatically.
 */
export async function buildReviewDigest(): Promise<ReviewDigest | null> {
  const summary = await getReviewQueueSummary()
  if (summary.open === 0) return null

  // HOW OLD IS THE OLDEST ITEM IN THE QUEUE?
  //
  // Operators work the queue oldest-first, so the age of the item at the front is
  // the single number that says whether the queue is being worked at all. 40 open
  // with the oldest at 2 hours is a busy day; 3 open with the oldest at 4 days is
  // a neglected queue.
  //
  // Measured from `evaluation_jobs.created_at` — from when the student submitted
  // — because that is the honest clock: how long the student has been waiting.
  // Using `settled_at` would restart the clock every time the backstop touched
  // the row again.
  //
  // Fetched as the FIRST ROW of the same ordering `listReviewQueue` uses, rather
  // than as a min() calculation. That way it is by construction the exact row an
  // operator sees at the top when they open the panel.
  const [oldest] = await db
    .select({ at: evaluationJobs.createdAt })
    .from(questionResults)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, questionResults.jobId))
    .where(eq(questionResults.reviewStatus, 'needs_human'))
    .orderBy(asc(evaluationJobs.createdAt))
    .limit(1)

  const oldestWaitingSince = oldest?.at ?? null

  // A LOOK AHEAD at what the backstop is about to add to this queue.
  //
  // Wrapped in try/catch because it is a bonus, not the point. The email's real
  // job is to report the open count, and a failure in this extra lookup must
  // never stop the email going out. A 0 here simply reads as "nothing extra
  // known", which is exactly what it means.
  let backstopPending = 0
  try {
    backstopPending = (await findBackstopCandidates({ limit: 500 })).length
  } catch (err) {
    console.error('[evaluation-digest] backstop look-ahead failed:', err)
  }

  return {
    open: summary.open,
    byCode: summary.byCode.map((r) => ({ code: r.lastErrorCode ?? 'UNKNOWN', n: r.n })),
    byTenant: summary.byTenant.map((r) => ({ tenantName: r.tenantName, n: r.n })),
    oldestWaitingSince,
    oldestWaitingHours: oldestWaitingSince
      ? Math.floor((Date.now() - oldestWaitingSince.getTime()) / 3_600_000)
      : 0,
    backstopPending,
  }
}

/**
 * Who gets the email.
 *
 * Looked up from the live `users` table at send time, never from a hard-coded
 * list of addresses. WHY IT MATTERS: this email contains other coachings' data.
 * When someone's `super_admin` access is removed, they stop receiving it that
 * same day — automatically, without anyone having to remember to edit an
 * environment variable on the server.
 *
 * Duplicates are removed, and comparison ignores capital letters.
 */
export async function getDigestRecipients(): Promise<string[]> {
  const operators = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.role, 'super_admin'))

  const extra = env.OPS_DIGEST_EMAILS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const out: string[] = []
  // `users.email` can be empty (we allow phone-only accounts), so an operator
  // without an email address is quietly skipped rather than crashing the send
  // for everybody else.
  for (const email of [...operators.map((o) => o.email), ...extra]) {
    const key = email?.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(email!.trim())
  }
  return out
}

function panelUrl(): string {
  return env.OPS_ORIGIN || `https://admin.${env.APP_DOMAIN}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// This email builds its own HTML instead of using the shared `layout()` wrapper
// from templates/index.ts, on purpose.
//
// That wrapper ends with "You're receiving this because you're a member of a
// coaching on Gyanverse" — which is not just wrong here, it is wrong in a way
// that matters. This email carries OTHER coachings' data to Gyanverse staff. The
// two audiences should never share a template that could one day be reused for
// the wrong one.
function renderDigest(digest: ReviewDigest): { subject: string; html: string } {
  const url = panelUrl()
  const plural = digest.open === 1 ? 'answer needs' : 'answers need'

  const codeRows = digest.byCode
    .map(
      (r) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#374151;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(r.code)}</td>` +
        `<td style="padding:6px 0;color:#111;font-weight:600;text-align:right">${r.n}</td></tr>`,
    )
    .join('')

  const tenantRows = digest.byTenant
    .slice(0, 10)
    .map(
      (r) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#374151;font-size:14px">${escapeHtml(r.tenantName)}</td>` +
        `<td style="padding:6px 0;color:#111;font-weight:600;text-align:right">${r.n}</td></tr>`,
    )
    .join('')

  // The age of the oldest item goes first in the email, because that is the
  // difference between "a busy queue" and "a neglected queue". Past 24 hours it
  // turns into a red warning box.
  const age =
    digest.oldestWaitingHours >= 24
      ? `<p style="margin:0 0 16px;padding:12px 16px;background:#fef2f2;border-left:3px solid #dc2626;color:#991b1b;font-size:14px">
           The oldest has been waiting <strong>${Math.floor(digest.oldestWaitingHours / 24)} day(s)</strong>.
           That exam's teacher has had a disabled publish button for the same length of time.
         </p>`
      : `<p style="margin:0 0 16px;font-size:14px;color:#6b7280">
           Oldest waiting: <strong>${digest.oldestWaitingHours}h</strong>.
         </p>`

  const lookahead =
    digest.backstopPending > 0
      ? `<p style="margin:16px 0 0;font-size:14px;color:#6b7280">
           ${digest.backstopPending} more session(s) are past their retry bounds and will be settled
           into this queue by the backstop shortly.
         </p>`
      : ''

  return {
    subject: `[Gyanverse ops] ${digest.open} ${plural} manual review`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;padding:40px;border:1px solid #e5e7eb;max-width:600px">
        <tr><td>
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#6b7280;letter-spacing:.08em;text-transform:uppercase">Gyanverse platform ops</p>
          <p style="margin:0 0 20px;font-size:24px;font-weight:700;color:#111">${digest.open} ${plural} manual review</p>
          ${age}
          <p style="margin:0 0 24px;font-size:15px;color:#374151">
            Each of these is an answer the AI could not read. Every exam holding one has a publish
            button its teacher cannot press until it is resolved &mdash; by a re-run if the engine
            was at fault, or by hand if the upload genuinely is not legible.
          </p>
          <p style="margin:24px 0"><a href="${url}/#/review" style="background:#2B50F5;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600">Open the review queue</a></p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6b7280;letter-spacing:.05em;text-transform:uppercase">By failure code</p>
          <table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px">${codeRows}</table>
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6b7280;letter-spacing:.05em;text-transform:uppercase">By coaching</p>
          <table cellpadding="0" cellspacing="0" width="100%">${tenantRows}</table>
          ${lookahead}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0">
          <p style="margin:0;font-size:13px;color:#6b7280">
            You receive this because your account is a Gyanverse platform operator. It is sent only
            on days the queue is not empty.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  }
}

export interface DigestResult {
  open: number
  sent: number
  /** Only set when nothing went out, and it says why.
   *  `queue-empty`    = a healthy day, nothing to report (the normal case)
   *  `no-recipients`  = there is work waiting and NOBODY to tell. See below. */
  skipped?: 'queue-empty' | 'no-recipients'
}

/**
 * Build the email and send it. Run by the email worker on the daily schedule.
 *
 * ONE SEPARATE EMAIL PER PERSON, rather than one email with everyone in the To:
 * field. This email implies things about other coachings' students, and the list
 * of who receives that is not something to hand a copy of to every recipient.
 */
export async function sendReviewDigest(): Promise<DigestResult> {
  const digest = await buildReviewDigest()
  if (!digest) return { open: 0, sent: 0, skipped: 'queue-empty' }

  const recipients = await getDigestRecipients()
  if (recipients.length === 0) {
    // THE WORST CASE: there is work waiting and there is nobody to tell.
    //
    // Logged loudly and in full detail, because the alternative is a silence
    // that looks exactly like a perfectly healthy day — while every exam holding
    // a flagged answer stays unpublishable indefinitely.
    console.error(
      `[evaluation-digest] ${digest.open} answers await manual review and there are NO ` +
        'platform operators to notify. Mint one with `npm run ops:promote -- <email>`, ' +
        'or set OPS_DIGEST_EMAILS. Until then no exam holding a flagged answer can be published.',
    )
    return { open: digest.open, sent: 0, skipped: 'no-recipients' }
  }

  const { subject, html } = renderDigest(digest)
  let sent = 0
  const failures: string[] = []

  for (const to of recipients) {
    try {
      await sendEmail({ to, subject, html })
      sent++
    } catch (err) {
      failures.push(`${to}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Only treat this as a failure if NOBODY was reached.
  //
  // Why: throwing here makes the queue retry the whole send. If one address out
  // of five is bad, retrying would deliver the email a second time to the other
  // four. A partial failure is therefore logged, not thrown.
  if (sent === 0) throw new Error(`digest delivery failed for every recipient — ${failures.join('; ')}`)
  if (failures.length > 0) console.error(`[evaluation-digest] partial delivery — ${failures.join('; ')}`)

  console.log(
    `[evaluation-digest] open=${digest.open} oldest=${digest.oldestWaitingHours}h ` +
      `backstopPending=${digest.backstopPending} sent=${sent}/${recipients.length}`,
  )

  return { open: digest.open, sent }
}
