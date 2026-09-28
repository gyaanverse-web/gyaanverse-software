import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Errors } from '../../shared/errors.js'
import { authenticate, requireTenantRole } from '../../middleware/auth.middleware.js'
import { tenantMiddleware } from '../../middleware/tenant.middleware.js'
import { requireFeesEnabled } from './fee.guard.js'
import {
  getFeeSettings,
  updateFeeSettings,
  createFeeHead,
  listFeeHeads,
  updateFeeHead,
  createFeeStructure,
  listFeeStructures,
  getFeeStructureDetail,
  addStructureItem,
  addStructureInstallment,
  publishFeeStructure,
  reviseFeeStructure,
  assignStructureToClass,
  listAssignments,
  addConcession,
  reverseConcession,
  getStudentLedger,
  getFeesSummary,
  listInvoicesForStudent,
  listGuardians,
  addGuardian,
  removeGuardian,
  pageSize,
} from './fee.service.js'
import {
  recordPayment,
  reversePayment,
  setPaymentClearance,
  applyCredit,
  createAdjustment,
  reverseAdjustment,
} from './fee.ledger.js'
import {
  getReceipt,
  listStudentReceipts,
  renderReceipt,
  renderReceiptHtml,
  renderTaxInvoice,
} from './fee.receipt.js'
import { getDaybook, getDefaulters, getHeadWiseCollection, listPayments } from './fee.reports.js'

const AUTH = [{ bearerAuth: [] }]
const OWNER = [requireFeesEnabled, authenticate, tenantMiddleware, requireTenantRole('coaching_owner')]
const STUDENT = [requireFeesEnabled, authenticate, tenantMiddleware]

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const
const studentParams = { type: 'object', required: ['studentId'], properties: { studentId: { type: 'string', format: 'uuid' } } } as const
const DATE = /^\d{4}-\d{2}-\d{2}$/

const headSchema = z.object({
  name: z.string().min(2).max(120),
  code: z.string().min(1).max(32),
  category: z.enum(['tuition', 'admission', 'transport', 'exam', 'material', 'penalty', 'other']),
  isRefundable: z.boolean().optional(),
  taxRatePct: z.number().min(0).max(100).nullable().optional(),
  sacCode: z.string().max(10).nullable().optional(),
})

const headPatchSchema = headSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
})

const structureSchema = z.object({
  name: z.string().min(2).max(160),
  academicYear: z.string().regex(/^\d{4}-\d{2}$/, 'academicYear must look like "2026-27"'),
})

const itemSchema = z.object({
  headId: z.string().uuid(),
  amount: z.number().positive(),
  order: z.number().int().optional(),
})

const installmentSchema = z.object({
  seq: z.number().int().positive(),
  label: z.string().min(1).max(80),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dueDate must be YYYY-MM-DD'),
  sharePct: z.number().positive().max(100),
})

const assignSchema = z.object({ classId: z.string().uuid() })

const concessionSchema = z.object({
  type: z.enum(['scholarship', 'sibling', 'staff_ward', 'merit', 'need_based', 'other']),
  mode: z.enum(['percent', 'amount']),
  value: z.number().positive(),
  headId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
})

const reverseSchema = z.object({ reason: z.string().min(1).max(500) })

const settingsPatchSchema = z.object({
  gstMode: z.enum(['none', 'registered']).optional(),
  gstin: z.string().length(15).nullable().optional(),
  placeOfSupplyCode: z.string().length(2).nullable().optional(),
  receiptPrefix: z.string().min(1).max(12).regex(/^[A-Za-z0-9-]+$/, 'receiptPrefix may only contain letters, digits and hyphens').optional(),
  financialYearStartMonth: z.number().int().min(1).max(12).optional(),
  bounceCharge: z.number().min(0).optional(),
  lateFeePolicy: z.object({
    enabled: z.boolean(),
    graceDays: z.number().int().min(0).max(365),
    mode: z.enum(['percent', 'amount']),
    value: z.number().min(0),
    capAmount: z.number().positive().nullable(),
  }).refine((p) => p.mode !== 'percent' || p.value <= 100, 'A percentage late fee cannot exceed 100').optional(),
  reminderPolicy: z.object({
    enabled: z.boolean(),
    offsetsDays: z.array(z.number().int().min(-60).max(120)).min(1).max(10),
    channels: z.array(z.enum(['email', 'sms'])).max(2),
  }).optional(),
})

