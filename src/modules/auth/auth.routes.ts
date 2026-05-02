import type { FastifyInstance } from 'fastify'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../../config/auth.js'
import { authenticate } from '../../middleware/auth.middleware.js'
import { getCurrentUser, updateProfile, updateProfileSchema } from './auth.service.js'

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
  app.post('/api/auth/request-password-reset', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string }

    if (!email || typeof email !== 'string') {
      return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'email is required' })
    }

    const normalized = email.trim().toLowerCase()
    const generic = { message: 'If an account with that email exists, a reset link has been sent.' }

    // Phone-only accounts — silently skip without revealing whether the account exists
    if (normalized.endsWith('@phone.gyanverse.app')) {
      return reply.send(generic)
    }

    await auth.api.requestPasswordReset({
      body: { email: normalized, redirectTo: '/reset-password' },
    })

    reply.send(generic)
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    async handler(req, reply) {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const request = new Request(url.toString(), {
        method: req.method,
        headers: fromNodeHeaders(req.headers),
        body: req.method !== 'GET' && req.body ? JSON.stringify(req.body) : undefined,
      })

      const response = await auth.handler(request)

      reply.status(response.status)
      response.headers.forEach((value, key) => reply.header(key, value))
      reply.send(await response.text())
    },
  })

  // GET  /api/auth/me  — current user
  app.get('/api/auth/me', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = (req as any).user
    const user = await getCurrentUser(id)
    reply.send({ user })
  })

  // PATCH /api/auth/me  — complete / update profile
  // Phone users (emailVerified = false): { name, email? }
  //   Updating email resets emailVerified to false and sends a verification link.
  // Email users (emailVerified = true): { name } only — email cannot be changed.
  app.patch('/api/auth/me', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = updateProfileSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(422).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues })
    }

    const { id } = (req as any).user
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
        await auth.api.sendVerificationEmail({
          body: { email: parsed.data.email!, callbackURL: '/dashboard' },
          headers: fromNodeHeaders(req.headers),
        })
      } catch (err) {
        // Non-fatal: profile is saved, verification email failed to dispatch.
        req.log.warn({ err }, 'Failed to send verification email after profile update')
      }
    }

    reply.send({ user })
  })
}
