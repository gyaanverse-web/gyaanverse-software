import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import { createInvite, listInvites, revokeInvite, acceptInvite } from './invite.service.js'

const createInviteSchema = z
  .object({
    contact: z.string().min(1),
    contactType: z.enum(['email', 'phone']),
  })
  .refine(
    (data) => {
      if (data.contactType === 'email') return z.string().email().safeParse(data.contact).success
      if (data.contactType === 'phone') return /^\+?[0-9]{10,15}$/.test(data.contact)
      return false
    },
    { message: 'Invalid contact value for the given contactType' },
  )

export async function inviteRoutes(app: FastifyInstance) {
  // POST /tenant/invites — coaching_owner sends a teacher invite (email or phone)
  app.post(
    '/tenant/invites',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const parsed = createInviteSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = (req as any).tenant
      const { id: invitedBy } = (req as any).user
      const invite = await createInvite(
        tenant.id,
        invitedBy,
        parsed.data.contact,
        parsed.data.contactType,
      )
      reply.status(201).send({ invite })
    },
  )

  // GET /tenant/invites?status=pending — list invites for this coaching
  app.get(
    '/tenant/invites',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const tenant = (req as any).tenant
      const { status } = req.query as { status?: string }
      const list = await listInvites(tenant.id, status)
      reply.send({ invites: list })
    },
  )

  // DELETE /tenant/invites/:id — revoke a pending invite
  app.delete(
    '/tenant/invites/:id',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const result = await revokeInvite(tenant.id, id)
      reply.send(result)
    },
  )

  // POST /invites/accept — authenticated teacher accepts their invite
  // No tenant middleware — the tenant is derived from the invite token itself.
  app.post('/invites/accept', { preHandler: [authenticate] }, async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string }
    if (!token || typeof token !== 'string') {
      throw Errors.VALIDATION('token is required')
    }
    const { id: userId } = (req as any).user
    const result = await acceptInvite(userId, token)
    reply.send(result)
  })
}
