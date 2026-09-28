import type { FastifyInstance } from 'fastify'
import { authenticate, requireTenantRole } from '@middleware/auth.middleware.js'
import { tenantMiddleware } from '@middleware/tenant.middleware.js'
import {
  getExamEvaluationProgress,
  getJobForTenant,
  getSessionEvaluation,
} from './evaluation.service.js'

const AUTH = [{ bearerAuth: [] }]

// ─────────────────────────────────────────────────────────────────────────────
// THE COACHING-FACING API — what teachers, owners and students can call.
//
// Compare this with evaluation.internal.routes.ts, which is the Gyaanverse-staff
// version. The difference in what they expose is the whole point:
//
//   here                        internal routes
//   ─────────────────────────   ────────────────────────────────
//   progress counts only        error codes, error text, attempts
//   one coaching's own data     every coaching at once
//   never the word "failed"     the full failure history
//
// Nothing on this file may leak WHY the AI struggled. Retrying is the system's
// job, and the one case it cannot finish goes to Gyaanverse staff, not back to
// the teacher.
// ─────────────────────────────────────────────────────────────────────────────

export async function evaluationRoutes(app: FastifyInstance) {
  const tenantAuth = [
    authenticate,
    tenantMiddleware,
    requireTenantRole('coaching_owner', 'teacher'),
  ]

  // ── Teacher / owner: inspect a single job ────────────────────────────────

  app.get('/tenant/evaluation/jobs/:jobId', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Get an evaluation job',
      description:
        'Returns the status and per-question results of a single AI evaluation job. Use this to poll job progress. Progress only — no error detail, and a job between retry attempts reports `processing`; evaluation retries itself and needs nothing from the caller.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req) => {
    const { jobId } = req.params as { jobId: string }
    const tenant = req.tenant!
    return getJobForTenant(jobId, tenant.id)
  })

  // ── Teacher / owner: how far along is this exam? ─────────────────────────
  //
  // Feeds the "Under Evaluation" panel: how much of the class is done, and
  // nothing else.
  //
  // There is deliberately no retry button beside it. The two POST routes that
  // used to sit here were deleted, because evaluation now retries itself and the
  // one case it cannot finish goes to Gyaanverse staff rather than back to the
  // teacher.

  app.get('/tenant/exams/:examId/evaluation-progress', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Evaluation progress for an exam',
      description:
        'Session counts by evaluation state. `pending` is exactly what blocks the exam from moving to `ready_to_publish`; `underReview` is the number of answers Gyaanverse is finishing by hand, and is what holds the publish action. Reports no failures: retries are automatic.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['examId'],
        properties: { examId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req) => {
    const { examId } = req.params as { examId: string }
    const tenant = req.tenant!
    return getExamEvaluationProgress(examId, tenant.id)
  })

  // ── Student: poll own evaluation status + AI feedback ────────────────────

  app.get('/sessions/:sessionId/evaluation', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Get AI evaluation for a session',
      description: 'Returns the AI evaluation status and feedback for the student\'s submitted session. Returns `null` before evaluation starts. Status is `pending` | `processing` | `completed` only — a job between retry attempts reports `processing`, so poll until `completed`.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['sessionId'],
        properties: { sessionId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req) => {
    const { sessionId } = req.params as { sessionId: string }
    const user = req.user!
    return getSessionEvaluation(sessionId, user.id)
  })
}
