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
  listTeachersWithWorkload,
  removeMember,
  updateTenant,
  deleteCoaching,
  upgradePlan,
} from './tenant.service.js'
import { resolveEntitlements } from '../billing/billing.service.js'
import { requireBillingEnabled } from '../billing/billing.guard.js'
import {
  SLUG_MIN_LENGTH,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  slugRejectionReason,
} from '../../config/reserved-slugs.js'

const registerSchema = z.object({
  // Shape is checked here for a fast 400; `slugRejectionReason` re-runs the full
  // rule set (reserved names, punycode prefix) inside the service, which is the
  // authoritative guard for every caller.
  slug: z
    .string()
    .min(SLUG_MIN_LENGTH)
    .max(SLUG_MAX_LENGTH)
    .regex(SLUG_PATTERN, 'Slug must be lowercase letters, numbers, and inner hyphens only')
    .refine((s) => slugRejectionReason(s) === null, (s) => ({
      message: slugRejectionReason(s) ?? 'Invalid slug',
    })),
  name: z.string().min(2).max(255),
})

const addTeacherSchema = z.object({
  phone: z.string().min(10).max(15).regex(/^\+?[0-9]+$/, 'Invalid phone number'),
})

const joinSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
})

const updateTenantSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  logoUrl: z.string().url().nullable().optional(),
})

const upgradePlanSchema = z.object({
  plan: z.enum(['free', 'starter', 'growth', 'pro']),
})

const AUTH = [{ bearerAuth: [] }]

