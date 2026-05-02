import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  createClass,
  getClass,
  updateClass,
  deleteClass,
  getAllClasses,
  getClassesForTeacher,
  getClassesForStudent,
  generateClassJoinCode,
  listClassJoinCodes,
  revokeClassJoinCode,
  previewClassJoinCode,
  useClassJoinCode,
  listClassStudents,
  updateEnrollmentStatus,
  removeStudentFromClass,
} from './class.service.js'

const createSchema = z.object({
  name: z.string().min(2).max(255),
  grade: z.string().min(1).max(50).optional(),
  description: z.string().max(1000).optional(),
  autoApprove: z.boolean().optional(),
})

const updateSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  grade: z.string().min(1).max(50).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  autoApprove: z.boolean().optional(),
})

const joinCodeSchema = z.object({
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().min(1).max(99999).optional(),
})

const enrollmentActionSchema = z.object({
  action: z.enum(['approve', 'reject']),
})

export async function classRoutes(app: FastifyInstance) {
  // ── Class CRUD ─────────────────────────────────────────────────────────────

  app.post(
    '/tenant/classes',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = (req as any).tenant
      const user = (req as any).user
      const cls = await createClass({
        tenantId: tenant.id,
        teacherId: user.id,
        ...parsed.data,
      })
      reply.status(201).send({ class: cls })
    },
  )

  app.get(
    '/tenant/classes',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')] },
    async (req, reply) => {
      const tenant = (req as any).tenant
      const user = (req as any).user

      let classList
      if (user.role === 'student') {
        classList = await getClassesForStudent(user.id, tenant.id)
      } else if (user.role === 'teacher') {
        classList = await getClassesForTeacher(user.id, tenant.id)
      } else {
        classList = await getAllClasses(tenant.id)
      }

      reply.send({ classes: classList })
    },
  )

  // Static /join segment must be registered before /:id to take priority in router
  app.get(
    '/tenant/classes/join/:code',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const { code } = req.params as { code: string }
      const result = await previewClassJoinCode(code)
      reply.send(result)
    },
  )

  app.post(
    '/tenant/classes/join/:code',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const { code } = req.params as { code: string }
      const user = (req as any).user
      const result = await useClassJoinCode(user.id, code)
      reply.send(result)
    },
  )

  app.get(
    '/tenant/classes/:id',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const cls = await getClass(id, tenant.id)
      if (!cls) throw Errors.NOT_FOUND('Class')
      reply.send({ class: cls })
    },
  )

  app.patch(
    '/tenant/classes/:id',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const updated = await updateClass(id, tenant.id, user.id, user.role, parsed.data)
      reply.send({ class: updated })
    },
  )

  app.delete(
    '/tenant/classes/:id',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const result = await deleteClass(id, tenant.id, user.id, user.role)
      reply.send(result)
    },
  )

  // ── Join codes (teacher/owner manages) ────────────────────────────────────

  app.post(
    '/tenant/classes/:id/join-codes',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const parsed = joinCodeSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const record = await generateClassJoinCode(id, tenant.id, user.id, user.role, {
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
        maxUses: parsed.data.maxUses,
      })
      reply.status(201).send({ joinCode: record })
    },
  )

  app.get(
    '/tenant/classes/:id/join-codes',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const codes = await listClassJoinCodes(id, tenant.id, user.id, user.role)
      reply.send({ joinCodes: codes })
    },
  )

  app.delete(
    '/tenant/classes/:id/join-codes/:codeId',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const { id, codeId } = req.params as { id: string; codeId: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const result = await revokeClassJoinCode(id, tenant.id, user.id, user.role, codeId)
      reply.send(result)
    },
  )

  // ── Student enrollment management (teacher/owner) ─────────────────────────

  app.get(
    '/tenant/classes/:id/students',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = (req as any).tenant
      const { status } = req.query as { status?: string }

      const allowed = ['pending', 'approved', 'rejected']
      if (status && !allowed.includes(status)) throw Errors.VALIDATION('status must be pending, approved, or rejected')

      const students = await listClassStudents(id, tenant.id, status)
      reply.send({ students })
    },
  )

  app.patch(
    '/tenant/classes/:id/students/:studentId',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const parsed = enrollmentActionSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id, studentId } = req.params as { id: string; studentId: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const result = await updateEnrollmentStatus(id, tenant.id, studentId, user.id, user.role, parsed.data.action)
      reply.send(result)
    },
  )

  app.delete(
    '/tenant/classes/:id/students/:studentId',
    { preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')] },
    async (req, reply) => {
      const { id, studentId } = req.params as { id: string; studentId: string }
      const tenant = (req as any).tenant
      const user = (req as any).user
      const result = await removeStudentFromClass(id, tenant.id, studentId, user.id, user.role)
      reply.send(result)
    },
  )
}
