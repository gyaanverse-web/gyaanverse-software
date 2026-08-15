import type { NotificationType } from '../notification.types.js'

interface TemplateData {
  recipientName: string
  link?: string | null
  [key: string]: unknown
}

interface EmailTemplate {
  subject: string
  html: string
}

// Outer chrome shared by every email we send — notification and auth alike.
function shell(content: string, footer: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;padding:40px;border:1px solid #e5e7eb;max-width:600px">
        <tr><td>
          <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#111">Gyaanverse</p>
          ${content}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
          <p style="margin:0;font-size:13px;color:#6b7280">${footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function ctaButton(link: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${link}" style="background:#2B50F5;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600">${label}</a></p>`
}

// Shared layout wrapper — keeps all emails visually consistent
function layout(content: string, link?: string | null): string {
  return shell(
    `${content}${link ? ctaButton(link, 'Open in Gyaanverse') : ''}`,
    "You're receiving this because you're a member of a coaching on Gyaanverse. To manage notifications, visit your profile settings.",
  )
}

// ── Auth action emails (verification, password reset) ────────────────────────

/**
 * The one-click emails that carry a token: verify-your-email and reset-password.
 *
 * These are held to a higher bar than the notification templates above, because
 * they are the mails most likely to be classified as phishing — they go to
 * strangers, from a young domain, and consist of a single link. So they carry a
 * plaintext alternative, a visible copy of the destination URL (never a bare
 * "click this link" whose anchor points somewhere the reader can't see), and a
 * footer naming the site that sent them. Keep all three when editing.
 */
export function authActionEmail(opts: {
  heading: string
  intro: string
  ctaLabel: string
  url: string
  expiry: string
}): { html: string; text: string } {
  const origin = new URL(opts.url).origin
  const site = origin.replace(/^https?:\/\//, '')

  const html = shell(
    `
      <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111">${opts.heading}</p>
      <p style="margin:0 0 4px;font-size:16px;color:#374151">${opts.intro}</p>
      ${ctaButton(opts.url, opts.ctaLabel)}
      <p style="margin:0 0 8px;font-size:14px;color:#6b7280">Or paste this address into your browser:</p>
      <p style="margin:0 0 16px;font-size:13px;color:#374151;word-break:break-all"><a href="${opts.url}" style="color:#2B50F5;text-decoration:none">${opts.url}</a></p>
      <p style="margin:0;font-size:14px;color:#6b7280">This link expires in ${opts.expiry} and can only be used once.</p>
    `,
    `Sent by Gyaanverse (${site}). If you didn't request this, you can safely ignore this email — no changes will be made to your account.`,
  )

  const text = [
    opts.heading,
    '',
    opts.intro,
    '',
    opts.url,
    '',
    `This link expires in ${opts.expiry} and can only be used once.`,
    `Sent by Gyaanverse (${site}). If you didn't request this, you can safely ignore this email — no changes will be made to your account.`,
  ].join('\n')

  return { html, text }
}

// ── Per-type templates ────────────────────────────────────────────────────────

function examAssigned(data: TemplateData & { examTitle: string; className: string }): EmailTemplate {
  return {
    subject: `New Exam: ${data.examTitle}`,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        A new exam <strong>${data.examTitle}</strong> has been assigned to your class <strong>${data.className}</strong>.
      </p>
      <p style="margin:0;font-size:14px;color:#6b7280">Click below to view the exam details and start when you're ready.</p>
    `, data.link),
  }
}

function examStartingSoon(data: TemplateData & { examTitle: string }): EmailTemplate {
  return {
    subject: `Reminder: ${data.examTitle} starts soon`,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        Your exam <strong>${data.examTitle}</strong> is starting soon. Make sure you're ready!
      </p>
    `, data.link),
  }
}

function resultReady(data: TemplateData & { examTitle: string }): EmailTemplate {
  return {
    subject: `Your result is ready: ${data.examTitle}`,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        Your result for <strong>${data.examTitle}</strong> has been evaluated and is ready to view.
      </p>
    `, data.link),
  }
}

function inviteReceived(data: TemplateData & { coachingName: string }): EmailTemplate {
  return {
    subject: `You've been invited to ${data.coachingName}`,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        You've been invited to join <strong>${data.coachingName}</strong> on Gyaanverse.
      </p>
    `, data.link),
  }
}

function inviteAccepted(data: TemplateData & { memberName: string }): EmailTemplate {
  return {
    subject: `${data.memberName} accepted your invite`,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        <strong>${data.memberName}</strong> has accepted your invite and joined your coaching.
      </p>
    `, data.link),
  }
}

function paymentConfirmed(data: TemplateData & { planName: string }): EmailTemplate {
  return {
    subject: 'Payment confirmed — subscription active',
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        Your payment has been confirmed and your <strong>${data.planName}</strong> subscription is now active.
      </p>
    `, data.link),
  }
}

function paymentFailed(data: TemplateData): EmailTemplate {
  return {
    subject: 'Action required: payment failed',
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        We were unable to process your recent payment. Please update your payment details to keep your subscription active.
      </p>
    `, data.link),
  }
}

