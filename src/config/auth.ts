import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { phoneNumber, bearer } from 'better-auth/plugins'
import { db } from '../shared/db.js'
import { env } from './env.js'
import { users, sessions, accounts, verifications } from '../modules/auth/auth.schema.js'
import { sendEmail } from '../modules/notification/channels/email.channel.js'
import { withFrontendCallback } from '../shared/urls.js'

// In dev, sendEmail() routes to Mailpit (http://localhost:8025 web UI). If
// Mailpit isn't running the send throws — we log the URL as a fallback so the
// signup flow can still be completed manually instead of being a dead end.
async function sendWithFallback(label: string, to: string, subject: string, html: string, url: string): Promise<void> {
  try {
    await sendEmail({ to, subject, html })
  } catch (err) {
    console.error(`[auth] ${label} email send failed for ${to}:`, err)
    if (env.NODE_ENV !== 'production') {
      const divider = '-'.repeat(72)
      console.log(`\n${divider}\n${label} FALLBACK (open this URL manually)\nTo:  ${to}\nURL: ${url}\n${divider}\n`)
    }
  }
}

async function sendVerificationEmail(userEmail: string, betterAuthUrl: string): Promise<void> {
  // The link must hit the API (only it can consume the token), but the page the
  // user is redirected to afterwards has to be on the frontend — see
  // withFrontendCallback.
  const url = withFrontendCallback(betterAuthUrl, '/verify-email')
  await sendWithFallback(
    'EMAIL VERIFICATION',
    userEmail,
    'Verify your Gyanverse email',
    `<p>Click <a href="${url}">this link</a> to verify your email. It expires in 1 hour.</p><p>Ignore this if you didn't sign up.</p>`,
    url,
  )
}

async function sendPasswordResetEmail(userEmail: string, betterAuthUrl: string): Promise<void> {
  const url = withFrontendCallback(betterAuthUrl, '/reset-password')
  await sendWithFallback(
    'PASSWORD RESET',
    userEmail,
    'Reset your Gyanverse password',
    `<p>Click <a href="${url}">this link</a> to reset your password. It expires in 1 hour.</p><p>Ignore this if you didn't request a reset.</p>`,
    url,
  )
}

async function sendMsg91Otp(phone: string, code: string): Promise<void> {
  const res = await fetch('https://api.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey: env.MSG91_AUTH_KEY },
    body: JSON.stringify({ template_id: env.MSG91_TEMPLATE_ID, mobile: phone, otp: code }),
  })
  if (!res.ok) console.error('[MSG91] OTP send failed:', await res.text())
}

const trustedOrigins =
  env.NODE_ENV !== 'production'
    ? [
        // lvh.me is a public domain whose wildcard DNS points at 127.0.0.1.
        // Used instead of *.localhost because Chromium treats localhost as a
        // public suffix and rejects cross-subdomain cookies — see the
        // crossSubDomainCookies note below.
        'http://app.lvh.me:3000',
        'http://app.lvh.me:8000',
        'http://*.lvh.me:3000',
        'http://*.lvh.me:8000',
        // Bare localhost entries kept for tooling that hits the API directly
        // (curl, Bull Board at /queues, etc.). The app itself runs on lvh.me.
        'http://localhost:3000',
        'http://localhost:8000',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:8000',
      ]
    : [`https://${env.APP_DOMAIN}`, `https://*.${env.APP_DOMAIN}`]

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { users, session: sessions, account: accounts, verification: verifications },
  }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins,

  advanced: {
    database: {
      // Better Auth's default ID generator produces nanoids, which are not valid UUIDs.
      // All pk columns are uuid type, so we must generate UUIDs here.
      generateId: () => crypto.randomUUID(),
    },
    // Share the session cookie across all tenant subdomains.
    //   dev:  Domain=lvh.me        → cookie is sent to *.lvh.me and lvh.me
    //   prod: Domain=gyanverse.com → cookie is sent to *.gyanverse.com and gyanverse.com
    //
    // Why lvh.me in dev (not localhost)? Chromium treats `localhost` as a public
    // suffix (TLD-like). Per RFC 6265 §5.3 step 5, a Set-Cookie with Domain set
    // to a public suffix is REJECTED entirely when the response host differs
    // from that domain. So `app.localhost:8000` setting `Domain=localhost` was
    // silently dropped by the browser. `lvh.me` is a regular registered domain
    // whose wildcard DNS resolves to 127.0.0.1 — no public-suffix quirk.
    //
    // Combined with SameSite=Lax (Better Auth default), a user who logs in at the
    // root then top-level-navigates to <slug>.<root> keeps their session, and any
    // same-site fetch from <slug>.<root>:3000 → <slug>.<root>:8000 also carries it.
    //
    // Security note (per Better Auth guidance): this gives every subdomain of the
    // configured root read access to the auth cookie. We control the whole zone
    // (tenant subdomains are all our app), so this is acceptable. If we ever host
    // an untrusted service at *.gyanverse.com (status pages, partner widgets, etc.)
    // it MUST be moved to a separate domain.
    crossSubDomainCookies: {
      enabled: true,
      domain: env.NODE_ENV !== 'production' ? 'lvh.me' : env.APP_DOMAIN,
    },
  },

  // Tell Better Auth our users table is named "users" (not the default "user")
  user: {
    modelName: 'users',
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'student',
        input: false, // server-controlled only
      },
      // The one role-ish field the client MAY set, because it grants nothing:
      // every permission is authorised off the `memberships` row by
      // requireTenantRole, so claiming 'coaching_owner' here buys you exactly
      // one thing — being sent to /create-coaching instead of /student.
      //
      // Whitelisted through `transform.input` rather than an enum `type`:
      // Better Auth maps an array type to `z.any()` (see dist/db/to-zod), so an
      // enum would not actually validate. The transform only runs when the key
      // is present; omitting it falls through to defaultValue.
      signupIntent: {
        type: 'string',
        required: false,
        defaultValue: 'student',
        input: true,
        transform: {
          input: (value: unknown) => (value === 'coaching_owner' ? 'coaching_owner' : 'student'),
        },
      },
      tenantId: {
        type: 'string',
        required: false,
        input: false,
      },
      isProfileComplete: {
        type: 'boolean',
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },

  session: { modelName: 'session' },
  account: { modelName: 'account' },

  // Email + password
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: true,
    // A reset is the recovery path for a compromised account, so any session an
    // attacker still holds must die with the old password. Off by default in
    // Better Auth.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async (
      { user, url }: { user: { email: string }; url: string; token: string },
      _request?: Request,
    ) => {
      await sendPasswordResetEmail(user.email, url)
    },
  },

  // sendVerificationEmail MUST be here (top-level emailVerification), not inside
  // emailAndPassword — that's the only place Better Auth's sign-up route checks.
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
      await sendVerificationEmail(user.email, url)
    },
  },

  // Phone OTP
  plugins: [
    bearer(),
    phoneNumber({
      sendOTP: async ({ phoneNumber: phone, code }) => {
        if (env.NODE_ENV === 'development') {
          // Log OTP instead of sending in dev so you can test without MSG91 credits
          console.log(`[DEV OTP] ${phone} -> ${code}`)
          return
        }
        await sendMsg91Otp(phone, code)
      },
      otpLength: 6,
      expiresIn: 600, // 10 minutes
      // Auto-create an account on first successful OTP verification
      signUpOnVerification: {
        getTempEmail: (phone) => `${phone.replace(/\D/g, '')}@phone.gyanverse.app`,
        getTempName: (phone) => phone,
      },
    }),
  ],
})

