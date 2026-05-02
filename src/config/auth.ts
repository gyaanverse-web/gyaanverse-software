import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { phoneNumber, bearer } from 'better-auth/plugins'
import { Resend } from 'resend'
import { db } from '../shared/db.js'
import { env } from './env.js'
import { users, sessions, accounts, verifications } from '../modules/auth/auth.schema.js'

const resend = new Resend(env.RESEND_API_KEY)

async function sendVerificationEmail(userEmail: string, url: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    let consoleUrl = url
    try {
      const parsedUrl = new URL(url)
      parsedUrl.protocol = 'http:'
      parsedUrl.hostname = '127.0.0.1'
      parsedUrl.port = '8000'
      consoleUrl = parsedUrl.toString()
    } catch {
      // Keep original URL if parsing fails.
    }

    // Keep this on stdout so it is visible in most local consoles/IDEs.
    const divider = '-'.repeat(72)
    console.log(
      `\n${divider}\n` +
        `EMAIL VERIFICATION (dev - not sent)\n` +
        `To:  ${userEmail}\n` +
        `URL: ${consoleUrl}\n` +
        `${divider}\n`,
    )
    return
  }
  const { error } = await resend.emails.send({
    from: `Gyanverse <noreply@${env.APP_DOMAIN}>`,
    to: userEmail,
    subject: 'Verify your Gyanverse email',
    html: `<p>Click <a href="${url}">this link</a> to verify your email. It expires in 1 hour.</p><p>Ignore this if you didn't sign up.</p>`,
  })
  if (error) console.error('[Resend] Failed to send verification email:', error)
}

async function sendPasswordResetEmail(userEmail: string, url: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    let consoleUrl = url
    try {
      const parsedUrl = new URL(url)
      parsedUrl.protocol = 'http:'
      parsedUrl.hostname = '127.0.0.1'
      parsedUrl.port = '8000'
      consoleUrl = parsedUrl.toString()
    } catch {
      // Keep original URL if parsing fails.
    }

    const divider = '-'.repeat(72)
    console.log(
      `\n${divider}\n` +
        `PASSWORD RESET (dev - not sent)\n` +
        `To:  ${userEmail}\n` +
        `URL: ${consoleUrl}\n` +
        `${divider}\n`,
    )
    return
  }
  const { error } = await resend.emails.send({
    from: `Gyanverse <noreply@${env.APP_DOMAIN}>`,
    to: userEmail,
    subject: 'Reset your Gyanverse password',
    html: `<p>Click <a href="${url}">this link</a> to reset your password. It expires in 1 hour.</p><p>Ignore this if you didn't request a reset.</p>`,
  })
  if (error) console.error('[Resend] Failed to send password reset email:', error)
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
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:8000',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
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