export async function tenantRoutes(app: FastifyInstance) {
  // ── Global routes (no tenant context) ──────────────────────────────────

  // Register a new coaching institute — caller becomes coaching_owner
  app.post(
    '/tenants',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Register a new coaching institute',
        description: 'Creates a new tenant (coaching institute). The authenticated user becomes the `coaching_owner`. The slug must be unique, lowercase, and contain only letters, numbers, and hyphens.',
        security: AUTH,
        body: {
          type: 'object',
          required: ['slug', 'name'],
          properties: {
            slug: { type: 'string', minLength: 3, maxLength: 63, description: 'URL-safe identifier (e.g. `sharma-classes`)' },
            name: { type: 'string', minLength: 2, maxLength: 255, description: 'Display name of the coaching institute' },
          },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const parsed = registerSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id: ownerId } = req.user!
      const result = await registerCoaching(ownerId, parsed.data)
      reply.status(201).send(result)
    },
  )

  // Get the coaching the current user belongs to
  app.get(
    '/tenants/me',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Get my coaching',
        description: 'Returns the coaching institute the authenticated user belongs to, plus `membershipRole` — the role they hold **in that coaching**. Gate tenant-scoped UI on `membershipRole`, not on the global session role: the two differ for anyone who belongs to more than one coaching.',
        security: AUTH,
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { id: userId } = req.user!
      const result = await getMyTenant(userId)
      if (!result) throw Errors.NOT_FOUND('Coaching')

      // Entitlements ride along with the tenant rather than living on their own
      // endpoint. Every screen already fetches this — it is one of the two calls
      // behind `lib/sessionStore` on the frontend — so the alternative was a
      // third request on every mount, with its own cache and its own TTL, to
      // answer a question that is a property of exactly this tenant.
      //
      // It also removes the reason the frontend had a copy of the plan matrix:
      // limits now arrive as data, so the client cannot drift from plans.ts.
      const entitlements = await resolveEntitlements(result.tenant.id)
      reply.send({ tenant: result.tenant, membershipRole: result.membershipRole, entitlements })
    },
  )

  // Get any tenant by ID — only expose fields safe for public consumption
  app.get(
    '/tenants/:id',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Get coaching by ID (public)',
        description: 'Returns safe public fields only (`id`, `slug`, `name`, `logoUrl`, `status`). No auth required.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = await getTenantById(id)
      if (!tenant) throw Errors.NOT_FOUND('Coaching')
      const { id: tenantId, slug, name, logoUrl, status } = tenant
      reply.send({ tenant: { id: tenantId, slug, name, logoUrl, status } })
    },
  )

  // Student joins a coaching by tenantId
  app.post(
    '/tenants/join',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Join a coaching by tenant ID',
        description: 'Directly joins the given coaching as a student using its `tenantId`. For the join-code flow see `POST /join/:code` under **Membership**.',
        security: AUTH,
        body: {
          type: 'object',
          required: ['tenantId'],
          properties: {
            tenantId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const parsed = joinSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id: userId } = req.user!
      const result = await joinAsStudent(userId, parsed.data.tenantId)
      reply.send(result)
    },
  )

  // Update coaching name / logo — owner only
  app.patch(
    '/tenants/:id',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Update coaching name / logo',
        description: 'Updates the coaching name or logo URL. Caller must be the `coaching_owner`.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 255 },
            logoUrl: { type: 'string', format: 'uri', nullable: true },
          },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const parsed = updateTenantSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const { id: userId } = req.user!
      const tenant = await updateTenant(id, userId, parsed.data)
      reply.send({ tenant })
    },
  )

  // Change plan — owner only, no payment required (payment integration skipped for now)
  //
  // Gated on `billing_enabled` alongside the billing routes proper. It is not a
  // billing route by file, but it is the one endpoint that mutates the input the
  // entitlement resolver reads, and it currently grants any plan for free. With
  // billing off the resolver ignores `tenants.plan` entirely, so leaving this
  // open would let an owner change a value that does nothing — and then quietly
  // takes effect the moment an operator flips the switch.
  app.patch(
    '/tenants/:id/plan',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Change subscription plan',
        description: 'Upgrades or downgrades the tenant plan. Caller must be the `coaching_owner`. Payment integration is handled separately via Razorpay.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['plan'],
          properties: {
            plan: { type: 'string', enum: ['free', 'starter', 'growth', 'pro'] },
          },
        },
      },
      preHandler: [requireBillingEnabled, authenticate],
    },
    async (req, reply) => {
      const parsed = upgradePlanSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const { id: userId } = req.user!
      const tenant = await upgradePlan(id, userId, parsed.data.plan)
      reply.send({ tenant })
    },
  )

  // Delete coaching — owner only, cascades all related data
  app.delete(
    '/tenants/:id',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Delete coaching institute',
        description: '⚠️ Permanently deletes the coaching and cascades all related data. Caller must be the `coaching_owner`.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { id: userId } = req.user!
      await deleteCoaching(id, userId)
      reply.send({ success: true })
    },
  )

  // ── Tenant-scoped routes (resolved via subdomain or ?tenant= query) ──────

  // Add a teacher — coaching_owner only
  app.post(
    '/tenant/teachers',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Add a teacher to the coaching',
        description: 'Looks up a user by phone number and adds them as a teacher. The user must already have a Gyaanverse account. Enforces the plan\'s teacher limit.',
        security: AUTH,
        body: {
          type: 'object',
          required: ['phone'],
          properties: {
            phone: { type: 'string', description: 'Phone number of the existing user (e.g. `+919876543210`)' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const parsed = addTeacherSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = req.tenant!
      const member = await addTeacher(tenant.id, parsed.data.phone)
      reply.status(201).send({ member })
    },
  )

  // List members — coaching_owner or teacher can view
  app.get(
    '/tenant/members',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'List coaching members',
        description: 'Returns all members of the resolved tenant. Filter by role using the `?role=` query param.',
        security: AUTH,
        querystring: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['coaching_owner', 'teacher', 'student'], description: 'Filter by role' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const role = (req.query as Record<string, string>)['role']
      const members = await listMembers(tenant.id, role)
      reply.send({ members })
    },
  )

  // Teachers roster with workload — coaching_owner only
  app.get(
    '/tenant/teachers',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'List teachers with workload',
        description: 'Returns every teacher in the resolved tenant with per-teacher workload: batches owned, approved students across those batches, and exams authored. Owner-only.',
        security: AUTH,
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const teachers = await listTeachersWithWorkload(tenant.id)
      reply.send({ teachers })
    },
  )

  // Remove a member — coaching_owner only
  app.delete(
    '/tenant/members/:userId',
    {
      schema: {
        tags: ['Tenants'],
        summary: 'Remove a member',
        description: 'Removes the user from the coaching. Cannot remove yourself or the owner.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string }
      const tenant = req.tenant!
      const requester = req.user!
      const result = await removeMember(tenant.id, userId, requester.id)
      reply.send(result)
    },
  )

  // NOTE: there is no `PATCH /tenant/settings`. It carried exactly two fields —
  // `allowPublicMocks` and `customDomain` — and both wrote columns that nothing in
  // this codebase ever read. Public-exam publishing is gated on the PLAN FEATURE
  // `public_mocks` (see `assertHasFeature` in exam.service / exam.generation.service),
  // never on the tenant flag, and tenant resolution is the `*.gyaanverse.com` slug
  // wildcard, never a custom domain. The route, the `tenant_settings` table and the
  // owner-facing form that fed them were removed together in migration 0022.
}
