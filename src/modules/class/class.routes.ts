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
  reassignClassTeacher,
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

const reassignSchema = z.object({
  teacherId: z.string().uuid(),
})

const AUTH = [{ bearerAuth: [] }]

export async function classRoutes(app: FastifyInstance) {
  // ── Class CRUD ─────────────────────────────────────────────────────────────

  app.post(
    '/tenant/classes',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Create a class',
        description: 'Creates a new class (batch) within the resolved tenant. The authenticated teacher becomes the class owner. Enforces the plan\'s class limit.',
        security: AUTH,
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 255 },
            grade: { type: 'string', maxLength: 50, description: 'Grade level label (e.g. `Grade 10`)' },
            description: { type: 'string', maxLength: 1000 },
            autoApprove: { type: 'boolean', description: 'If true, students are approved instantly on join. Defaults to false.' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const tenant = req.tenant!
      const user = req.user!
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
    {
      schema: {
        tags: ['Classes'],
        summary: 'List classes',
        description: 'Returns classes visible to the authenticated user. Owners see all classes; teachers see their own; students see classes they are approved in or awaiting approval on, each carrying `enrollmentStatus`.',
        security: AUTH,
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')],
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const user = req.user!

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
    {
      schema: {
        tags: ['Classes'],
        summary: 'Preview a class via join code',
        description: 'Returns class info for the given join code. The student must already be a coaching member.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string' } },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { code } = req.params as { code: string }
      const result = await previewClassJoinCode(code)
      reply.send(result)
    },
  )

  app.post(
    '/tenant/classes/join/:code',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Join a class via join code',
        description: 'Enrols the authenticated student in the class. If `autoApprove` is false on the class, a pending enrollment is created and awaits teacher approval.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string' } },
        },
      },
      preHandler: [authenticate],
    },
    async (req, reply) => {
      const { code } = req.params as { code: string }
      const user = req.user!
      const result = await useClassJoinCode(user.id, code)
      reply.send(result)
    },
  )

  app.get(
    '/tenant/classes/:id',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Get a class',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const cls = await getClass(id, tenant.id)
      if (!cls) throw Errors.NOT_FOUND('Class')
      reply.send({ class: cls })
    },
  )

  app.patch(
    '/tenant/classes/:id',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Update a class',
        description: 'Updates class details. Teachers may only update their own classes.',
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
            grade: { type: 'string', maxLength: 50, nullable: true },
            description: { type: 'string', maxLength: 1000, nullable: true },
            autoApprove: { type: 'boolean' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const user = req.user!
      const updated = await updateClass(id, tenant.id, user.id, user.role, parsed.data)
      reply.send({ class: updated })
    },
  )

  // Reassign a batch to a different teacher — coaching_owner only.
  app.patch(
    '/tenant/classes/:id/teacher',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Reassign a class to another teacher',
        description: 'Moves ownership of the batch to another teacher (or the owner). Owner-only — teachers cannot reassign their own classes away.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['teacherId'],
          properties: { teacherId: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')],
    },
    async (req, reply) => {
      const parsed = reassignSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const updated = await reassignClassTeacher(id, tenant.id, parsed.data.teacherId)
      reply.send({ class: updated })
    },
  )

  app.delete(
    '/tenant/classes/:id',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Delete a class',
        description: 'Deletes the class and all associated join codes and enrollments. Teachers may only delete their own classes.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const user = req.user!
      const result = await deleteClass(id, tenant.id, user.id, user.role)
      reply.send(result)
    },
  )

  // ── Join codes (teacher/owner manages) ────────────────────────────────────

  app.post(
    '/tenant/classes/:id/join-codes',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Generate a class join code',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            expiresAt: { type: 'string', format: 'date-time' },
            maxUses: { type: 'integer', minimum: 1, maximum: 99999 },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const parsed = joinCodeSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const user = req.user!
      const record = await generateClassJoinCode(id, tenant.id, user.id, user.role, {
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
        maxUses: parsed.data.maxUses,
      })
      reply.status(201).send({ joinCode: record })
    },
  )

  app.get(
    '/tenant/classes/:id/join-codes',
    {
      schema: {
        tags: ['Classes'],
        summary: 'List class join codes',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const user = req.user!
      const codes = await listClassJoinCodes(id, tenant.id, user.id, user.role)
      reply.send({ joinCodes: codes })
    },
  )

  app.delete(
    '/tenant/classes/:id/join-codes/:codeId',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Revoke a class join code',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id', 'codeId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            codeId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const { id, codeId } = req.params as { id: string; codeId: string }
      const tenant = req.tenant!
      const user = req.user!
      const result = await revokeClassJoinCode(id, tenant.id, user.id, user.role, codeId)
      reply.send(result)
    },
  )

  // ── Student enrollment management (teacher/owner) ─────────────────────────

  app.get(
    '/tenant/classes/:id/students',
    {
      schema: {
        tags: ['Classes'],
        summary: 'List enrolled students',
        description: 'Lists students enrolled in the class. Filter by enrollment status with `?status=`. Staff see contact details; a student enrolled in the batch sees approved classmates by name only, and `?status=` is ignored for them.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const tenant = req.tenant!
      const user = req.user!
      const { status } = req.query as { status?: string }

      const allowed = ['pending', 'approved', 'rejected']
      if (status && !allowed.includes(status)) throw Errors.VALIDATION('status must be pending, approved, or rejected')

      // The service decides what a student may see — it also checks that this
      // student is actually approved in this batch before answering.
      const students = await listClassStudents(id, tenant.id, status, { role: user.role, id: user.id })
      reply.send({ students })
    },
  )

  app.patch(
    '/tenant/classes/:id/students/:studentId',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Approve or reject a student enrollment',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id', 'studentId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            studentId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['approve', 'reject'] },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const parsed = enrollmentActionSchema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

      const { id, studentId } = req.params as { id: string; studentId: string }
      const tenant = req.tenant!
      const user = req.user!
      const result = await updateEnrollmentStatus(id, tenant.id, studentId, user.id, user.role, parsed.data.action)
      reply.send(result)
    },
  )

  app.delete(
    '/tenant/classes/:id/students/:studentId',
    {
      schema: {
        tags: ['Classes'],
        summary: 'Remove a student from a class',
        description: 'Removes the student\'s enrollment row (pending or approved). Teachers may only remove students from their own classes.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['id', 'studentId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            studentId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const { id, studentId } = req.params as { id: string; studentId: string }
      const tenant = req.tenant!
      const user = req.user!
      const result = await removeStudentFromClass(id, tenant.id, studentId, user.id, user.role)
      reply.send(result)
    },
  )
}
