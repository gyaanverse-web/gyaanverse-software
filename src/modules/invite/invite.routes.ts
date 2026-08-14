import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import { createInvite, listInvites, revokeInvite, acceptInvite, getInvitePreview } from './invite.service.js'

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

const AUTH = [{ bearerAuth: [] }]

export async function inviteRoutes(app: FastifyInstance) {
  // POST /tenant/invites — coaching_owner sends a teacher invite (email or phone)
  app.post(
    '/tenant/invites',
    {
      schema: {
        tags: ['Invites'],
        summary: 'Send a teacher invite',
        description: 'Sends an invite link to the given email or phone number. The recipient must click the link and call `POST /invites/accept` with the token. Enforces the plan\'s teacher limit.',
        security: AUTH,
        body: {
          type: 'object',
          required: ['contact', 'contactType'],
          properties: {
            contact: { type: 'string', description: 'Email address or phone number of the invitee' },
            contactType: { type: 'string', enum: ['email', 'phone'] },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const parsed = createInviteSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = req.tenant!
      const { id: invitedBy } = req.user!
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
    {
      schema: {
        tags: ['Invites'],
        summary: 'List invites',
        description: 'Lists all invites for the resolved tenant. Filter by status with `?status=pending|accepted|revoked`.',
        security: AUTH,
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'accepted', 'revoked'] },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const { status } = req.query as { status?: string }
      const list = await listInvites(tenant.id, status)
      reply.send({ invites: list })
    },
  )

  // DELETE /tenant/invites/:id — revoke a pending invite
  app.delete(
    '/tenant/invites/:id',
    {
      schema: {
        tags: ['Invites'],
        summary: 'Revoke a pending invite',
        description: 'Cancels a pending invite. Cannot revoke an already-accepted or already-revoked invite.',
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
      const result = await revokeInvite(tenant.id, id)
      reply.send(result)
    },
  )

  // GET /invites/:token — public preview so the accept-invite landing page can
  // name the coaching and pick the right sign-in path before a session exists.
  // Returns 200 with state:"not_found" rather than 404 so the page renders one
  // consistent explanatory screen for every bad-token case.
  app.get(
    '/invites/:token',
    {
      schema: {
        tags: ['Invites'],
        summary: 'Preview an invite by token (public)',
        description: 'Unauthenticated lookup used by the accept-invite page. Returns the coaching name, role, contact channel and a masked contact, plus the invite state (`pending` | `accepted` | `revoked` | `expired` | `not_found`). Never returns the raw contact or tenant id.',
        params: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { token } = req.params as { token: string }
      reply.send(await getInvitePreview(token))
    },
  )

  // POST /invites/accept — authenticated teacher accepts their invite
  // No tenant middleware — the tenant is derived from the invite token itself.
  app.post(
    '/invites/accept',
    {
      schema: {
        tags: ['Invites'],
        summary: 'Accept a teacher invite',
        description: 'Accepts the invite token and adds the authenticated user as a teacher in the coaching. The user\'s email or phone must match the invite\'s contact. The token expires after 48 hours.',
        security: AUTH,
        body: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string', description: '32-character hex token from the invite link' },
          },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { token } = (req.body ?? {}) as { token?: string }
      if (!token || typeof token !== 'string') {
        throw Errors.VALIDATION('token is required')
      }
      const { id: userId } = req.user!
      const result = await acceptInvite(userId, token)
      reply.send(result)
    },
  )
}
