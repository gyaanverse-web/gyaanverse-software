import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../../config/auth.js'
import { authenticate } from '../../middleware/auth.middleware.js'
import { throttleBy, clearThrottle } from '../../shared/rate-limit.js'
import { getCurrentUser, updateProfile, updateProfileSchema } from './auth.service.js'

const AUTH = [{ bearerAuth: [] }]

/**
 * Force IP keying on the unauthenticated credential endpoints.
 *
 * The global limiter prefers the session cookie so a NAT'd classroom doesn't
 * share one bucket — but that would be a hole here: anyone attacking sign-in
 * can mint a fresh cookie per request and get a fresh bucket with it. Callers
 * of these routes have no legitimate session yet, so the network origin is the
 * only ceiling worth enforcing.
 *
 * This is only a flood guard. The real brute-force defence is `throttleBy`,
 * which counts attempts against the *credential* being targeted and therefore
 * survives an attacker who rotates IPs.
 */
const byIp = (req: FastifyRequest) => `ip:${req.ip ?? 'unknown'}`

/** Read a credential off a JSON body without asserting the body is well-formed. */
function credential(body: unknown, field: 'email' | 'phoneNumber'): string | null {
  const value = (body as Record<string, unknown> | null)?.[field]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

async function betterAuthHandler(req: FastifyRequest, reply: FastifyReply) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const request = new Request(url.toString(), {
    method: req.method,
    headers: fromNodeHeaders(req.headers),
    body: req.method !== 'GET' && req.body ? JSON.stringify(req.body) : undefined,
  })

  const response = await auth.handler(request)

  reply.status(response.status)

  const setCookies: string[] = []
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      setCookies.push(value)
    } else {
      reply.header(key, value)
    }
  })
  if (setCookies.length > 0) reply.header('set-cookie', setCookies)

  reply.send(await response.text())
}

