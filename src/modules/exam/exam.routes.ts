import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors, AppError } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import {
  createExam, updateExam, submitForReview, archiveExam, publishResults, duplicateExam,
  setExamChapters, linkExamToClass, unlinkExamFromClass, listExamClasses,
  addQuestion, updateQuestion, removeQuestion, reorderQuestions,
  listExamsForTenant, listAvailableExamsForStudent, listPublicExams, getExamStatsForTenant,
  getExamFull, getExamForStudent, getPublicExamPreview, getPublicExamForStudent,
} from './exam.service.js'
import { EXAM_STATUSES } from './exam.types.js'
import type { ExamStatus } from './exam.types.js'
import {
  generateExam, keepDraftQuestion, keepAllDraftQuestions, discardDraftQuestion,
  regenerateDraftQuestion, editDraftQuestion, finalizeGeneration,
} from './exam.generation.service.js'

// ── Zod schemas ────────────────────────────────────────────────────────────

// Base shape — kept refine-free so `updateExamSchema` can still call
// `.partial()` on it. `.refine()` returns ZodEffects, which doesn't expose
// `.partial`, so we apply the refine on the create variant only.
const examBaseShape = z.object({
  title: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(5000).optional(),
  durationMins: z.number().int().min(1).max(600),
  gradeLevel: z.string().min(1).max(50).optional(),
  subjectId: z.string().uuid().optional(),
  scopeType: z.enum(['single_chapter', 'multi_chapter', 'full_subject', 'full_syllabus', 'custom']).optional(),
  visibility: z.enum(['private', 'public_free', 'public_paid']),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  maxAttempts: z.number().int().min(1).max(99).optional(),
  scheduledAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
})

// Cross-field guard: price + visibility must be consistent. A `private`
// exam with a stray `price` would be a misconfiguration that could mislead
// a teacher into thinking the exam is purchasable. The service-layer
// createOrder also rejects, but blocking at the validator gives a clearer
// 422 at exam creation time instead of a confusing later error.
const createExamSchema = examBaseShape.refine(
  (data) => {
    const hasPrice = data.price !== undefined && parseFloat(data.price) > 0
    if (data.visibility === 'public_paid') return hasPrice
    return !hasPrice
  },
  {
    message: 'price > 0 is required for public_paid exams and forbidden for private/public_free',
    path: ['price'],
  },
)

const updateExamSchema = examBaseShape.partial().omit({ visibility: true }).extend({
  visibility: z.enum(['private', 'public_free', 'public_paid']).optional(),
  description: z.string().max(2000).nullable().optional(),
  instructions: z.string().max(5000).nullable().optional(),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  subjectId: z.string().uuid().nullable().optional(),
  gradeLevel: z.string().min(1).max(50).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
})

const questionSchema = z.object({
  type: z.enum(['mcq_single', 'mcq_multiple', 'integer', 'numerical', 'subjective', 'match', 'assertion_reason', 'fill_blanks']),
  body: z.string().min(1).max(5000),
  imageUrls: z.array(z.string().url()).max(5).optional(),
  payload: z.record(z.unknown()),
  answerKey: z.record(z.unknown()),
  marks: z.number().int().min(1).max(1000),
  negativeMarks: z.number().int().min(0).max(1000).optional(),
  explanation: z.string().max(2000).optional(),
})

const updateQuestionSchema = questionSchema.partial().omit({ type: true })

const reorderSchema = z.object({ orderedIds: z.array(z.string().uuid()).min(1) })

const chaptersLinkSchema = z.object({ chapterIds: z.array(z.string().uuid()) })

// ── Test-engine generation ─────────────────────────────────────────────────

const genParamsSchema = z.object({
  subjectId: z.string().uuid(),
  moduleIds: z.array(z.string().uuid()).optional(),
  chapterIds: z.array(z.string().uuid()).optional(),
  sectionIds: z.array(z.string().uuid()).optional(),
  conceptIds: z.array(z.string().uuid()).optional(),
  totalQuestions: z.number().int().min(1).max(200),
  typeDistribution: z.record(z.number().int().min(0)),
  difficultyDistribution: z.record(z.number().int().min(0)),
  allowRepeatFromBank: z.boolean().optional(),
  verifiedOnly: z.boolean().optional(),
  language: z.string().min(2).max(10).optional(),
  sourceType: z.enum(['original', 'textbook', 'pyq']).optional(),
  cognitiveLevels: z.array(z.string().min(1).max(20)).max(6).optional(),
})