const guardianSchema = z.object({
  name: z.string().min(1).max(120),
  relation: z.string().min(1).max(30),
  phone: z.string().regex(/^\+?\d{10,15}$/, 'phone must be 10-15 digits, optionally with a leading +').nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  isPrimary: z.boolean().optional(),
})

const paymentSchema = z.object({
  studentId: z.string().uuid(),
  amount: z.number().positive(),
  mode: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'dd', 'card', 'other']),
  reference: z.string().max(120).nullable().optional(),
  instrumentDate: z.string().regex(DATE, 'instrumentDate must be YYYY-MM-DD').nullable().optional(),
  bankName: z.string().max(120).nullable().optional(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount: z.number().positive() })).max(50).optional(),
})

const clearanceSchema = z.object({
  outcome: z.enum(['cleared', 'bounced']),
  reason: z.string().min(1).max(500).optional(),
})

const adjustmentSchema = z.object({
  studentId: z.string().uuid(),
  type: z.enum(['late_fee', 'opening_balance', 'waiver', 'write_off', 'credit_note']),
  amount: z.number().positive(),
  invoiceId: z.string().uuid().optional(),
  dueDate: z.string().regex(DATE, 'dueDate must be YYYY-MM-DD').optional(),
  reason: z.string().min(1).max(500),
})

function parse<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)
  return parsed.data
}

