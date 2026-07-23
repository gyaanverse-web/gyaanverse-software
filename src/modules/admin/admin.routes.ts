import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  approveAndScheduleExam, requestChanges, rejectExam,
  goLiveExam, endExam, extendExamTime, forceSubmitExam,
} from './admin.service.js'

// Admin = coaching_owner. Every route here is owner-only; `requireTenantRole`
// guarantees ownership in the resolved tenant, so we pass a fixed
// `coaching_owner` actor role (req.user.role is the global session role, which
// may not reflect the tenant membership).

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const

const AUTH = [{ bearerAuth: [] }]

const approveSchema = z.object({
  classIds: z.array(z.string().uuid()).optional(),
  scheduledAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  durationMins: z.number().int().min(1).max(600).optional(),
})
const remarksSchema = z.object({ remarks: z.string().min(1).max(2000) })
const extendSchema = z.object({ addMinutes: z.number().int().min(1).max(600) })

export async function adminRoutes(app: FastifyInstance) {
  const ownerAuth = [authenticate, tenantMiddleware, requireTenantRole('coaching_owner')]
  const actorOf = (req: { user?: { id: string } }) => ({ id: req.user!.id, role: 'coaching_owner' })

  // ── Review decisions ───────────────────────────────────────────────────────

  app.post('/tenant/exams/:id/approve', {
    schema: {
      tags: ['Admin'],
      summary: 'Approve & schedule an exam',
      description: 'Owner approves a submitted exam, optionally setting the class/batch assignment and run window, then schedules it (`under_review → approved → scheduled`).',
      security: AUTH,
      params: idParam,
      body: {
        type: 'object',
        properties: {
          classIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          scheduledAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          durationMins: { type: 'integer', minimum: 1, maximum: 600 },
        },
      },
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const parsed = approveSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const exam = await approveAndScheduleExam(id, req.tenant!.id, actorOf(req), {
      classIds: parsed.data.classIds,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined,
      durationMins: parsed.data.durationMins,
    })
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/request-changes', {
    schema: {
      tags: ['Admin'],
      summary: 'Request changes on a submitted exam',
      description: 'Owner bounces a submitted exam back to the teacher with remarks (`under_review → changes_requested`).',
      security: AUTH,
      params: idParam,
      body: {
        type: 'object',
        required: ['remarks'],
        properties: { remarks: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const parsed = remarksSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const exam = await requestChanges(id, req.tenant!.id, actorOf(req), parsed.data.remarks)
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/reject', {
    schema: {
      tags: ['Admin'],
      summary: 'Reject a submitted exam',
      description: 'Owner rejects a submitted exam with remarks (`under_review → rejected`).',
      security: AUTH,
      params: idParam,
      body: {
        type: 'object',
        required: ['remarks'],
        properties: { remarks: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const parsed = remarksSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const exam = await rejectExam(id, req.tenant!.id, actorOf(req), parsed.data.remarks)
    reply.send({ exam })
  })

  // ── Live controls ────────────────────────────────────────────────────────────

  app.post('/tenant/exams/:id/go-live', {
    schema: {
      tags: ['Admin'],
      summary: 'Start a scheduled exam now',
      description: 'Owner override to start a scheduled exam early (`scheduled → live`). The worker normally does this automatically at `scheduledAt`.',
      security: AUTH,
      params: idParam,
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const exam = await goLiveExam(id, req.tenant!.id, actorOf(req))
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/end', {
    schema: {
      tags: ['Admin'],
      summary: 'End a live exam now',
      description: 'Owner ends a live exam early: force-submits every active session, then transitions `live → under_evaluation`.',
      security: AUTH,
      params: idParam,
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const exam = await endExam(id, req.tenant!.id, actorOf(req))
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/extend-time', {
    schema: {
      tags: ['Admin'],
      summary: 'Extend a live exam',
      description: 'Owner extends a live exam by `addMinutes`, pushing back `endsAt` and every in-progress session\'s expiry.',
      security: AUTH,
      params: idParam,
      body: {
        type: 'object',
        required: ['addMinutes'],
        properties: { addMinutes: { type: 'integer', minimum: 1, maximum: 600 } },
      },
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const parsed = extendSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const exam = await extendExamTime(id, req.tenant!.id, actorOf(req), parsed.data.addMinutes)
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/force-submit', {
    schema: {
      tags: ['Admin'],
      summary: 'Force-submit all active sessions',
      description: 'Owner force-submits (and grades) every in-progress session for a live exam without ending the exam.',
      security: AUTH,
      params: idParam,
    },
    preHandler: ownerAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await forceSubmitExam(id, req.tenant!.id, actorOf(req))
    reply.send(result)
  })
}