function planLimitWarning(data: TemplateData & { limitName: string }): EmailTemplate {
  return {
    subject: `You're approaching your ${data.limitName} limit`,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">
        Your coaching is approaching the <strong>${data.limitName}</strong> limit on your current plan. Consider upgrading to avoid disruption.
      </p>
    `, data.link),
  }
}

function generic(data: TemplateData & { title: string; body: string }): EmailTemplate {
  return {
    subject: data.title,
    html: layout(`
      <p style="margin:0 0 8px;font-size:16px;color:#374151">Hi ${data.recipientName},</p>
      <p style="margin:0 0 16px;font-size:16px;color:#374151">${data.body}</p>
    `, data.link),
  }
}

// ── Public resolver — maps NotificationType → template function ──────────────

export function resolveEmailTemplate(
  type: NotificationType,
  data: Record<string, unknown>,
): EmailTemplate {
  const base = {
    recipientName: (data.recipientName as string) ?? 'there',
    link: (data.link as string | null) ?? null,
  }

  // Typed templates interpolate fields the dispatcher passes via `metadata`. If a
  // dispatcher forgets one we must not render the literal string "undefined" into
  // a subject line — fall back to the notification's own title/body instead.
  const fallback = () => generic({ ...base, title: data.title as string, body: data.body as string })
  const need = (...keys: string[]) => keys.every((k) => typeof data[k] === 'string' && data[k] !== '')

  switch (type) {
    case 'exam_assigned':
      return need('examTitle', 'className')
        ? examAssigned({ ...base, examTitle: data.examTitle as string, className: data.className as string })
        : fallback()
    case 'exam_starting_soon':
      return need('examTitle')
        ? examStartingSoon({ ...base, examTitle: data.examTitle as string })
        : fallback()
    case 'result_ready':
      return need('examTitle')
        ? resultReady({ ...base, examTitle: data.examTitle as string })
        : fallback()
    case 'invite_received':
      return need('coachingName')
        ? inviteReceived({ ...base, coachingName: data.coachingName as string })
        : fallback()
    case 'invite_accepted':
      return need('memberName')
        ? inviteAccepted({ ...base, memberName: data.memberName as string })
        : fallback()
    case 'payment_confirmed':
      return need('planName')
        ? paymentConfirmed({ ...base, planName: data.planName as string })
        : fallback()
    case 'payment_failed':
      return paymentFailed(base)
    case 'plan_limit_warning':
      return need('limitName')
        ? planLimitWarning({ ...base, limitName: data.limitName as string })
        : fallback()
    default:
      return generic({ ...base, title: data.title as string, body: data.body as string })
  }
}