export async function feeRoutes(app: FastifyInstance) {
  // ── Owner: settings ──────────────────────────────────────────────────────

  app.get('/tenant/fees/settings', {
    schema: { tags: ['Fees'], summary: 'Get fee settings', security: AUTH },
    preHandler: OWNER,
  }, async (req, reply) => {
    reply.send({ settings: await getFeeSettings(req.tenant!.id) })
  })

  app.put('/tenant/fees/settings', {
    schema: { tags: ['Fees'], summary: 'Update fee settings', security: AUTH },
    preHandler: OWNER,
  }, async (req, reply) => {
    const data = parse(settingsPatchSchema, req.body)
    reply.send({ settings: await updateFeeSettings(req.tenant!.id, data) })
  })

  // ── Owner: catalogue — heads ─────────────────────────────────────────────

  app.post('/tenant/fees/heads', {
    schema: {
      tags: ['Fees'],
      summary: 'Create a fee head',
      security: AUTH,
      body: {
        type: 'object',
        required: ['name', 'code', 'category'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120 },
          code: { type: 'string', minLength: 1, maxLength: 32, description: 'Unique per tenant, stable key for reports' },
          category: { type: 'string', enum: ['tuition', 'admission', 'transport', 'exam', 'material', 'penalty', 'other'] },
          isRefundable: { type: 'boolean' },
          taxRatePct: { type: 'number', minimum: 0, maximum: 100, nullable: true },
          sacCode: { type: 'string', maxLength: 10, nullable: true },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const data = parse(headSchema, req.body)
    const head = await createFeeHead(req.tenant!.id, data)
    reply.status(201).send({ head })
  })

  app.get('/tenant/fees/heads', {
    schema: {
      tags: ['Fees'],
      summary: 'List fee heads',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'archived'] },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { status, cursor, limit } = req.query as { status?: string; cursor?: string; limit?: number }
    reply.send(await listFeeHeads(req.tenant!.id, { status, cursor, limit }))
  })

  app.patch('/tenant/fees/heads/:id', {
    schema: {
      tags: ['Fees'],
      summary: 'Update a fee head',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(headPatchSchema, req.body)
    reply.send({ head: await updateFeeHead(req.tenant!.id, id, data) })
  })

  // ── Owner: catalogue — structures ────────────────────────────────────────

  app.post('/tenant/fees/structures', {
    schema: {
      tags: ['Fees'],
      summary: 'Create a draft fee structure',
      security: AUTH,
      body: {
        type: 'object',
        required: ['name', 'academicYear'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 160 },
          academicYear: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'e.g. "2026-27"' },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const data = parse(structureSchema, req.body)
    const structure = await createFeeStructure(req.tenant!.id, req.user!.id, data)
    reply.status(201).send({ structure })
  })

  app.get('/tenant/fees/structures', {
    schema: {
      tags: ['Fees'],
      summary: 'List fee structures',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          academicYear: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'published', 'archived'] },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { academicYear, status, cursor, limit } = req.query as { academicYear?: string; status?: string; cursor?: string; limit?: number }
    reply.send(await listFeeStructures(req.tenant!.id, { academicYear, status, cursor, limit }))
  })

  app.get('/tenant/fees/structures/:id', {
    schema: {
      tags: ['Fees'],
      summary: 'Get a fee structure with its items and installments',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send(await getFeeStructureDetail(req.tenant!.id, id))
  })

  app.post('/tenant/fees/structures/:id/items', {
    schema: {
      tags: ['Fees'],
      summary: 'Add a fee item to a draft structure',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['headId', 'amount'],
        properties: {
          headId: { type: 'string', format: 'uuid' },
          amount: { type: 'number', exclusiveMinimum: 0, description: 'In rupees — converted to paise internally' },
          order: { type: 'integer' },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(itemSchema, req.body)
    const item = await addStructureItem(req.tenant!.id, id, data)
    reply.status(201).send({ item })
  })

  app.post('/tenant/fees/structures/:id/installments', {
    schema: {
      tags: ['Fees'],
      summary: 'Add an installment to a draft structure',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['seq', 'label', 'dueDate', 'sharePct'],
        properties: {
          seq: { type: 'integer', minimum: 1 },
          label: { type: 'string', minLength: 1, maxLength: 80 },
          dueDate: { type: 'string', format: 'date' },
          sharePct: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(installmentSchema, req.body)
    const installment = await addStructureInstallment(req.tenant!.id, id, data)
    reply.status(201).send({ installment })
  })

  app.post('/tenant/fees/structures/:id/publish', {
    schema: {
      tags: ['Fees'],
      summary: 'Publish a draft structure',
      description: 'Validates items sum > 0, installment shares sum to exactly 100%, due dates strictly ascending, and no due date before the academic year starts. A published structure is immutable.',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send({ structure: await publishFeeStructure(req.tenant!.id, id) })
  })

  app.post('/tenant/fees/structures/:id/revise', {
    schema: {
      tags: ['Fees'],
      summary: 'Create the next version of a published structure',
      description: 'Copies items and installments into a new draft (version n+1) and marks this structure superseded. Existing assignments on this version are untouched.',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const revision = await reviseFeeStructure(req.tenant!.id, id, req.user!.id)
    reply.status(201).send({ structure: revision })
  })

  // ── Owner: obligation ────────────────────────────────────────────────────

  app.post('/tenant/fees/structures/:id/assign', {
    schema: {
      tags: ['Fees'],
      summary: 'Assign a structure to a class (fan-out)',
      description: 'Enqueues assignment + invoice generation for every approved student in the class. Returns immediately with a job id; poll GET /tenant/fees/assignments to watch the count grow. Idempotent — re-running only assigns newly-joined students.',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['classId'],
        properties: { classId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(assignSchema, req.body)
    const result = await assignStructureToClass(req.tenant!.id, id, data.classId)
    reply.status(202).send(result)
  })

  app.get('/tenant/fees/assignments', {
    schema: {
      tags: ['Fees'],
      summary: 'List student fee assignments',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          classId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['active', 'completed', 'withdrawn'] },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { classId, status, cursor, limit } = req.query as { classId?: string; status?: string; cursor?: string; limit?: number }
    reply.send(await listAssignments(req.tenant!.id, { classId, status, cursor, limit }))
  })

  app.post('/tenant/fees/assignments/:id/concessions', {
    schema: {
      tags: ['Fees'],
      summary: 'Grant a concession against an assignment',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['type', 'mode', 'value'],
        properties: {
          type: { type: 'string', enum: ['scholarship', 'sibling', 'staff_ward', 'merit', 'need_based', 'other'] },
          mode: { type: 'string', enum: ['percent', 'amount'] },
          value: { type: 'number', exclusiveMinimum: 0, description: 'A percentage (0-100) or a rupee amount, per `mode`' },
          headId: { type: 'string', format: 'uuid' },
          reason: { type: 'string', maxLength: 500 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(concessionSchema, req.body)
    const concession = await addConcession(req.tenant!.id, id, req.user!.id, data)
    reply.status(201).send({ concession })
  })

  app.delete('/tenant/fees/concessions/:id', {
    schema: {
      tags: ['Fees'],
      summary: 'Reverse a concession',
      description: 'Writes a reversing row rather than deleting — concessions are append-only.',
      security: AUTH,
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(reverseSchema, req.body)
    const reversal = await reverseConcession(req.tenant!.id, id, req.user!.id, data.reason)
    reply.status(201).send({ reversal })
  })

  app.get('/tenant/fees/students/:studentId/ledger', {
    schema: {
      tags: ['Fees'],
      summary: "Get a student's full fee ledger",
      security: AUTH,
      params: { type: 'object', required: ['studentId'], properties: { studentId: { type: 'string', format: 'uuid' } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { studentId } = req.params as { studentId: string }
    reply.send(await getStudentLedger(req.tenant!.id, studentId))
  })

  app.post('/tenant/fees/students/:studentId/apply-credit', {
    schema: {
      tags: ['Fees'],
      summary: "Spend a student's credit on their open invoices",
      description: 'Allocates the unallocated remainder of earlier payments (advances) to open invoices, oldest due first.',
      security: AUTH,
      params: studentParams,
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { studentId } = req.params as { studentId: string }
    reply.send(await applyCredit(req.tenant!.id, req.user!.id, studentId))
  })

  // ── Owner: guardians ─────────────────────────────────────────────────────

  app.post('/tenant/fees/students/:studentId/guardians', {
    schema: {
      tags: ['Fees'],
      summary: 'Add a guardian contact for a student',
      description: 'The first guardian becomes primary. Setting isPrimary on a later one demotes the previous primary. Reminders go to the primary guardian.',
      security: AUTH,
      params: studentParams,
      body: {
        type: 'object',
        required: ['name', 'relation'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          relation: { type: 'string', minLength: 1, maxLength: 30, description: 'e.g. "Father", "Mother", "Guardian"' },
          phone: { type: 'string', nullable: true },
          email: { type: 'string', format: 'email', nullable: true },
          isPrimary: { type: 'boolean' },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { studentId } = req.params as { studentId: string }
    const data = parse(guardianSchema, req.body)
    reply.status(201).send({ guardian: await addGuardian(req.tenant!.id, studentId, data) })
  })

  app.get('/tenant/fees/students/:studentId/guardians', {
    schema: { tags: ['Fees'], summary: "List a student's guardians", security: AUTH, params: studentParams },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { studentId } = req.params as { studentId: string }
    reply.send({ guardians: await listGuardians(req.tenant!.id, studentId) })
  })

  app.delete('/tenant/fees/guardians/:id', {
    schema: { tags: ['Fees'], summary: 'Remove a guardian contact', security: AUTH, params: idParams },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send({ guardian: await removeGuardian(req.tenant!.id, id) })
  })

  // ── Owner: ledger ────────────────────────────────────────────────────────

  app.post('/tenant/fees/payments', {
    schema: {
      tags: ['Fees'],
      summary: 'Record a payment received',
      description:
        'Requires an Idempotency-Key header (8-64 chars). A replay of the same key returns the original payment with 200, never a second receipt. ' +
        'Without `allocations`, the amount is applied oldest-due-first and any remainder is held as credit. Amounts are in rupees. ' +
        'Cheque/DD payments are created pending clearance and need `reference` (the instrument number).',
      security: AUTH,
      headers: {
        type: 'object',
        required: ['idempotency-key'],
        properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 64 } },
      },
      body: {
        type: 'object',
        required: ['studentId', 'amount', 'mode'],
        properties: {
          studentId: { type: 'string', format: 'uuid' },
          amount: { type: 'number', exclusiveMinimum: 0, description: 'Rupees' },
          mode: { type: 'string', enum: ['cash', 'upi', 'bank_transfer', 'cheque', 'dd', 'card', 'other'] },
          reference: { type: 'string', maxLength: 120, nullable: true, description: 'UPI ref / cheque no. / UTR' },
          instrumentDate: { type: 'string', format: 'date', nullable: true },
          bankName: { type: 'string', maxLength: 120, nullable: true },
          receivedAt: { type: 'string', format: 'date-time', description: 'When the money changed hands; defaults to now' },
          allocations: {
            type: 'array',
            items: {
              type: 'object',
              required: ['invoiceId', 'amount'],
              properties: { invoiceId: { type: 'string', format: 'uuid' }, amount: { type: 'number', exclusiveMinimum: 0 } },
            },
          },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 8 || key.length > 64) {
      throw Errors.VALIDATION('An Idempotency-Key header of 8-64 characters is required')
    }
    const data = parse(paymentSchema, req.body)
    const result = await recordPayment(req.tenant!.id, req.user!.id, { ...data, idempotencyKey: key })
    reply.status(result.replayed ? 200 : 201).send(result)
  })

  app.get('/tenant/fees/payments', {
    schema: {
      tags: ['Fees'],
      summary: 'List payments',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date', description: 'receivedAt on or after (IST calendar day)' },
          to: { type: 'string', format: 'date', description: 'receivedAt on or before (IST calendar day)' },
          mode: { type: 'string', enum: ['cash', 'upi', 'bank_transfer', 'cheque', 'dd', 'card', 'other'] },
          studentId: { type: 'string', format: 'uuid' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    reply.send(await listPayments(req.tenant!.id, req.query as any))
  })

  app.post('/tenant/fees/payments/:id/reverse', {
    schema: {
      tags: ['Fees'],
      summary: 'Reverse a mis-keyed payment',
      description: 'Marks the payment reversed and takes its allocations back off the invoices. The receipt number is never reused — the receipt reprints stamped REVERSED.',
      security: AUTH,
      params: idParams,
      body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(reverseSchema, req.body)
    reply.send({ payment: await reversePayment(req.tenant!.id, req.user!.id, id, data.reason) })
  })

  app.post('/tenant/fees/payments/:id/clearance', {
    schema: {
      tags: ['Fees'],
      summary: 'Mark a pending cheque/DD cleared or bounced',
      description: 'A bounce takes the payment back off its invoices (a paid invoice returns to partially paid), keeps the allocations as history, and levies the configured bounce charge once.',
      security: AUTH,
      params: idParams,
      body: {
        type: 'object',
        required: ['outcome'],
        properties: {
          outcome: { type: 'string', enum: ['cleared', 'bounced'] },
          reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Required for a bounce' },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(clearanceSchema, req.body)
    reply.send(await setPaymentClearance(req.tenant!.id, req.user!.id, id, data))
  })

  app.get('/tenant/fees/payments/:id/receipt', {
    schema: {
      tags: ['Fees'],
      summary: 'Get a receipt, rendered from its snapshot',
      description: 'JSON by default; `?format=html` returns a printable page.',
      security: AUTH,
      params: idParams,
      querystring: { type: 'object', properties: { format: { type: 'string', enum: ['json', 'html'] } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { format } = req.query as { format?: string }
    const payment = await getReceipt(req.tenant!.id, id)
    if (format === 'html') return reply.type('text/html; charset=utf-8').send(renderReceiptHtml(payment))
    reply.send(renderReceipt(payment))
  })

  app.post('/tenant/fees/adjustments', {
    schema: {
      tags: ['Fees'],
      summary: 'Record a non-cash ledger entry',
      description:
        'waiver / write_off / credit_note reduce one invoice (invoiceId required, at most its outstanding). ' +
        'late_fee (invoiceId = the overdue invoice) and opening_balance raise a new charge invoice. Amounts are positive rupees; the type decides the sign.',
      security: AUTH,
      body: {
        type: 'object',
        required: ['studentId', 'type', 'amount', 'reason'],
        properties: {
          studentId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['late_fee', 'opening_balance', 'waiver', 'write_off', 'credit_note'] },
          amount: { type: 'number', exclusiveMinimum: 0 },
          invoiceId: { type: 'string', format: 'uuid' },
          dueDate: { type: 'string', format: 'date', description: 'Charge types only; defaults to today' },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const data = parse(adjustmentSchema, req.body)
    reply.status(201).send({ adjustment: await createAdjustment(req.tenant!.id, req.user!.id, data) })
  })

  app.post('/tenant/fees/adjustments/:id/reverse', {
    schema: {
      tags: ['Fees'],
      summary: 'Reverse an adjustment',
      description: 'Writes an opposing row. Reversing a charge cancels its invoice, and is refused once anything has been paid against it.',
      security: AUTH,
      params: idParams,
      body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = parse(reverseSchema, req.body)
    reply.status(201).send({ reversal: await reverseAdjustment(req.tenant!.id, req.user!.id, id, data.reason) })
  })

  app.get('/tenant/fees/invoices/:id/tax-invoice', {
    schema: {
      tags: ['Fees'],
      summary: 'Get the GST tax-invoice document for an invoice',
      description: 'Only for invoices issued while gstMode was "registered". CGST+SGST for intra-state supply, IGST otherwise.',
      security: AUTH,
      params: idParams,
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send(await renderTaxInvoice(req.tenant!.id, id))
  })

  // ── Owner: reports ───────────────────────────────────────────────────────

  app.get('/tenant/fees/reports/daybook', {
    schema: {
      tags: ['Fees'],
      summary: 'Daybook — cash closing for one day',
      security: AUTH,
      querystring: { type: 'object', properties: { date: { type: 'string', format: 'date', description: 'IST calendar day; defaults to today' } } },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { date } = req.query as { date?: string }
    reply.send(await getDaybook(req.tenant!.id, date))
  })

  app.get('/tenant/fees/reports/defaulters', {
    schema: {
      tags: ['Fees'],
      summary: 'Students with overdue fees',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          asOf: { type: 'string', format: 'date' },
          classId: { type: 'string', format: 'uuid' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    reply.send(await getDefaulters(req.tenant!.id, req.query as any))
  })

  app.get('/tenant/fees/reports/head-wise', {
    schema: {
      tags: ['Fees'],
      summary: 'Billed / collected / outstanding per fee head',
      security: AUTH,
      querystring: {
        type: 'object',
        required: ['academicYear'],
        properties: { academicYear: { type: 'string', pattern: '^\\d{4}(-\\d{2})?$' } },
      },
    },
    preHandler: OWNER,
  }, async (req, reply) => {
    const { academicYear } = req.query as { academicYear: string }
    reply.send(await getHeadWiseCollection(req.tenant!.id, academicYear))
  })

  // ── Student ──────────────────────────────────────────────────────────────
  // Ownership is checked in the service (every query is scoped to req.user's
  // own id) rather than by role — any authenticated member of the tenant may
  // read their own fees. A student never sees reversed rows (§7g).

  app.get('/fees/summary', {
    schema: { tags: ['Fees'], summary: "Get the caller's fee summary", security: AUTH },
    preHandler: STUDENT,
  }, async (req, reply) => {
    reply.send(await getFeesSummary(req.tenant!.id, req.user!.id))
  })

  app.get('/fees/invoices', {
    schema: {
      tags: ['Fees'],
      summary: "List the caller's own invoices",
      security: AUTH,
      querystring: {
        type: 'object',
        properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
    },
    preHandler: STUDENT,
  }, async (req, reply) => {
    const { cursor, limit } = req.query as { cursor?: string; limit?: number }
    reply.send(await listInvoicesForStudent(req.tenant!.id, req.user!.id, cursor, limit))
  })

  app.get('/fees/invoices/:id/tax-invoice', {
    schema: { tags: ['Fees'], summary: 'Get the GST tax invoice for one of the caller\'s invoices', security: AUTH, params: idParams },
    preHandler: STUDENT,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    reply.send(await renderTaxInvoice(req.tenant!.id, id, req.user!.id))
  })

  app.get('/fees/receipts', {
    schema: {
      tags: ['Fees'],
      summary: "List the caller's own receipts",
      security: AUTH,
      querystring: {
        type: 'object',
        properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
    },
    preHandler: STUDENT,
  }, async (req, reply) => {
    const { cursor, limit } = req.query as { cursor?: string; limit?: number }
    reply.send(await listStudentReceipts(req.tenant!.id, req.user!.id, { cursor, limit: pageSize(limit) }))
  })

  app.get('/fees/receipts/:id', {
    schema: {
      tags: ['Fees'],
      summary: 'Get one of the caller\'s own receipts',
      description: 'JSON by default; `?format=html` returns a printable page. Another student\'s receipt is a 404.',
      security: AUTH,
      params: idParams,
      querystring: { type: 'object', properties: { format: { type: 'string', enum: ['json', 'html'] } } },
    },
    preHandler: STUDENT,
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { format } = req.query as { format?: string }
    const payment = await getReceipt(req.tenant!.id, id, req.user!.id)
    if (format === 'html') return reply.type('text/html; charset=utf-8').send(renderReceiptHtml(payment))
    reply.send(renderReceipt(payment))
  })
}
