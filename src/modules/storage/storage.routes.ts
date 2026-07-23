import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '@shared/errors.js'
import { authenticate, requireTenantRole } from '@middleware/auth.middleware.js'
import { tenantMiddleware } from '@middleware/tenant.middleware.js'
import {
  getAnswerUploadSignature,
  getTenantUploadSignature,
} from './storage.service.js'

const answerUploadSchema = z.object({
  sessionId: z.string().uuid(),
  questionId: z.string().uuid(),
  contentType: z.string().min(3).max(100),
})

const tenantUploadSchema = z.object({
  scope: z.enum(['question', 'syllabus', 'avatar']),
  contextKey: z.string().min(1).max(255).regex(/^[a-zA-Z0-9/_-]+$/),
  contentType: z.string().min(3).max(100),
})

const AUTH = [{ bearerAuth: [] }]

export async function storageRoutes(app: FastifyInstance) {
  // ── Student-facing: signed upload for an answer image ───────────────────
  // Frontend posts { sessionId, questionId, contentType }, gets back a
  // Cloudinary upload URL + signed form fields. The frontend then POSTs the
  // file directly to Cloudinary (multipart/form-data) and saves the returned
  // secure_url onto the answer via PATCH /sessions/:id/answers/:qid.

  app.post('/storage/answer-upload-signature', {
    schema: {
      tags: ['Storage'],
      summary: 'Get a signed upload URL for an answer image',
      description: `Returns Cloudinary signed upload parameters. Flow:
1. Call this endpoint to get the signature and upload params.
2. POST the file **directly to Cloudinary** (multipart/form-data) using the returned params.
3. Take the returned \`secure_url\` and save it via \`PATCH /sessions/:sessionId/answers/:questionId\`.`,
      security: AUTH,
      body: {
        type: 'object',
        required: ['sessionId', 'questionId', 'contentType'],
        properties: {
          sessionId: { type: 'string', format: 'uuid' },
          questionId: { type: 'string', format: 'uuid' },
          contentType: { type: 'string', description: 'MIME type of the file (e.g. `image/jpeg`)' },
        },
      },
    },
    preHandler: [authenticate],
  }, async (req) => {
    const parsed = answerUploadSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const user = req.user!
    return getAnswerUploadSignature({
      studentId: user.id,
      ...parsed.data,
    })
  })

  // ── Tenant staff: signed upload for question images, syllabus, branding ─

  const tenantAuth = [
    authenticate,
    tenantMiddleware,
    requireTenantRole('coaching_owner', 'teacher'),
  ]

  app.post('/tenant/storage/upload-signature', {
    schema: {
      tags: ['Storage'],
      summary: 'Get a signed upload URL for tenant assets',
      description: `Returns Cloudinary signed upload parameters for question images, syllabus documents, or branding assets.

**Scope values:**
- \`question\` — images attached to exam questions
- \`syllabus\` — syllabus PDFs indexed into the AI RAG store
- \`avatar\` — coaching logo / branding images`,
      security: AUTH,
      body: {
        type: 'object',
        required: ['scope', 'contextKey', 'contentType'],
        properties: {
          scope: { type: 'string', enum: ['question', 'syllabus', 'avatar'] },
          contextKey: { type: 'string', description: 'Folder/path key for organising uploads (alphanumeric, `/`, `_`, `-`)' },
          contentType: { type: 'string', description: 'MIME type of the file' },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req) => {
    const parsed = tenantUploadSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const tenant = req.tenant!
    return getTenantUploadSignature({
      tenantId: tenant.id,
      ...parsed.data,
    })
  })
}
