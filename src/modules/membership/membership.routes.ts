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

export async function membershipRoutes(app: FastifyInstance) {
  // ── Owner: manage coaching join codes (tenant-scoped) ───────────────────

  // Generate a new join code
  app.post(
    '/tenant/join-code',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const parsed = createCodeSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = (req as any).tenant
      const user = (req as any).user
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
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const tenant = (req as any).tenant
      const codes = await listCoachingJoinCodes(tenant.id)
      reply.send({ joinCodes: codes })
    },
  )

  // Revoke a join code
  app.delete(
    '/tenant/join-code/:id',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const result = await revokeCoachingJoinCode(tenant.id, id)
      reply.send(result)
    },
  )

  // ── Student: use a join code (global routes, no tenant context needed) ──

  // Preview coaching info before joining — public, no auth
  app.get('/join/:code', async (req, reply) => {
    const { code } = req.params as { code: string }
    const result = await previewCoachingJoinCode(code.toUpperCase())
    reply.send(result)
  })

  // Join a coaching via code — must be authenticated
  app.post('/join/:code', { preHandler: [authenticate] }, async (req, reply) => {
    const { code } = req.params as { code: string }
    const { id: userId } = (req as any).user
    const result = await useCoachingJoinCode(userId, code.toUpperCase())
    reply.send(result)
  })
}