export async function authRoutes(app: FastifyInstance) {
  // Better Auth handler - covers all sign-up / sign-in / OTP endpoints
  //
  // Email+password:
  //   POST /api/auth/sign-up/email   { name, email, password }
  //   POST /api/auth/sign-in/email   { email, password }
  //
  // Phone OTP (dev: OTP is printed to console instead of sent via MSG91):
  //   POST /api/auth/phone-number/send-otp  { phoneNumber }
  //   POST /api/auth/phone-number/verify    { phoneNumber, code }
  //     -> sets session cookie AND returns { token } for Bearer auth
  //
  // Session:
  //   POST /api/auth/sign-out
  //   GET  /api/auth/get-session

  // POST /api/auth/request-password-reset — email users only.
  // Registered before the catch-all so Fastify routes it here instead of the wildcard.
  // Phone users (placeholder email) are silently ignored; we never reveal user existence.
  app.post(
    '/api/auth/request-password-reset',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Request a password reset email',
        description: 'Sends a reset link to the given email address. Phone-only accounts (synthetic email domain) are silently skipped. Always returns the same generic message to avoid revealing account existence.',
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email', description: 'Email address of the account' },
          },
          required: ['email'],
        },
      },
      // Unauthenticated and sends mail on demand. The per-IP ceiling is only a
      // flood guard; the per-address throttle below is what stops one inbox
      // being spammed by an attacker spread across many IPs.
      config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: byIp } },
    },
    async (req, reply) => {
      const { email } = (req.body ?? {}) as { email?: string }

      if (!email || typeof email !== 'string') {
        return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'email is required' })
      }

      const normalized = email.trim().toLowerCase()
      const generic = { message: 'If an account with that email exists, a reset link has been sent.' }

      // Before the phone-account check below, so the throttle behaves identically
      // for addresses that exist and those that don't — a 429 that only fired for
      // real accounts would be an account-existence oracle, defeating the generic
      // response this route is careful to give.
      await throttleBy('pwreset', normalized, 3, 15 * 60)

      // Phone-only accounts — silently skip without revealing whether the account exists
      if (normalized.endsWith('@phone.gyanverse.app')) {
        return reply.send(generic)
      }

      // `redirectTo` only seeds Better Auth's callbackURL — sendPasswordResetEmail
      // in config/auth.ts rewrites it to the absolute frontend page before the
      // link is emailed, so the user never lands back on the API host.
      await auth.api.requestPasswordReset({
        body: { email: normalized, redirectTo: '/reset-password' },
      })

      reply.send(generic)
    },
  )

  // ── Explicit routes for Swagger + observability ──────────────────────────
  // These delegate to the same betterAuthHandler as the wildcard below.
  // Fastify matches these first (more specific), wildcard only fires for
  // endpoints we haven't explicitly registered (OAuth callbacks, CSRF, etc.).

  app.post(
    '/api/auth/sign-up/email',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign up with email and password',
        body: {
          type: 'object',
          required: ['name', 'email', 'password'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        },
      },
      // No per-address throttle: there is no existing credential to guess, and
      // a duplicate address is already rejected by the unique constraint.
      config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: byIp } },
    },
    betterAuthHandler,
  )

  app.post(
    '/api/auth/sign-in/email',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with email and password',
        description: 'Email address must be verified before the first sign-in.',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            rememberMe: { type: 'boolean' },
          },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: byIp } },
      // Brute force is one account against many passwords, so the budget belongs
      // to the account. The old 10/min per IP punished the wrong party entirely:
      // a coaching centre signing in at 8:55am is thirty people on one NAT, and
      // they would lock each other out of the login form.
      preHandler: async (req: FastifyRequest) => {
        const email = credential(req.body, 'email')
        if (email) await throttleBy('signin', email, 10, 15 * 60)
      },
      // Only failures should count. Clearing on success means a teacher moving
      // between phone, laptop and lab desktop never spends the attacker's budget.
      onResponse: async (req: FastifyRequest, reply: FastifyReply) => {
        if (reply.statusCode >= 400) return
        const email = credential(req.body, 'email')
        if (email) await clearThrottle('signin', email)
      },
    },
    betterAuthHandler,
  )

  app.post(
    '/api/auth/phone-number/send-otp',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Send phone OTP',
        description: 'In dev, OTP is printed to the console instead of being sent via MSG91.',
        body: {
          type: 'object',
          required: ['phoneNumber'],
          properties: {
            phoneNumber: { type: 'string' },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: byIp } },
      // The strictest throttle in the file, because every call here is real
      // MSG91 spend and an unthrottled endpoint is an SMS-bombing tool pointed
      // at whichever number the attacker types. Never cleared on success — a
      // delivered OTP is exactly what we are budgeting, not a failure to retry.
      preHandler: async (req: FastifyRequest) => {
        const phone = credential(req.body, 'phoneNumber')
        if (phone) await throttleBy('otp-send', phone, 3, 10 * 60)
      },
    },
    betterAuthHandler,
  )

  app.post(
    '/api/auth/phone-number/verify',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Verify phone OTP',
        description: 'Sets a session cookie and returns `{ token }` for Bearer auth.',
        body: {
          type: 'object',
          required: ['phoneNumber', 'code'],
          properties: {
            phoneNumber: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: byIp } },
      // A 6-digit OTP is only 10^6 wide, so the guess budget per number is the
      // control that matters — a separate bucket from 'otp-send' so burning
      // verify attempts can't also block a legitimate resend.
      preHandler: async (req: FastifyRequest) => {
        const phone = credential(req.body, 'phoneNumber')
        if (phone) await throttleBy('otp-verify', phone, 10, 10 * 60)
      },
      onResponse: async (req: FastifyRequest, reply: FastifyReply) => {
        if (reply.statusCode >= 400) return
        const phone = credential(req.body, 'phoneNumber')
        if (phone) await clearThrottle('otp-verify', phone)
      },
    },
    betterAuthHandler,
  )

  app.post(
    '/api/auth/sign-out',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign out',
        description: 'Clears the session cookie.',
      },
      // Nothing to brute-force here; it was only tight by association with the
      // sign-in endpoints above.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    betterAuthHandler,
  )

  app.get(
    '/api/auth/get-session',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Get current session',
        description: 'Returns the active session or `null` if unauthenticated.',
      },
      // No override on purpose — this inherits the global 500/min. It is a read
      // that every page performs on mount, not a credential endpoint, and the
      // 10/min it used to carry was exhausted by ten client-side navigations.
    },
    betterAuthHandler,
  )

  // ── Better Auth wildcard catch-all ────────────────────────────────────────
  // Handles everything Better Auth needs internally that we haven't explicitly
  // registered above: email verification callbacks, OAuth flows, CSRF, etc.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    schema: {
      tags: ['Auth'],
      summary: 'Better Auth internal catch-all',
      description: 'Handles internal Better Auth callbacks (email verification, OAuth, CSRF). Not for direct client use.',
      hide: true,
    },
    // Loosened from 10/min: this carries email-verification and OAuth callbacks,
    // which a user can legitimately hit several times in a row (a redirect chain
    // plus a re-sent verification link) and where a 429 strands them mid-signup.
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: betterAuthHandler,
  })

  // GET  /api/auth/me  — current user
  app.get(
    '/api/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Get current user',
        description: 'Returns the authenticated user\'s profile row.',
        security: AUTH,
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { id } = req.user!
      const user = await getCurrentUser(id)
      reply.send({ user })
    },
  )

  // PATCH /api/auth/me  — complete / update profile
  // Phone users (emailVerified = false): { name, email? }
  //   Updating email resets emailVerified to false and sends a verification link.
  // Email users (emailVerified = true): { name } only — email cannot be changed.
  app.patch(
    '/api/auth/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Update profile',
        description: `Updates the authenticated user's profile.

- **Phone users** (\`emailVerified: false\`): may supply \`email\` to add a real address — resets \`emailVerified\` and sends a verification email.
- **Email users** (\`emailVerified: true\`): only \`name\` may be updated; email changes are rejected with \`403\`.`,
        security: AUTH,
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            email: { type: 'string', format: 'email', description: 'Phone users only — triggers email verification' },
          },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const parsed = updateProfileSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(422).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues })
      }

      const { id } = req.user!
      const current = await getCurrentUser(id)

      if (current.emailVerified && parsed.data.email) {
        return reply.status(403).send({
          error: 'FORBIDDEN',
          message: 'Email address cannot be changed after verification.',
        })
      }

      const emailChanged = !!parsed.data.email && parsed.data.email !== current.email
      const user = await updateProfile(id, parsed.data)

      if (emailChanged) {
        try {
          // No callbackURL here — it would be ignored anyway. sendVerificationEmail
          // in config/auth.ts builds the link from the token alone and always
          // points it at the frontend's /verify-email page.
          await auth.api.sendVerificationEmail({
            body: { email: parsed.data.email! },
            headers: fromNodeHeaders(req.headers),
          })
        } catch (err) {
          // Non-fatal: profile is saved, verification email failed to dispatch.
          req.log.warn({ err }, 'Failed to send verification email after profile update')
        }
      }

      reply.send({ user })
    },
  )
}
