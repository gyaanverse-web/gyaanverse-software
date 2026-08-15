import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { env } from '@config/env.js'
import { auth } from '@config/auth.js'
import { users } from '@modules/auth/auth.schema.js'
import { sendEmail } from '@modules/notification/channels/email.channel.js'

// ─────────────────────────────────────────────────────────────────────────────
// What goes in the account emails, and what the page that receives it can rely
// on getting back.
//
// Gmail was intermittently opening verification links behind a full-page Google
// Safe Browsing "dangerous site" interstitial. The cause was the shape of the
// link, not the mail: it pointed at `api.gyaanverse.com` — a host that serves
// nothing but JSON and 302s — and carried a second, URL-encoded URL in a
// `callbackURL` query param, which is the open-redirect signature every
// credential-phishing kit uses. Verdicts are computed per-URL and every signup
// mints a new token, hence "sometimes, not always".
//
// So the emailed link now points at the frontend and carries only the token,
// and the landing page spends it against the API itself. That moves the
// outcome from a 302 with `?error=CODE` into a JSON response, which is what
// the second half of this file pins down — frontend/src/app/verify-email
// branches on those codes.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@modules/notification/channels/email.channel.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}))

const mockSendEmail = vi.mocked(sendEmail)

let _n = 0
const freshEmail = () => `verify-${Date.now()}-${_n++}@example.com`

/** Signs a user up and returns the link out of the verification email. */
async function signUpAndCaptureLink(): Promise<{ email: string; link: string }> {
  const email = freshEmail()
  await auth.api.signUpEmail({ body: { name: 'Test Person', email, password: 'password1234' } })

  const call = mockSendEmail.mock.calls.at(-1)?.[0]
  if (!call) throw new Error('sign-up sent no verification email')

  const link = call.html.match(/https?:\/\/[^"'\s<]+verify-email[^"'\s<]*/)?.[0]
  if (!link) throw new Error(`no verification link in email body:\n${call.html}`)
  return { email, link }
}

beforeEach(() => {
  mockSendEmail.mockClear()
})

describe('the emailed verification link', () => {
  it('CRITICAL: points at the frontend, not the API', async () => {
    // The whole fix. If this ever regresses to the API host, Safe Browsing
    // starts red-flagging signups again — silently, and only for some users.
    const { link } = await signUpAndCaptureLink()
    expect(new URL(link).origin).toBe(new URL(env.FRONTEND_URL).origin)
    expect(link).not.toContain(new URL(env.BETTER_AUTH_URL).host)
  })

  it('CRITICAL: carries a token and nothing else', async () => {
    // Specifically: no `callbackURL`. A URL-encoded URL inside a query param is
    // the single strongest phishing signal this link used to carry.
    const { link } = await signUpAndCaptureLink()
    const params = new URL(link).searchParams
    expect([...params.keys()]).toEqual(['token'])
    expect(params.get('token')).toBeTruthy()
    expect(link).not.toContain('%3A%2F%2F')
  })

  it('shows the destination URL to the reader instead of hiding it behind "click here"', async () => {
    // A one-line mail whose only anchor text is "this link" reads as phishing
    // to filters and to people. The address has to be visible as text.
    const { link } = await signUpAndCaptureLink()
    const { html, text } = mockSendEmail.mock.calls.at(-1)![0]
    expect(html).toContain(`>${link}<`)
    expect(text).toContain(link)
  })

  it('sends a plaintext alternative, not HTML alone', async () => {
    await signUpAndCaptureLink()
    expect(mockSendEmail.mock.calls.at(-1)![0].text).toBeTruthy()
  })
})

describe('spending the token, the way the landing page does', () => {
  it('CRITICAL: returns JSON rather than redirecting when no callbackURL is sent', async () => {
    // The page reads the response body; a 302 would leave it with nothing to
    // render. Better Auth only redirects when a callbackURL is present, and we
    // deliberately no longer send one.
    const { email, link } = await signUpAndCaptureLink()
    const token = new URL(link).searchParams.get('token')!

    const res = await auth.api.verifyEmail({ query: { token } })
    expect(res).toMatchObject({ status: true })

    const [row] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    expect(row.emailVerified).toBe(true)
  })

  it('is idempotent, so a double-click on the link is still a success', async () => {
    // Mail clients prefetch links and people click twice. The second call must
    // not present as a failure.
    const { link } = await signUpAndCaptureLink()
    const token = new URL(link).searchParams.get('token')!

    await auth.api.verifyEmail({ query: { token } })
    const second = await auth.api.verifyEmail({ query: { token } })
    expect(second).toMatchObject({ status: true })
  })

  it('CRITICAL: reports a bad token as a machine-readable code', async () => {
    // ERROR_COPY in the verify-email page keys off `code`. If these ever came
    // back as prose only, every failure would collapse to the generic message.
    await expect(auth.api.verifyEmail({ query: { token: 'not-a-jwt' } })).rejects.toMatchObject({
      body: { code: 'INVALID_TOKEN' },
    })
  })

  it('reports an expired token distinctly from an invalid one', async () => {
    // The two get different copy: expired offers a resend, malformed doesn't
    // necessarily mean the same thing to the reader.
    const { SignJWT } = await import('jose')
    const expired = await new SignJWT({ email: 'someone@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET))

    await expect(auth.api.verifyEmail({ query: { token: expired } })).rejects.toMatchObject({
      body: { code: 'TOKEN_EXPIRED' },
    })
  })
})

describe('the emailed password-reset link', () => {
  it('CRITICAL: also points at the frontend and carries only a token', async () => {
    const { email } = await signUpAndCaptureLink()
    mockSendEmail.mockClear()

    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' } })

    const call = mockSendEmail.mock.calls.at(-1)?.[0]
    if (!call) throw new Error('no password reset email was sent')
    const link = call.html.match(/https?:\/\/[^"'\s<]+reset-password[^"'\s<]*/)?.[0]
    if (!link) throw new Error(`no reset link in email body:\n${call.html}`)

    expect(new URL(link).origin).toBe(new URL(env.FRONTEND_URL).origin)
    expect([...new URL(link).searchParams.keys()]).toEqual(['token'])
  })
})
