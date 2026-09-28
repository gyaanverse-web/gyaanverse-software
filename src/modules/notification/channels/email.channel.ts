import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { env } from '@config/env.js'

// Dev: nodemailer → Mailpit SMTP (localhost:1025, no auth)
// Prod: Resend SDK
const devTransport = nodemailer.createTransport({
  host: env.MAILPIT_HOST,
  port: env.MAILPIT_PORT,
  secure: false,
})

let _resend: Resend | null = null
function getResend(): Resend {
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY)
  return _resend
}

export interface EmailParams {
  to: string
  subject: string
  html: string
  /**
   * Plaintext alternative. Optional, but send it on anything that has to reach
   * a stranger's inbox: an HTML-only body is a spam-filter signal on its own,
   * and it's the version some clients show.
   */
  text?: string
  from?: string
}

export async function sendEmail(params: EmailParams): Promise<void> {
  const from = params.from ?? `Gyaanverse <noreply@${env.APP_DOMAIN}>`

  if (env.NODE_ENV !== 'production') {
    await devTransport.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    })
    return
  }

  const { error } = await getResend().emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    ...(params.text ? { text: params.text } : {}),
  })

  if (error) throw new Error(`Resend error: ${error.message}`)
}
