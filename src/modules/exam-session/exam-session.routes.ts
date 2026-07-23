import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  startSession, saveAnswer, submitSession,
  getSession, getResults, listSessionsForExam,
} from './exam-session.service.js'

const saveAnswerSchema = z.object({
  answer: z.record(z.unknown()).nullable().optional(),
  imageUrl: z.string().url().optional(),
})

const AUTH = [{ bearerAuth: [] }]

export async function examSessionRoutes(app: FastifyInstance) {
  // ── Student-facing (no tenant context required) ───────────────────────────

  app.post('/exams/:examId/sessions/start', {
    schema: {
      tags: ['Exam Sessions'],
      summary: 'Start an exam attempt',
      description: 'Creates a new session for the authenticated student. Validates attempt limits and exam availability.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['examId'],
        properties: { examId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { examId } = req.params as { examId: string }
    const user = req.user!
    // Pass tenant from resolved context if present, otherwise null
    const session = await startSession(user.id, examId, req.tenant?.id ?? null)
    reply.status(201).send({ session })
  })

  app.get('/sessions/:sessionId', {
    schema: {
      tags: ['Exam Sessions'],
      summary: 'Get an active session',
      description: 'Returns session state plus `remainingSecs` — the time left until auto-submit.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const user = req.user!
    const session = await getSession(sessionId, user.id)
    // Include time remaining
    const now = new Date()
    const remainingSecs = Math.max(0, Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000))
    reply.send({ session, remainingSecs })
  })

  app.patch('/sessions/:sessionId/answers/:questionId', {
    schema: {
      tags: ['Exam Sessions'],
      summary: 'Save / update an answer',
      description: 'Saves a draft answer for the given question. Can be called multiple times before submit — last write wins.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['sessionId', 'questionId'],
        properties: {
          sessionId: { type: 'string', format: 'uuid' },
          questionId: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          answer: { type: 'object', nullable: true, description: 'Type-specific answer payload (null = clear answer)' },
          imageUrl: { type: 'string', format: 'uri', description: 'Cloudinary URL for subjective image answers' },
        },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const parsed = saveAnswerSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { sessionId, questionId } = req.params as { sessionId: string; questionId: string }
    const user = req.user!
    const answer = await saveAnswer(
      sessionId,
      user.id,
      questionId,
      parsed.data.answer ?? null,
      parsed.data.imageUrl,
    )
    reply.send({ answer })
  })

  app.post('/sessions/:sessionId/submit', {
    schema: {
      tags: ['Exam Sessions'],
      summary: 'Submit an exam attempt',
      description: 'Finalises the session, triggers auto-grading, and enqueues AI evaluation for subjective questions.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const user = req.user!
    const session = await submitSession(sessionId, user.id)
    reply.send({ session })
  })

  app.get('/sessions/:sessionId/results', {
    schema: {
      tags: ['Exam Sessions'],
      summary: 'Get session results',
      description: 'Returns scores, per-question breakdown, and correct answers for a submitted session.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const user = req.user!
    const results = await getResults(sessionId, user.id)
    reply.send({ results })
  })

  // ── Teacher-facing (tenant context required) ──────────────────────────────

  app.get(
    '/tenant/exams/:examId/sessions',
    {
      schema: {
        tags: ['Exam Sessions'],
        summary: 'List all attempts for an exam (teacher view)',
        description: 'Returns all sessions for the exam. Teachers see only sessions for their own exams; owners see all.',
        security: AUTH,
        params: {
          type: 'object',
          required: ['examId'],
          properties: { examId: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    },
    async (req, reply) => {
      const { examId } = req.params as { examId: string }
      const tenant = req.tenant!
      const user = req.user!
      const sessions = await listSessionsForExam(examId, tenant.id, user.id, user.role)
      reply.send({ sessions })
    },
  )
}
