import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  generateCoachingJoinCode,
  listCoachingJoinCodes,
  revokeCoachingJoinCode,
  previewCoachingJoinCode,
  useCoachingJoinCode,
} from './membership.service.js'

const createCodeSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().min(1).max(99999).optional(),
})

const AUTH = [{ bearerAuth: [] }]

export async function membershipRoutes(app: FastifyInstance) {
  // ── Owner: manage coaching join codes (tenant-scoped) ───────────────────

  // Generate a new join code
  app.post(
    '/tenant/join-code',
    {
      schema: {
        tags: ['Membership'],
        summary: 'Generate a coaching join code',
        description: 'Creates a new join code that students can use to enroll in this coaching. Optionally set an expiry date and max usage count.',
        security: AUTH,
        body: {
          type: 'object',
          properties: {
            expiresAt: { type: 'string', format: 'date-time', description: 'ISO 8601 expiry timestamp (optional)' },
            maxUses: { type: 'integer', minimum: 1, maximum: 99999, description: 'Maximum number of times this code can be used (optional)' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const parsed = createCodeSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = req.tenant!
      const user = req.user!
      const record = await generateCoachingJoinCode(tenant.id, user.id, {
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
        maxUses: parsed.data.maxUses,
      })
      reply.status(201).send({ joinCode: record })
    },
  )

  // List active join codes
  app.get(
    '/tenant/join-code',
    {
      schema: {
        tags: ['Membership'],
        summary: 'List coaching join codes',
        description: 'Returns all active (non-revoked) coaching join codes for the resolved tenant.',
        security: AUTH,
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const codes = await listCoachingJoinCodes(tenant.id)
      reply.send({ joinCodes: codes })
    },
  )

  // Revoke a join code
  app.delete(
    '/tenant/join-code/:id',
    {
      schema: {
        tags: ['Membership'],
        summary: 'Revoke a coaching join code',
        description: 'Marks the join code as revoked so it can no longer be used.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const result = await revokeCoachingJoinCode(tenant.id, id)
      reply.send(result)
    },
  )

  // ── Student: use a join code (global routes, no tenant context needed) ──

  // Preview coaching info before joining — public, no auth
  app.get(
    '/join/:code',
    {
      schema: {
        tags: ['Membership'],
        summary: 'Preview coaching via join code (public)',
        description: 'Returns basic coaching info (name, logo) for a given join code without requiring authentication. Use this to show a preview screen before the user commits to joining.',
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', description: 'Uppercase join code (e.g. `ABC12345`)' } },
        },
      },
    },
    async (req, reply) => {
      const { code } = req.params as { code: string }
      const result = await previewCoachingJoinCode(code.toUpperCase())
      reply.send(result)
    },
  )

  // Join a coaching via code — must be authenticated
  app.post(
    '/join/:code',
    {
      schema: {
        tags: ['Membership'],
        summary: 'Join a coaching via join code',
        description: 'Enrols the authenticated user as a student in the coaching associated with the code. Validates expiry, revocation status, and usage limits.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', description: 'Uppercase join code (e.g. `ABC12345`)' } },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { code } = req.params as { code: string }
      const { id: userId } = req.user!
      const result = await useCoachingJoinCode(userId, code.toUpperCase())
      reply.send(result)
    },
  )
}
