import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireRole, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  createSubject, listSubjects, updateSubject, deleteSubject,
  createModule, listModules, updateModule, deleteModule,
  createChapter, listChapters, updateChapter, deleteChapter,
  createSection, listSections, updateSection, deleteSection,
  createConcept, listConcepts, updateConcept, deleteConcept,
  createBankQuestion, listBankQuestions, getBankQuestion, updateBankQuestion,
  verifyBankQuestion, flagBankQuestion, archiveBankQuestion,
  countBankQuestionsBySubject, getBankAvailability,
} from './question-bank.service.js'

const AUTH = [{ bearerAuth: [] }]

// ── Request schemas ───────────────────────────────────────────────────────────

const QUESTION_TYPES = ['mcq_single', 'mcq_multiple', 'integer', 'numerical', 'subjective', 'match', 'assertion_reason', 'fill_blanks'] as const

const namedSchema = z.object({ name: z.string().min(1).max(255), order: z.number().int().nonnegative().optional() })
const subjectSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50).optional(),
  gradeLevel: z.string().min(1).max(50).optional(),
  language: z.string().min(2).max(10).optional(),
})
const conceptSchema = z.object({ name: z.string().min(1).max(255), description: z.string().max(2000).optional() })

const subjectUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().max(50).nullable().optional(),
  gradeLevel: z.string().max(50).nullable().optional(),
  language: z.string().min(2).max(10).optional(),
  status: z.enum(['active', 'archived']).optional(),
})
const orderedUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  order: z.number().int().nonnegative().optional(),
  status: z.enum(['active', 'archived']).optional(),
})
const conceptUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
})

const hierarchyInput = z.object({
  subjectId: z.string().uuid().optional(),
  moduleId: z.string().uuid().optional(),
  chapterId: z.string().uuid().optional(),
  sectionId: z.string().uuid().optional(),
  conceptId: z.string().uuid().optional(),
})

// Wizard availability preview. `chapterIds` is a comma-separated list so the
// whole request stays a simple GET query.
const availabilitySchema = z.object({
  subjectId: z.string().uuid(),
  chapterIds: z.string().optional(),
  verifiedOnly: z.union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
})

