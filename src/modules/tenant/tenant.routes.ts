import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  getTenantById,
  registerCoaching,
  addTeacher,
  joinAsStudent,
  getMyTenant,
  listMembers,
  removeMember,
  updateSettings,
  updateTenant,
  deleteCoaching,
} from './tenant.service.js'

const registerSchema = z.object({
  slug: z.string().min(3).max(63).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, and hyphens'),
  name: z.string().min(2).max(255),
})

const addTeacherSchema = z.object({
  phone: z.string().min(10).max(15).regex(/^\+?[0-9]+$/, 'Invalid phone number'),
})

const joinSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
})

const settingsSchema = z.object({
  allowPublicMocks: z.boolean().optional(),
  customDomain: z.string().nullable().optional(),
})

const updateTenantSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  logoUrl: z.string().url().nullable().optional(),
})

export async function tenantRoutes(app: FastifyInstance) {
  // ── Global routes (no tenant context) ──────────────────────────────────

  // Register a new coaching institute — caller becomes coaching_owner
  app.post('/tenants', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

    const { id: ownerId } = (req as any).user
    const result = await registerCoaching(ownerId, parsed.data)
    reply.status(201).send(result)
  })

  // Get the coaching the current user belongs to
  app.get('/tenants/me', { preHandler: [authenticate] }, async (req, reply) => {
    const { id: userId } = (req as any).user
    const tenant = await getMyTenant(userId)
    if (!tenant) throw Errors.NOT_FOUND('Coaching')
    reply.send({ tenant })
  })

  // Get any tenant by ID — only expose fields safe for public consumption
  app.get('/tenants/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = await getTenantById(id)
    if (!tenant) throw Errors.NOT_FOUND('Coaching')
    const { id: tenantId, slug, name, logoUrl, status } = tenant
    reply.send({ tenant: { id: tenantId, slug, name, logoUrl, status } })
  })

  // Student joins a coaching by tenantId
  app.post('/tenants/join', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = joinSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

    const { id: userId } = (req as any).user
    const result = await joinAsStudent(userId, parsed.data.tenantId)
    reply.send(result)
  })

  // Update coaching name / logo — owner only
  app.patch('/tenants/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = updateTenantSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

    const { id } = req.params as { id: string }
    const { id: userId } = (req as any).user
    const tenant = await updateTenant(id, userId, parsed.data)
    reply.send({ tenant })
  })

  // Delete coaching — owner only, cascades all related data
  app.delete('/tenants/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { id: userId } = (req as any).user
    await deleteCoaching(id, userId)
    reply.send({ success: true })
  })

  // ── Tenant-scoped routes (resolved via subdomain or ?tenant= query) ──────

  // Add a teacher — coaching_owner only
  app.post(
    '/tenant/teachers',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const parsed = addTeacherSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = (req as any).tenant
      const member = await addTeacher(tenant.id, parsed.data.phone)
      reply.status(201).send({ member })
    },
  )

  // List members — coaching_owner or teacher can view
  app.get(
    '/tenant/members',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const tenant = (req as any).tenant
      const role = (req.query as Record<string, string>)['role']
      const members = await listMembers(tenant.id, role)
      reply.send({ members })
    },
  )

  // Remove a member — coaching_owner only
  app.delete(
    '/tenant/members/:userId',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string }
      const tenant = (req as any).tenant
      const requester = (req as any).user
      const result = await removeMember(tenant.id, userId, requester.id)
      reply.send(result)
    },
  )

  // Update coaching settings — coaching_owner only
  app.patch(
    '/tenant/settings',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')] },
    async (req, reply) => {
      const parsed = settingsSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = (req as any).tenant
      await updateSettings(tenant.id, parsed.data)
      reply.send({ success: true })
    },
  )
}
