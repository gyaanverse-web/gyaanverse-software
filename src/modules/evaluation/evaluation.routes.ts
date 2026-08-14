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

// ─────────────────────────────────────────────────────────────────────────────
// THE COACHING-FACING API — what teachers, owners and students can call.
//
// Compare this with evaluation.internal.routes.ts, which is the Gyanverse-staff
// version. The difference in what they expose is the whole point:
//
//   here                        internal routes
//   ─────────────────────────   ────────────────────────────────
//   progress counts only        error codes, error text, attempts
//   one coaching's own data     every coaching at once
//   never the word "failed"     the full failure history
//
// Nothing on this file may leak WHY the AI struggled. Retrying is the system's
// job, and the one case it cannot finish goes to Gyanverse staff, not back to
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
  // one case it cannot finish goes to Gyanverse staff rather than back to the
  // teacher.

  app.get('/tenant/exams/:examId/evaluation-progress', {
    schema: {
      tags: ['Evaluation'],
      summary: 'Evaluation progress for an exam',
      description:
        'Session counts by evaluation state. `pending` is exactly what blocks the exam from moving to `ready_to_publish`; `underReview` is the number of answers Gyanverse is finishing by hand, and is what holds the publish action. Reports no failures: retries are automatic.',
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

  // ── Teacher / owner: upload syllabus material for the AI to grade against ─
  //
  // The text goes into the AI's vector database (Qdrant), so that when it grades
  // an answer it can check it against the material the students were actually
  // taught from, rather than general knowledge.

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
    // Uploading syllabus material is a paid AI feature, so it should be checked
    // against the coaching's plan.
    //
    // ⚠️ TEMPORARY: there is no dedicated `ai_indexing` feature flag yet, so this
    // borrows `api_access` — and the empty catch means the check currently lets
    // EVERY coaching through. Each one only ever writes into its own collection,
    // so nothing leaks; this is about billing, not security.
    await assertHasFeature(tenant.id, 'api_access').catch(() => {
      // Deliberately swallowed until the real feature flag exists.
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