const bankQuestionSchema = z.object({
  hierarchy: hierarchyInput,
  type: z.enum(QUESTION_TYPES),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  body: z.string().min(1).max(5000),
  imageUrls: z.array(z.string().url()).max(5).optional(),
  payload: z.record(z.unknown()),
  answerKey: z.record(z.unknown()),
  defaultMarks: z.number().int().min(1).max(1000).optional(),
  defaultNegativeMarks: z.number().int().min(0).max(1000).optional(),
  explanation: z.string().max(5000).optional(),
  explanationImageUrls: z.array(z.string().url()).max(5).optional(),
  solutionVideoUrl: z.string().url().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  language: z.string().min(2).max(10).optional(),
  source: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const bankUpdateSchema = bankQuestionSchema.partial().omit({ type: true }).extend({
  imageUrls: z.array(z.string().url()).max(5).nullable().optional(),
  explanation: z.string().max(5000).nullable().optional(),
  explanationImageUrls: z.array(z.string().url()).max(5).nullable().optional(),
  solutionVideoUrl: z.string().url().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).nullable().optional(),
  source: z.record(z.unknown()).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
})

const flagSchema = z.object({ reason: z.string().min(1).max(500) })

const listFiltersSchema = z.object({
  subjectId: z.string().uuid().optional(),
  moduleId: z.string().uuid().optional(),
  chapterId: z.string().uuid().optional(),
  sectionId: z.string().uuid().optional(),
  conceptId: z.string().uuid().optional(),
  type: z.enum(QUESTION_TYPES).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  status: z.enum(['draft', 'active', 'flagged', 'archived']).optional(),
  isVerified: z.coerce.boolean().optional(),
  language: z.string().min(2).max(10).optional(),
  search: z.string().max(200).optional(),
})

// ── Shared route group ────────────────────────────────────────────────────────
//
// Registered twice: under `/tenant` for institute content (owner + teacher) and
// under `/admin` for global Gyaanverse content (super_admin). `scopeOf` decides
// which pool a write lands in — a tenant UUID, or null for global.

function registerCatalogAndBank(
  app: FastifyInstance,
  prefix: string,
  preHandler: preHandlerHookHandler[],
  scopeOf: (req: FastifyRequest) => string | null,
) {
  const tag = prefix === '/admin' ? 'Question Bank (Global)' : 'Question Bank'

  // ── Hierarchy: subjects ──
  app.post(`${prefix}/subjects`, {
    schema: { tags: [tag], summary: 'Create a subject', security: AUTH,
      body: { type: 'object', required: ['name'], properties: {
        name: { type: 'string', maxLength: 255 }, code: { type: 'string', maxLength: 50 },
        gradeLevel: { type: 'string', maxLength: 50 }, language: { type: 'string', maxLength: 10 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = subjectSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const subject = await createSubject({ tenantId: scopeOf(req), createdBy: req.user!.id, ...parsed.data })
    reply.status(201).send({ subject })
  })

  app.get(`${prefix}/subjects`, {
    schema: { tags: [tag], summary: 'List subjects (global + own)', security: AUTH },
    preHandler,
  }, async (req, reply) => {
    reply.send({ subjects: await listSubjects(scopeOf(req)) })
  })

  // ── Hierarchy: modules ──
  app.post(`${prefix}/subjects/:subjectId/modules`, {
    schema: { tags: [tag], summary: 'Create a module', security: AUTH,
      params: { type: 'object', required: ['subjectId'], properties: { subjectId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 255 }, order: { type: 'integer', minimum: 0 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = namedSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { subjectId } = req.params as { subjectId: string }
    const module = await createModule({ tenantId: scopeOf(req), createdBy: req.user!.id, subjectId, ...parsed.data })
    reply.status(201).send({ module })
  })

  app.get(`${prefix}/subjects/:subjectId/modules`, {
    schema: { tags: [tag], summary: 'List modules for a subject', security: AUTH,
      params: { type: 'object', required: ['subjectId'], properties: { subjectId: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { subjectId } = req.params as { subjectId: string }
    reply.send({ modules: await listModules(subjectId, scopeOf(req)) })
  })

  // ── Hierarchy: chapters ──
  app.post(`${prefix}/modules/:moduleId/chapters`, {
    schema: { tags: [tag], summary: 'Create a chapter', security: AUTH,
      params: { type: 'object', required: ['moduleId'], properties: { moduleId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 255 }, order: { type: 'integer', minimum: 0 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = namedSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { moduleId } = req.params as { moduleId: string }
    const chapter = await createChapter({ tenantId: scopeOf(req), createdBy: req.user!.id, moduleId, ...parsed.data })
    reply.status(201).send({ chapter })
  })

  app.get(`${prefix}/modules/:moduleId/chapters`, {
    schema: { tags: [tag], summary: 'List chapters for a module', security: AUTH,
      params: { type: 'object', required: ['moduleId'], properties: { moduleId: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { moduleId } = req.params as { moduleId: string }
    reply.send({ chapters: await listChapters(moduleId, scopeOf(req)) })
  })

  // ── Hierarchy: sections ──
  app.post(`${prefix}/chapters/:chapterId/sections`, {
    schema: { tags: [tag], summary: 'Create a section', security: AUTH,
      params: { type: 'object', required: ['chapterId'], properties: { chapterId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 255 }, order: { type: 'integer', minimum: 0 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = namedSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { chapterId } = req.params as { chapterId: string }
    const section = await createSection({ tenantId: scopeOf(req), createdBy: req.user!.id, chapterId, ...parsed.data })
    reply.status(201).send({ section })
  })

  app.get(`${prefix}/chapters/:chapterId/sections`, {
    schema: { tags: [tag], summary: 'List sections for a chapter', security: AUTH,
      params: { type: 'object', required: ['chapterId'], properties: { chapterId: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { chapterId } = req.params as { chapterId: string }
    reply.send({ sections: await listSections(chapterId, scopeOf(req)) })
  })

  // ── Hierarchy: concepts ──
  app.post(`${prefix}/sections/:sectionId/concepts`, {
    schema: { tags: [tag], summary: 'Create a concept', security: AUTH,
      params: { type: 'object', required: ['sectionId'], properties: { sectionId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 255 }, description: { type: 'string', maxLength: 2000 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = conceptSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { sectionId } = req.params as { sectionId: string }
    const concept = await createConcept({ tenantId: scopeOf(req), createdBy: req.user!.id, sectionId, ...parsed.data })
    reply.status(201).send({ concept })
  })

  app.get(`${prefix}/sections/:sectionId/concepts`, {
    schema: { tags: [tag], summary: 'List concepts for a section', security: AUTH,
      params: { type: 'object', required: ['sectionId'], properties: { sectionId: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { sectionId } = req.params as { sectionId: string }
    reply.send({ concepts: await listConcepts(sectionId, scopeOf(req)) })
  })

  // ── Hierarchy: edit / delete ──
  const idParam = (name: string) => ({ type: 'object', required: [name], properties: { [name]: { type: 'string', format: 'uuid' } } })

  const editDelete = (
    level: string, param: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: z.ZodTypeAny, updateFn: (id: string, t: string | null, d: any) => Promise<unknown>,
    deleteFn: (id: string, t: string | null) => Promise<unknown>, resKey: string,
  ) => {
    app.patch(`${prefix}/${level}/:${param}`, {
      schema: { tags: [tag], summary: `Update a ${resKey}`, security: AUTH, params: idParam(param) },
      preHandler,
    }, async (req, reply) => {
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
      const id = (req.params as Record<string, string>)[param]
      reply.send({ [resKey]: await updateFn(id, scopeOf(req), parsed.data) })
    })
    app.delete(`${prefix}/${level}/:${param}`, {
      schema: { tags: [tag], summary: `Delete a ${resKey}`, security: AUTH, params: idParam(param) },
      preHandler,
    }, async (req, reply) => {
      const id = (req.params as Record<string, string>)[param]
      reply.send(await deleteFn(id, scopeOf(req)))
    })
  }

  editDelete('subjects', 'subjectId', subjectUpdateSchema, updateSubject, deleteSubject, 'subject')
  editDelete('modules', 'moduleId', orderedUpdateSchema, updateModule, deleteModule, 'module')
  editDelete('chapters', 'chapterId', orderedUpdateSchema, updateChapter, deleteChapter, 'chapter')
  editDelete('sections', 'sectionId', orderedUpdateSchema, updateSection, deleteSection, 'section')
  editDelete('concepts', 'conceptId', conceptUpdateSchema, updateConcept, deleteConcept, 'concept')

  // ── Bank questions ──
  app.post(`${prefix}/question-bank`, {
    schema: { tags: [tag], summary: 'Add a question to the bank',
      description: 'Creates a `draft` bank question. `payload`/`answerKey` are validated per type. The hierarchy path is denormalized from the deepest id provided.',
      security: AUTH,
      body: { type: 'object', required: ['hierarchy', 'type', 'difficulty', 'body', 'payload', 'answerKey'], properties: {
        hierarchy: { type: 'object' }, type: { type: 'string', enum: QUESTION_TYPES as unknown as string[] },
        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] }, body: { type: 'string', maxLength: 5000 },
        payload: { type: 'object' }, answerKey: { type: 'object' },
        defaultMarks: { type: 'integer', minimum: 1, maximum: 1000 }, defaultNegativeMarks: { type: 'integer', minimum: 0, maximum: 1000 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = bankQuestionSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const question = await createBankQuestion({ tenantId: scopeOf(req), createdBy: req.user!.id, ...parsed.data })
    reply.status(201).send({ question })
  })

  app.get(`${prefix}/question-bank`, {
    schema: { tags: [tag], summary: 'List / filter bank questions', security: AUTH },
    preHandler,
  }, async (req, reply) => {
    const parsed = listFiltersSchema.safeParse(req.query ?? {})
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    reply.send({ questions: await listBankQuestions(scopeOf(req), parsed.data) })
  })

  app.get(`${prefix}/question-bank/counts`, {
    schema: { tags: [tag], summary: 'Count bank questions per subject', security: AUTH },
    preHandler,
  }, async (req, reply) => {
    reply.send({ counts: await countBankQuestionsBySubject(scopeOf(req)) })
  })

  app.get(`${prefix}/question-bank/availability`, {
    schema: {
      tags: [tag],
      summary: 'Availability preview for the test-engine wizard',
      description: 'Per-chapter counts across a subject plus per-type/difficulty counts for the selected scope. Mirrors generation filters (active questions, optional verifiedOnly).',
      security: AUTH,
    },
    preHandler,
  }, async (req, reply) => {
    const parsed = availabilitySchema.safeParse(req.query ?? {})
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { subjectId, chapterIds, verifiedOnly } = parsed.data
    const availability = await getBankAvailability({
      tenantId: scopeOf(req),
      subjectId,
      chapterIds: chapterIds ? chapterIds.split(',').filter(Boolean) : undefined,
      verifiedOnly,
    })
    reply.send({ availability })
  })

  app.get(`${prefix}/question-bank/:id`, {
    schema: { tags: [tag], summary: 'Get a bank question', security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send({ question: await getBankQuestion(id, scopeOf(req)) })
  })

  app.patch(`${prefix}/question-bank/:id`, {
    schema: { tags: [tag], summary: 'Update a bank question', security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = bankUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    reply.send({ question: await updateBankQuestion(id, scopeOf(req), parsed.data) })
  })

  app.post(`${prefix}/question-bank/:id/verify`, {
    schema: { tags: [tag], summary: 'Verify & activate a bank question', security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send({ question: await verifyBankQuestion(id, scopeOf(req), req.user!.id) })
  })

  app.post(`${prefix}/question-bank/:id/flag`, {
    schema: { tags: [tag], summary: 'Flag a bank question', security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } } },
    preHandler,
  }, async (req, reply) => {
    const parsed = flagSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    reply.send({ question: await flagBankQuestion(id, scopeOf(req), parsed.data.reason) })
  })

  app.post(`${prefix}/question-bank/:id/archive`, {
    schema: { tags: [tag], summary: 'Archive a bank question', security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send({ question: await archiveBankQuestion(id, scopeOf(req)) })
  })
}

export async function questionBankRoutes(app: FastifyInstance) {
  // Institute content: owner + teacher, scoped to the resolved tenant.
  registerCatalogAndBank(
    app,
    '/tenant',
    [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')],
    (req) => req.tenant!.id,
  )

  // Global Gyaanverse content: super_admin only, no tenant context.
  registerCatalogAndBank(
    app,
    '/admin',
    [authenticate, requireRole('super_admin')],
    () => null,
  )
}
