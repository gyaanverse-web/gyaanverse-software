import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '@shared/errors.js'
import { authenticate, requireTenantRole } from '@middleware/auth.middleware.js'
import { tenantMiddleware } from '@middleware/tenant.middleware.js'
import { assertHasFeature } from '@modules/billing/billing.service.js'
import {
  getExamEvaluationProgress,
  getJobForTenant,
  getSessionEvaluation,
  indexSyllabus,
  retryFailedEvaluationsForExam,
  retryJob,
} from './evaluation.service.js'

const indexSchema = z.object({
  collectionName: z.string().min(1).max(255).optional(),
  documents: z
    .array(
      z.object({
        document_id: z.string().min(1).optional(),
        text: z.string().min(1),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .min(1),
})

const AUTH = [{ bearerAuth: [] }]

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
      description: 'Returns the status and result of a single AI evaluation job. Use this to poll job progress.',
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

  // ── Teacher / owner: retry a failed or pending job ───────────────────────

  app.post('/tenant/evaluation/jobs/:jobId/retry', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Retry a failed evaluation job',
      description: 'Re-enqueues a failed or stalled evaluation job.',
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
    return retryJob(jobId, tenant.id)
  })

  // ── Teacher / owner: per-exam evaluation progress ────────────────────────
  //
  // Backs the "Under Evaluation" panel. An exam cannot reach Ready to Publish
  // while any session is unsettled, so this is how a teacher finds out that one
  // failed session is holding up the whole exam.

  app.get('/tenant/exams/:examId/evaluation-progress', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Evaluation progress for an exam',
      description:
        'Session counts by evaluation state plus any failed jobs. `pending` is exactly what blocks the exam from moving to `ready_to_publish`.',
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

  app.post('/tenant/exams/:examId/evaluation-progress/retry', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Retry all failed evaluations for an exam',
      description: 'Re-enqueues every failed evaluation job for the exam so it can reach `ready_to_publish`.',
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
    return retryFailedEvaluationsForExam(examId, tenant.id)
  })

  // ── Teacher / owner: index syllabus into Qdrant via the engine ──────────

  app.post('/tenant/evaluation/index', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Index syllabus documents into the RAG store',
      description: 'Uploads documents into the tenant\'s Qdrant vector collection for AI-assisted evaluation.',
      security: AUTH,
      body: {
        type: 'object',
        required: ['documents'],
        properties: {
          collectionName: { type: 'string', maxLength: 255, description: 'Custom Qdrant collection name (optional, defaults to tenant slug)' },
          documents: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['text'],
              properties: {
                document_id: { type: 'string' },
                text: { type: 'string', description: 'Document text content' },
                metadata: { type: 'object', description: 'Arbitrary metadata attached to the chunk' },
              },
            },
          },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req) => {
    const parsed = indexSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

    const tenant = req.tenant!
    // Indexing syllabus content into the RAG store is an AI feature — gate it.
    await assertHasFeature(tenant.id, 'api_access').catch(() => {
      // api_access is a stand-in until a dedicated `ai_indexing` feature flag exists;
      // for now allow all tenants to index against their own collection.
    })

    return indexSyllabus({
      documents: parsed.data.documents,
      collectionName: parsed.data.collectionName,
    })
  })

  // ── Student: poll own evaluation status + AI feedback ────────────────────

  app.get('/sessions/:sessionId/evaluation', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Get AI evaluation for a session',
      description: 'Returns the AI evaluation status and feedback for the student\'s submitted session. Returns `null` while still processing.',
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