const generateSchema = z.object({
  title: z.string().min(2).max(255),
  visibility: z.enum(['private', 'public_free', 'public_paid']).optional(),
  durationMins: z.number().int().min(1).max(600).optional(),
  params: genParamsSchema,
})

const draftEditSchema = z.object({
  body: z.string().min(1).max(5000).optional(),
  imageUrls: z.array(z.string().url()).max(5).nullable().optional(),
  payload: z.record(z.unknown()).optional(),
  answerKey: z.record(z.unknown()).optional(),
  marks: z.number().int().min(1).max(1000).optional(),
  negativeMarks: z.number().int().min(0).max(1000).optional(),
  explanation: z.string().max(2000).nullable().optional(),
})

const AUTH = [{ bearerAuth: [] }]

export async function examRoutes(app: FastifyInstance) {
  const tenantAuth = [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher')]
  const tenantAny = [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')]

  // The subject/module/chapter/section/concept catalog moved to the
  // question-bank module (`questionBankRoutes`).

  // ── Exam CRUD ─────────────────────────────────────────────────────────────

  app.post('/tenant/exams', {
    schema: {
      tags: ['Exams'],
      summary: 'Create an exam',
      description: 'Creates a new exam draft. `visibility: "public_paid"` requires `price > 0`. Enforces the plan\'s monthly mock limit.',
      security: AUTH,
      body: {
        type: 'object',
        required: ['title', 'durationMins', 'visibility'],
        properties: {
          title: { type: 'string', minLength: 2, maxLength: 255 },
          description: { type: 'string', maxLength: 2000 },
          instructions: { type: 'string', maxLength: 5000 },
          durationMins: { type: 'integer', minimum: 1, maximum: 600 },
          gradeLevel: { type: 'string', maxLength: 50 },
          subjectId: { type: 'string', format: 'uuid' },
          scopeType: { type: 'string', enum: ['single_chapter', 'multi_chapter', 'full_subject', 'full_syllabus', 'custom'] },
          visibility: { type: 'string', enum: ['private', 'public_free', 'public_paid'] },
          price: { type: 'string', description: 'Required when visibility is public_paid (e.g. `"99.00"`)' },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 99 },
          scheduledAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = createExamSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const tenant = req.tenant!
    const user = req.user!
    const exam = await createExam({
      tenantId: tenant.id,
      createdBy: user.id,
      ...parsed.data,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined,
    })
    reply.status(201).send({ exam })
  })

  app.get('/tenant/exams', {
    schema: {
      tags: ['Exams'],
      summary: 'List exams',
      description: 'Returns exams for the resolved tenant. Optional `?status=` (comma-separated lifecycle statuses, e.g. `under_review,live`) powers the teacher/admin dashboard buckets. Students only see exams available to them.',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Comma-separated lifecycle statuses to filter by' } },
      },
    },
    preHandler: tenantAny,
  }, async (req, reply) => {
    const tenant = req.tenant!
    const user = req.user!
    if (user.role === 'student') {
      const items = await listAvailableExamsForStudent(user.id, tenant.id)
      return reply.send({ exams: items })
    }
    const { status } = req.query as { status?: string }
    const statuses = status
      ? (status.split(',').map((s) => s.trim()).filter((s) => (EXAM_STATUSES as readonly string[]).includes(s)) as ExamStatus[])
      : undefined
    const items = await listExamsForTenant(tenant.id, user.id, user.role, statuses)
    reply.send({ exams: items })
  })

  app.get('/tenant/exams/stats', {
    schema: {
      tags: ['Exams'],
      summary: 'Exam KPIs',
      description: 'Aggregate statistics for the exams hub: exam counts by status/visibility, total attempts, and average score.',
      security: AUTH,
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const tenant = req.tenant!
    const user = req.user!
    const stats = await getExamStatsForTenant(tenant.id, user.id, user.role)
    reply.send({ stats })
  })

  app.get('/tenant/exams/:id', {
    schema: {
      tags: ['Exams'],
      summary: 'Get an exam (full detail)',
      description: 'Returns the full exam including all questions. Students get a filtered view (no answer keys).',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAny,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    if (user.role === 'student') {
      const { lang } = req.query as { lang?: string }
      const exam = await getExamForStudent(id, user.id, lang)
      return reply.send({ exam })
    }
    const exam = await getExamFull(id, tenant.id)
    reply.send({ exam })
  })

  app.patch('/tenant/exams/:id', {
    schema: {
      tags: ['Exams'],
      summary: 'Update an exam',
      description: 'Updates exam metadata. Only works on draft exams. Teachers may only update their own exams.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = updateExamSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const data = {
      ...parsed.data,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : parsed.data.scheduledAt,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : parsed.data.endsAt,
    }
    const exam = await updateExam(id, tenant.id, user.id, user.role, data as any)
    reply.send({ exam })
  })

  // NOTE(phase-3): path stays `/publish` for now but the handler is repurposed
  // to teacher submit-for-review. Phase 3 renames the path to `/submit`.
  app.post('/tenant/exams/:id/publish', {
    schema: {
      tags: ['Exams'],
      summary: 'Submit an exam for review',
      description: 'Teacher submits a `draft` (or `changes_requested`) exam for admin review, moving it to `under_review`. Requires ≥1 question, ≥1 class for private exams, and the public-mock feature for public exams. Replaces the old direct self-publish.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const exam = await submitForReview(id, tenant.id, user.id, user.role)
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/archive', {
    schema: {
      tags: ['Exams'],
      summary: 'Archive an exam',
      description: 'Moves the exam to `archived` status, hiding it from students.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const exam = await archiveExam(id, tenant.id, user.id, user.role)
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/publish-results', {
    schema: {
      tags: ['Exams'],
      summary: 'Publish exam results',
      description: 'Teacher publishes results (`under_evaluation → results_published`), revealing scores/reports to students. Until this is called, private-exam results stay hidden.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const exam = await publishResults(id, tenant.id, user.id, user.role)
    reply.send({ exam })
  })

  app.post('/tenant/exams/:id/duplicate', {
    schema: {
      tags: ['Exams'],
      summary: 'Duplicate an exam',
      description: 'Clones the exam (metadata, questions, chapter coverage, class links) into a fresh `draft` owned by the requester. Allowed from any state.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const exam = await duplicateExam(id, tenant.id, user.id, user.role)
    reply.status(201).send({ exam })
  })

  // ── Questions (reorder must be registered before /:qid) ───────────────────

  app.put('/tenant/exams/:id/questions/reorder', {
    schema: {
      tags: ['Questions'],
      summary: 'Reorder questions',
      description: 'Sets the display order of questions by providing the complete ordered array of question IDs.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['orderedIds'],
        properties: {
          orderedIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = reorderSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const qs = await reorderQuestions(id, tenant.id, user.id, user.role, parsed.data.orderedIds)
    reply.send({ questions: qs })
  })

  app.post('/tenant/exams/:id/questions', {
    schema: {
      tags: ['Questions'],
      summary: 'Add a question to an exam',
      description: 'Appends a new question. `payload` and `answerKey` are type-specific JSON objects validated at the service layer.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['type', 'body', 'payload', 'answerKey', 'marks'],
        properties: {
          type: { type: 'string', enum: ['mcq_single', 'mcq_multiple', 'integer', 'numerical', 'subjective', 'match', 'assertion_reason', 'fill_blanks'] },
          body: { type: 'string', maxLength: 5000, description: 'Question text (supports markdown/HTML)' },
          imageUrls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 5 },
          payload: { type: 'object', description: 'Type-specific question data (e.g. MCQ options)' },
          answerKey: { type: 'object', description: 'Type-specific answer data' },
          marks: { type: 'integer', minimum: 1, maximum: 1000 },
          negativeMarks: { type: 'integer', minimum: 0, maximum: 1000 },
          explanation: { type: 'string', maxLength: 2000 },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = questionSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const question = await addQuestion(id, tenant.id, user.id, user.role, parsed.data)
    reply.status(201).send({ question })
  })

  app.patch('/tenant/exams/:id/questions/:qid', {
    schema: {
      tags: ['Questions'],
      summary: 'Update a question',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'qid'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          qid: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = updateQuestionSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id, qid } = req.params as { id: string; qid: string }
    const tenant = req.tenant!
    const user = req.user!
    const question = await updateQuestion(qid, id, tenant.id, user.id, user.role, parsed.data)
    reply.send({ question })
  })

  app.delete('/tenant/exams/:id/questions/:qid', {
    schema: {
      tags: ['Questions'],
      summary: 'Remove a question from an exam',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'qid'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          qid: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string }
    const tenant = req.tenant!
    const user = req.user!
    const result = await removeQuestion(qid, id, tenant.id, user.id, user.role)
    reply.send(result)
  })

  // ── Test engine: generation & draft review ────────────────────────────────

  app.post('/tenant/exams/generate', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Generate a draft exam from the question bank',
      description: 'Picks questions from the bank (pure SQL, no LLM) matching the type & difficulty distributions, copies them into a new draft exam as `pending`, and computes the estimated duration. Returns any buckets the bank could not fully fill.',
      security: AUTH,
      body: {
        type: 'object',
        required: ['title', 'params'],
        properties: {
          title: { type: 'string', minLength: 2, maxLength: 255 },
          visibility: { type: 'string', enum: ['private', 'public_free', 'public_paid'] },
          durationMins: { type: 'integer', minimum: 1, maximum: 600 },
          params: {
            type: 'object',
            required: ['subjectId', 'totalQuestions', 'typeDistribution', 'difficultyDistribution'],
            properties: {
              subjectId: { type: 'string', format: 'uuid' },
              moduleIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              chapterIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              sectionIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              conceptIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              totalQuestions: { type: 'integer', minimum: 1, maximum: 200 },
              typeDistribution: { type: 'object', additionalProperties: { type: 'integer' } },
              difficultyDistribution: { type: 'object', additionalProperties: { type: 'integer' } },
              allowRepeatFromBank: { type: 'boolean' },
              verifiedOnly: { type: 'boolean' },
              language: { type: 'string', maxLength: 10 },
            },
          },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = generateSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const tenant = req.tenant!
    const user = req.user!
    const result = await generateExam({
      tenantId: tenant.id,
      createdBy: user.id,
      requesterRole: user.role,
      title: parsed.data.title,
      visibility: parsed.data.visibility,
      durationMins: parsed.data.durationMins,
      params: parsed.data.params,
    })
    reply.status(201).send(result)
  })

  app.post('/tenant/exams/:id/questions/:qid/keep', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Keep a draft question',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'qid'],
        properties: { id: { type: 'string', format: 'uuid' }, qid: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string }
    const user = req.user!
    const question = await keepDraftQuestion(id, qid, req.tenant!.id, user.id, user.role)
    reply.send({ question })
  })

  app.post('/tenant/exams/:id/questions/keep-all', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Keep all pending draft questions',
      description: 'Flips every still-`pending` draft question to `kept` in one call. Already-`discarded` questions are left untouched. Returns the number kept.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user!
    const result = await keepAllDraftQuestions(id, req.tenant!.id, user.id, user.role)
    reply.send(result)
  })

  app.post('/tenant/exams/:id/questions/:qid/discard', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Discard a draft question (removed on finalize)',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'qid'],
        properties: { id: { type: 'string', format: 'uuid' }, qid: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string }
    const user = req.user!
    const question = await discardDraftQuestion(id, qid, req.tenant!.id, user.id, user.role)
    reply.send({ question })
  })

  app.post('/tenant/exams/:id/questions/:qid/regenerate', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Replace a draft question with a fresh bank pick',
      description: 'Swaps in another bank question of the same type & difficulty not already used in this exam. Keeps the slot position.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'qid'],
        properties: { id: { type: 'string', format: 'uuid' }, qid: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string }
    const user = req.user!
    const question = await regenerateDraftQuestion(id, qid, req.tenant!.id, user.id, user.role)
    reply.send({ question })
  })

  app.patch('/tenant/exams/:id/questions/:qid/edit', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Edit a draft question in place (implicitly keeps it)',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'qid'],
        properties: { id: { type: 'string', format: 'uuid' }, qid: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = draftEditSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id, qid } = req.params as { id: string; qid: string }
    const user = req.user!
    const question = await editDraftQuestion(id, qid, req.tenant!.id, user.id, user.role, parsed.data)
    reply.send({ question })
  })

  app.post('/tenant/exams/:id/finalize', {
    schema: {
      tags: ['Test Engine'],
      summary: 'Finalize a generated draft',
      description: 'Drops every question still `pending` or `discarded`, renumbers the survivors, and recomputes marks. The exam stays a draft — publish separately.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user!
    const exam = await finalizeGeneration(id, req.tenant!.id, user.id, user.role)
    reply.send({ exam })
  })

  // ── Exam class linking ────────────────────────────────────────────────────

  app.get('/tenant/exams/:id/classes', {
    schema: {
      tags: ['Exams'],
      summary: 'List classes linked to an exam',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const rows = await listExamClasses(id, tenant.id)
    reply.send({ classes: rows })
  })

  app.post('/tenant/exams/:id/classes', {
    schema: {
      tags: ['Exams'],
      summary: 'Link an exam to a class',
      description: 'Makes the exam available to all students in the specified class.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['classId'],
        properties: { classId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = z.object({ classId: z.string().uuid() }).safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const row = await linkExamToClass(id, tenant.id, user.id, user.role, parsed.data.classId)
    reply.status(201).send({ examClass: row })
  })

  app.delete('/tenant/exams/:id/classes/:classId', {
    schema: {
      tags: ['Exams'],
      summary: 'Unlink an exam from a class',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id', 'classId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          classId: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const { id, classId } = req.params as { id: string; classId: string }
    const tenant = req.tenant!
    const user = req.user!
    const result = await unlinkExamFromClass(id, tenant.id, user.id, user.role, classId)
    reply.send(result)
  })

  // ── Exam chapter coverage ─────────────────────────────────────────────────

  app.put('/tenant/exams/:id/chapters', {
    schema: {
      tags: ['Exams'],
      summary: 'Set chapter coverage for an exam',
      description: 'Replaces the full set of chapters covered by this exam.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['chapterIds'],
        properties: {
          chapterIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        },
      },
    },
    preHandler: tenantAuth,
  }, async (req, reply) => {
    const parsed = chaptersLinkSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
    const { id } = req.params as { id: string }
    const tenant = req.tenant!
    const user = req.user!
    const rows = await setExamChapters(id, tenant.id, user.id, user.role, parsed.data.chapterIds)
    reply.send({ chapters: rows })
  })

  // ── Public routes ─────────────────────────────────────────────────────────

  app.get('/exams/public', {
    schema: {
      tags: ['Exams'],
      summary: 'List public exams (marketplace)',
      description: 'Returns all `public_free` and `public_paid` exams. No auth required.',
      querystring: {
        type: 'object',
        properties: {
          gradeLevel: { type: 'string' },
          subjectId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    const { gradeLevel, subjectId } = req.query as { gradeLevel?: string; subjectId?: string }
    const items = await listPublicExams({ gradeLevel, subjectId })
    reply.send({ exams: items })
  })

  app.get('/exams/:id/preview', {
    schema: {
      tags: ['Exams'],
      summary: 'Get public exam preview',
      description: 'Returns exam metadata and a sample question preview without answer keys. No auth required.',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const exam = await getPublicExamPreview(id)
    reply.send({ exam })
  })

  app.get('/exams/:id', {
    schema: {
      tags: ['Exams'],
      summary: 'Get a public exam (student view)',
      description: 'Returns a published public exam for the authenticated student. Verifies the student has purchased it if `public_paid`.',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: [authenticate],
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user!
    const { lang } = req.query as { lang?: string }
    const exam = await getPublicExamForStudent(id, user.id, lang)
    reply.send({ exam })
  })

}
