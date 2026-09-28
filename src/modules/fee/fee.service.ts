import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { tenants } from '../tenant/tenant.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { classes, classMembers } from '../class/class.schema.js'
import { dispatch } from '../notification/notification.service.js'
import {
  tenantFeeSettings,
  feeHeads,
  feeStructures,
  feeStructureItems,
  feeStructureInstallments,
  studentFeeAssignments,
  feeConcessions,
  feeInvoices,
  feeInvoiceItems,
  studentGuardians,
} from './fee.schema.js'
import { getFeeAssignmentQueue, type FeeAssignmentJobPayload } from './fee.queues.js'
import { allocateNumber, buildPartySnapshot } from './fee.receipt.js'
import { getCreditBalance, listStudentAdjustments, listStudentPayments } from './fee.ledger.js'
import {
  toPaise,
  formatINR,
  isOverdue,
  outstandingOf,
  isUniqueViolation,
  financialYearOf,
  todayIST,
  OPEN_INVOICE_STATUSES,
  DEFAULT_LATE_FEE_POLICY,
  DEFAULT_REMINDER_POLICY,
  type LateFeePolicy,
  type ReminderPolicy,
  type Paise,
  type FeeHeadCategory,
  type FeeConcessionType,
  type FeeConcessionMode,
  type GstMode,
} from './fee.types.js'

const PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

/** `limit` from the query string, clamped — every list endpoint takes one (§8). */
export function pageSize(limit?: number | string): number {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return PAGE_SIZE
  return Math.min(Math.floor(n), MAX_PAGE_SIZE)
}

// ── Cursor pagination — mirrors notification.service.ts#getNotifications ───────

export function cursorCondition(cursor: string | undefined, createdAt: any, id: any) {
  if (!cursor) return undefined
  const [tsStr, rowId] = cursor.split('_')
  const ts = new Date(tsStr)
  if (isNaN(ts.getTime()) || !rowId) return undefined
  return sql`(${createdAt}, ${id}) < (${ts.toISOString()}, ${rowId})`
}

export function nextCursor<T extends { createdAt: Date; id: string }>(rows: T[], hasMore: boolean): string | null {
  const last = rows.at(-1)
  return hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null
}

// ── Rounding helpers — §3: round half-up at persist time, last slice absorbs
// the remainder so the parts always sum to exactly the whole. ─────────────────

function splitByShares(total: Paise, slices: { key: string | number; sharePct: number }[]): Map<string | number, Paise> {
  const result = new Map<string | number, Paise>()
  let allocated = 0
  slices.forEach((slice, idx) => {
    if (idx === slices.length - 1) {
      result.set(slice.key, total - allocated)
    } else {
      const share = Math.round((total * slice.sharePct) / 100)
      result.set(slice.key, share)
      allocated += share
    }
  })
  return result
}

function distributeProportionally(total: Paise, weights: { key: string; weight: number }[]): Map<string, Paise> {
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0)
  const result = new Map<string, Paise>()
  if (totalWeight <= 0) {
    weights.forEach((w) => result.set(w.key, 0))
    return result
  }
  let allocated = 0
  weights.forEach((w, idx) => {
    if (idx === weights.length - 1) {
      result.set(w.key, total - allocated)
    } else {
      const share = Math.round((total * w.weight) / totalWeight)
      result.set(w.key, share)
      allocated += share
    }
  })
  return result
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getFeeSettings(tenantId: string) {
  const [existing] = await db.select().from(tenantFeeSettings).where(eq(tenantFeeSettings.tenantId, tenantId)).limit(1)
  if (existing) return existing

  const [tenant] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!tenant) throw Errors.NOT_FOUND('Tenant')
  const defaults = {
    tenantId,
    gstMode: 'none' as GstMode,
    receiptPrefix: tenant.slug.replace(/[^a-z0-9]/gi, '').slice(0, 12).toUpperCase() || 'FEE',
    financialYearStartMonth: 4,
    lateFeePolicy: DEFAULT_LATE_FEE_POLICY,
    reminderPolicy: DEFAULT_REMINDER_POLICY,
  }

  await db.insert(tenantFeeSettings).values(defaults).onConflictDoNothing()
  const [row] = await db.select().from(tenantFeeSettings).where(eq(tenantFeeSettings.tenantId, tenantId)).limit(1)
  return row
}

/**
 * Amounts arrive in rupees like everywhere else in the API and are stored in
 * paise: `bounceCharge`, `lateFeePolicy.capAmount`, and `lateFeePolicy.value`
 * when its mode is 'amount'.
 */
export async function updateFeeSettings(
  tenantId: string,
  patch: Partial<{
    gstMode: GstMode
    gstin: string | null
    placeOfSupplyCode: string | null
    receiptPrefix: string
    financialYearStartMonth: number
    bounceCharge: number
    lateFeePolicy: LateFeePolicy
    reminderPolicy: ReminderPolicy
  }>,
) {
  const current = await getFeeSettings(tenantId) // ensures a row exists

  const gstMode = patch.gstMode ?? current.gstMode
  const gstin = patch.gstin !== undefined ? patch.gstin : current.gstin
  if (gstMode === 'registered' && !gstin) throw Errors.VALIDATION('gstin is required when gstMode is registered')

  // Sequences and structures are scoped to the financial year. Moving its start
  // once money has been numbered would put two different years under one label.
  if (patch.financialYearStartMonth !== undefined && patch.financialYearStartMonth !== current.financialYearStartMonth) {
    const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(feeInvoices).where(eq(feeInvoices.tenantId, tenantId))
    if (used.n > 0) throw Errors.CONFLICT('financialYearStartMonth cannot change once invoices have been issued')
  }

  const { bounceCharge, lateFeePolicy, ...rest } = patch
  const values: Record<string, unknown> = { ...rest, updatedAt: new Date() }
  if (bounceCharge !== undefined) values.bounceChargeAmount = toPaise(bounceCharge)
  if (lateFeePolicy) {
    values.lateFeePolicy = {
      ...lateFeePolicy,
      value: lateFeePolicy.mode === 'amount' ? toPaise(lateFeePolicy.value) : lateFeePolicy.value,
      capAmount: lateFeePolicy.capAmount != null ? toPaise(lateFeePolicy.capAmount) : null,
    } satisfies LateFeePolicy
  }

  await db.update(tenantFeeSettings).set(values).where(eq(tenantFeeSettings.tenantId, tenantId))
  const [row] = await db.select().from(tenantFeeSettings).where(eq(tenantFeeSettings.tenantId, tenantId)).limit(1)
  return row
}

// ── Fee heads ────────────────────────────────────────────────────────────────

export async function createFeeHead(tenantId: string, input: {
  name: string
  code: string
  category: FeeHeadCategory
  isRefundable?: boolean
  taxRatePct?: number | null
  sacCode?: string | null
}) {
  try {
    const [row] = await db.insert(feeHeads).values({
      tenantId,
      name: input.name,
      code: input.code,
      category: input.category,
      isRefundable: input.isRefundable ?? false,
      taxRatePct: input.taxRatePct != null ? input.taxRatePct.toString() : null,
      sacCode: input.sacCode ?? null,
    }).returning()
    return row
  } catch (err: any) {
    if (isUniqueViolation(err)) throw Errors.CONFLICT(`A fee head with code "${input.code}" already exists`)
    throw err
  }
}

export async function listFeeHeads(tenantId: string, filter: { status?: string; cursor?: string; limit?: number }) {
  const size = pageSize(filter.limit)
  const conditions = [eq(feeHeads.tenantId, tenantId)]
  if (filter.status) conditions.push(eq(feeHeads.status, filter.status))
  const extra = cursorCondition(filter.cursor, feeHeads.createdAt, feeHeads.id)
  if (extra) conditions.push(extra as any)

  const rows = await db.select().from(feeHeads).where(and(...conditions))
    .orderBy(desc(feeHeads.createdAt), desc(feeHeads.id))
    .limit(size + 1)

  const hasMore = rows.length > size
  const items = hasMore ? rows.slice(0, size) : rows
  return { items, nextCursor: nextCursor(items, hasMore) }
}

export async function updateFeeHead(tenantId: string, id: string, patch: Partial<{
  name: string
  category: FeeHeadCategory
  isRefundable: boolean
  taxRatePct: number | null
  sacCode: string | null
  status: 'active' | 'archived'
}>) {
  const { taxRatePct, ...rest } = patch
  const values: Record<string, unknown> = { ...rest }
  if ('taxRatePct' in patch) values.taxRatePct = taxRatePct != null ? taxRatePct.toString() : null

  const [row] = await db.update(feeHeads).set(values).where(and(eq(feeHeads.id, id), eq(feeHeads.tenantId, tenantId))).returning()
  if (!row) throw Errors.NOT_FOUND('Fee head')
  return row
}

// ── Fee structures ───────────────────────────────────────────────────────────

async function getOwnedStructure(tenantId: string, structureId: string) {
  const [row] = await db.select().from(feeStructures).where(and(eq(feeStructures.id, structureId), eq(feeStructures.tenantId, tenantId))).limit(1)
  if (!row) throw Errors.NOT_FOUND('Fee structure')
  return row
}

export async function createFeeStructure(tenantId: string, createdBy: string, input: { name: string; academicYear: string }) {
  const [row] = await db.insert(feeStructures).values({
    tenantId,
    name: input.name,
    academicYear: input.academicYear,
    createdBy,
  }).returning()
  return row
}

export async function listFeeStructures(tenantId: string, filter: { academicYear?: string; status?: string; cursor?: string; limit?: number }) {
  const size = pageSize(filter.limit)
  const conditions = [eq(feeStructures.tenantId, tenantId)]
  if (filter.academicYear) conditions.push(eq(feeStructures.academicYear, filter.academicYear))
  if (filter.status) conditions.push(eq(feeStructures.status, filter.status))
  const extra = cursorCondition(filter.cursor, feeStructures.createdAt, feeStructures.id)
  if (extra) conditions.push(extra as any)

  const rows = await db.select().from(feeStructures).where(and(...conditions))
    .orderBy(desc(feeStructures.createdAt), desc(feeStructures.id))
    .limit(size + 1)

  const hasMore = rows.length > size
  const items = hasMore ? rows.slice(0, size) : rows
  return { items, nextCursor: nextCursor(items, hasMore) }
}

export async function getFeeStructureDetail(tenantId: string, structureId: string) {
  const structure = await getOwnedStructure(tenantId, structureId)
  const [items, installments] = await Promise.all([
    db.select().from(feeStructureItems).where(eq(feeStructureItems.structureId, structureId)).orderBy(asc(feeStructureItems.order)),
    db.select().from(feeStructureInstallments).where(eq(feeStructureInstallments.structureId, structureId)).orderBy(asc(feeStructureInstallments.seq)),
  ])
  return { structure, items, installments }
}

export async function addStructureItem(tenantId: string, structureId: string, input: { headId: string; amount: number; order?: number }) {
  const structure = await getOwnedStructure(tenantId, structureId)
  if (structure.status !== 'draft') throw Errors.CONFLICT('Only a draft structure can be edited — revise it to create a new version')

  const [head] = await db.select({ id: feeHeads.id }).from(feeHeads).where(and(eq(feeHeads.id, input.headId), eq(feeHeads.tenantId, tenantId))).limit(1)
  if (!head) throw Errors.NOT_FOUND('Fee head')

  const [row] = await db.insert(feeStructureItems).values({
    structureId,
    headId: input.headId,
    amount: toPaise(input.amount),
    order: input.order ?? 0,
  }).returning()
  return row
}

export async function addStructureInstallment(tenantId: string, structureId: string, input: { seq: number; label: string; dueDate: string; sharePct: number }) {
  const structure = await getOwnedStructure(tenantId, structureId)
  if (structure.status !== 'draft') throw Errors.CONFLICT('Only a draft structure can be edited — revise it to create a new version')

  try {
    const [row] = await db.insert(feeStructureInstallments).values({
      structureId,
      seq: input.seq,
      label: input.label,
      dueDate: input.dueDate,
      sharePct: input.sharePct.toString(),
    }).returning()
    return row
  } catch (err: any) {
    if (isUniqueViolation(err)) throw Errors.CONFLICT(`Installment seq ${input.seq} already exists on this structure`)
    throw err
  }
}

export async function publishFeeStructure(tenantId: string, structureId: string) {
  const { structure, items, installments } = await getFeeStructureDetail(tenantId, structureId)
  if (structure.status !== 'draft') throw Errors.CONFLICT('Structure is not in draft')

  if (items.length === 0) throw Errors.VALIDATION('A structure needs at least one fee item before it can be published')
  const itemTotal = items.reduce((s, i) => s + i.amount, 0)
  if (itemTotal <= 0) throw Errors.VALIDATION('Fee item amounts must sum to more than zero')

  if (installments.length === 0) throw Errors.VALIDATION('A structure needs at least one installment before it can be published')
  const sharePctTotal = installments.reduce((s, i) => s + Number(i.sharePct), 0)
  if (Math.round(sharePctTotal * 100) !== 10000) throw Errors.VALIDATION('Installment shares must sum to exactly 100%')

  const sorted = [...installments].sort((a, b) => a.seq - b.seq)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].dueDate <= sorted[i - 1].dueDate) {
      throw Errors.VALIDATION('Installment due dates must be strictly ascending')
    }
  }

  const settings = await getFeeSettings(tenantId)
  const startYear = Number(structure.academicYear.split('-')[0])
  const academicYearStart = `${startYear}-${String(settings.financialYearStartMonth).padStart(2, '0')}-01`
  if (sorted[0].dueDate < academicYearStart) {
    throw Errors.VALIDATION('No installment may be due before the academic year starts')
  }

  const [row] = await db.update(feeStructures)
    .set({ status: 'published', publishedAt: new Date() })
    .where(eq(feeStructures.id, structureId))
    .returning()
  return row
}

/**
 * Creates version n+1 as a new draft and immediately marks the CURRENT
 * structure as superseded — see the comment on `supersededById` in the
 * schema. The old version keeps working for students already on it; the new
 * one is refused for assignment until it is itself published (§7a).
 */
export async function reviseFeeStructure(tenantId: string, structureId: string, createdBy: string) {
  const structure = await getOwnedStructure(tenantId, structureId)
  if (structure.status !== 'published') throw Errors.CONFLICT('Only a published structure can be revised')
  if (structure.supersededById) throw Errors.CONFLICT('This structure has already been superseded')

  const [items, installments] = await Promise.all([
    db.select().from(feeStructureItems).where(eq(feeStructureItems.structureId, structureId)),
    db.select().from(feeStructureInstallments).where(eq(feeStructureInstallments.structureId, structureId)),
  ])

  return db.transaction(async (tx) => {
    const [revision] = await tx.insert(feeStructures).values({
      tenantId,
      name: structure.name,
      academicYear: structure.academicYear,
      version: structure.version + 1,
      createdBy,
    }).returning()

    if (items.length > 0) {
      await tx.insert(feeStructureItems).values(items.map((i) => ({
        structureId: revision.id,
        headId: i.headId,
        amount: i.amount,
        order: i.order,
      })))
    }
    if (installments.length > 0) {
      await tx.insert(feeStructureInstallments).values(installments.map((i) => ({
        structureId: revision.id,
        seq: i.seq,
        label: i.label,
        dueDate: i.dueDate,
        sharePct: i.sharePct,
      })))
    }

    await tx.update(feeStructures).set({ supersededById: revision.id }).where(eq(feeStructures.id, structureId))
    return revision
  })
}

// ── Assignment fan-out ───────────────────────────────────────────────────────

export async function assignStructureToClass(tenantId: string, structureId: string, classId: string): Promise<{ jobId: string }> {
  const structure = await getOwnedStructure(tenantId, structureId)
  if (structure.status !== 'published') throw Errors.CONFLICT('Structure must be published before it can be assigned')
  if (structure.supersededById) throw Errors.CONFLICT('This structure version has been superseded — assign the newer version instead')

  const [cls] = await db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, classId), eq(classes.tenantId, tenantId))).limit(1)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const job = await getFeeAssignmentQueue().add(
    'assign',
    { tenantId, structureId, classId } satisfies FeeAssignmentJobPayload,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  )
  return { jobId: job.id! }
}

/**
 * The fan-out worker body. Idempotent on (studentId, structureId,
 * academicYear) via the unique constraint — re-running after three new
 * students join creates exactly three assignments and touches nothing else.
 *
 * Per-student transactions rather than one giant transaction for the whole
 * class: keeps each unit small and lets a failure on one student not roll
 * back the others (BullMQ's own retry handles a fully-failed job).
 */
export async function runAssignmentFanout(payload: FeeAssignmentJobPayload): Promise<{ created: number; skipped: number }> {
  const { tenantId, structureId, classId } = payload
  const structure = await getOwnedStructure(tenantId, structureId)
  const [items, installments, settings] = await Promise.all([
    db.select({
      headId: feeStructureItems.headId,
      amount: feeStructureItems.amount,
      taxRatePct: feeHeads.taxRatePct,
    }).from(feeStructureItems)
      .innerJoin(feeHeads, eq(feeStructureItems.headId, feeHeads.id))
      .where(eq(feeStructureItems.structureId, structureId))
      .orderBy(asc(feeStructureItems.order), asc(feeStructureItems.headId)),
    db.select().from(feeStructureInstallments).where(eq(feeStructureInstallments.structureId, structureId)).orderBy(asc(feeStructureInstallments.seq)),
    getFeeSettings(tenantId),
  ])

  const grossAmount = items.reduce((s, i) => s + i.amount, 0)
  const studentIds = (await db.select({ studentId: classMembers.studentId }).from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.status, 'approved'))))
    .map((r) => r.studentId)

  // Tax only exists for a GST-registered tenant — a head's taxRatePct is
  // ignored otherwise, and the rate is frozen onto each item at issue.
  const registered = settings.gstMode === 'registered'
  const issueDate = todayIST()
  const invoiceFy = financialYearOf(issueDate, settings.financialYearStartMonth)

  let created = 0
  let skipped = 0

  for (const studentId of studentIds) {
    const result = await db.transaction(async (tx) => {
      const [assignment] = await tx.insert(studentFeeAssignments).values({
        tenantId,
        studentId,
        classId,
        structureId,
        academicYear: structure.academicYear,
        grossAmount,
        concessionAmount: 0,
        netAmount: grossAmount,
        effectiveFrom: issueDate,
      }).onConflictDoNothing({
        target: [studentFeeAssignments.studentId, studentFeeAssignments.structureId, studentFeeAssignments.academicYear],
      }).returning()

      if (!assignment) return null // already assigned — idempotent no-op

      const partySnapshot = registered ? await buildPartySnapshot(tx, tenantId, studentId) : null
      const perHeadShares = new Map(items.map((item) => [item.headId, splitByShares(item.amount, installments.map((inst) => ({ key: inst.seq, sharePct: Number(inst.sharePct) })))]))

      for (const inst of installments) {
        const headShares = items.map((item) => ({
          headId: item.headId,
          taxRatePct: registered ? item.taxRatePct : null,
          gross: perHeadShares.get(item.headId)!.get(inst.seq) as Paise,
        }))
        const grossForInstallment = headShares.reduce((s, h) => s + h.gross, 0)

        // Drawn from the same gap-free sequence machinery as receipts, so two
        // fan-out jobs running at once cannot hand out the same number.
        const invoiceNo = registered
          ? await allocateNumber(tx, tenantId, 'INVOICE', invoiceFy, settings.receiptPrefix)
          : null

        let invoiceTax = 0
        const itemValues = headShares.map((h) => {
          const tax = h.taxRatePct ? Math.round((h.gross * Number(h.taxRatePct)) / 100) : 0
          invoiceTax += tax
          return {
            headId: h.headId,
            grossAmount: h.gross,
            concessionAmount: 0,
            taxableAmount: h.gross,
            taxRatePct: h.taxRatePct,
            taxAmount: tax,
            totalAmount: h.gross + tax,
          }
        })

        const [invoice] = await tx.insert(feeInvoices).values({
          tenantId,
          kind: 'installment',
          assignmentId: assignment.id,
          studentId,
          installmentSeq: inst.seq,
          label: inst.label,
          invoiceNo,
          partySnapshot,
          issueDate,
          dueDate: inst.dueDate,
          grossAmount: grossForInstallment,
          concessionAmount: 0,
          taxableAmount: grossForInstallment,
          taxAmount: invoiceTax,
          totalAmount: grossForInstallment + invoiceTax,
        }).returning()

        if (itemValues.length > 0) {
          await tx.insert(feeInvoiceItems).values(itemValues.map((v) => ({ invoiceId: invoice.id, ...v })))
        }
      }

      return assignment
    })

    if (result) {
      created += 1
      void dispatch({
        type: 'fee_invoice_issued',
        recipients: { userIds: [studentId] },
        tenantId,
        data: {
          title: 'New fee invoices issued',
          body: `${installments.length} installment(s) totalling ${formatINR(grossAmount)} have been issued for "${structure.name}".`,
          link: '/fees',
        },
      })
    } else {
      skipped += 1
    }
  }

  return { created, skipped }
}

export async function listAssignments(tenantId: string, filter: { classId?: string; status?: string; cursor?: string; limit?: number }) {
  const size = pageSize(filter.limit)
  const conditions = [eq(studentFeeAssignments.tenantId, tenantId)]
  if (filter.classId) conditions.push(eq(studentFeeAssignments.classId, filter.classId))
  if (filter.status) conditions.push(eq(studentFeeAssignments.status, filter.status))
  const extra = cursorCondition(filter.cursor, studentFeeAssignments.createdAt, studentFeeAssignments.id)
  if (extra) conditions.push(extra as any)

  const rows = await db.select().from(studentFeeAssignments).where(and(...conditions))
    .orderBy(desc(studentFeeAssignments.createdAt), desc(studentFeeAssignments.id))
    .limit(size + 1)

  const hasMore = rows.length > size
  const items = hasMore ? rows.slice(0, size) : rows
  return { items, nextCursor: nextCursor(items, hasMore) }
}

// ── Concessions ──────────────────────────────────────────────────────────────

/**
 * Recomputes an assignment's concession/net snapshot from its concession rows
 * and re-splits every invoice/item proportionally by gross amount.
 *
 * Head-scoped redistribution (only reduce the invoice_items for a specific
 * head) is not implemented — `headId` on a concession is informational, and
 * every concession reduces the assignment as a whole. Tighten this once §13.5
 * (GST on concessions) is settled with a CA.
 */
async function recalcAssignmentConcessions(tx: any, assignmentId: string): Promise<void> {
  const [assignment] = await tx.select().from(studentFeeAssignments).where(eq(studentFeeAssignments.id, assignmentId)).limit(1).for('update')
  if (!assignment) throw Errors.NOT_FOUND('Assignment')

  // Locked in id order like fee.ledger.ts, so a payment being recorded against
  // one of these invoices right now either lands first (and this refuses) or
  // waits for the new totals.
  const locked = await tx.select().from(feeInvoices).where(eq(feeInvoices.assignmentId, assignmentId)).orderBy(asc(feeInvoices.id)).for('update')
  const invoices = [...locked].sort((a: any, b: any) => a.installmentSeq - b.installmentSeq)

  // §5.7, as enforced: the snapshot may be re-split only while every invoice is
  // untouched. Once a rupee has been paid or relieved, or an invoice has closed,
  // the totals are what receipts were written against — correct with a waiver
  // adjustment from then on, not by moving the concession.
  if (invoices.some((inv: any) => inv.status !== 'issued' || inv.paidAmount > 0 || inv.waivedAmount > 0)) {
    throw Errors.CONFLICT('Cannot change concessions once money has moved on this assignment — use a waiver adjustment instead')
  }

  const concessionRows = await tx.select({ amount: feeConcessions.computedAmount }).from(feeConcessions).where(eq(feeConcessions.assignmentId, assignmentId))
  const rawTotal = concessionRows.reduce((s: number, r: any) => s + r.amount, 0)
  const totalConcession = Math.max(0, Math.min(rawTotal, assignment.grossAmount))
  const netAmount = assignment.grossAmount - totalConcession

  await tx.update(studentFeeAssignments).set({ concessionAmount: totalConcession, netAmount }).where(eq(studentFeeAssignments.id, assignmentId))

  const invoiceShares = distributeProportionally(totalConcession, invoices.map((inv: any) => ({ key: inv.id, weight: inv.grossAmount })))

  for (const inv of invoices) {
    const concessionAmount = invoiceShares.get(inv.id) ?? 0
    // Ordered so which item absorbs the rounding remainder is deterministic,
    // not whatever order Postgres happens to return without an ORDER BY.
    const items = await tx.select().from(feeInvoiceItems).where(eq(feeInvoiceItems.invoiceId, inv.id)).orderBy(asc(feeInvoiceItems.headId))
    const itemShares = distributeProportionally(concessionAmount, items.map((it: any) => ({ key: it.id, weight: it.grossAmount })))

    let invoiceTax = 0
    let invoiceTaxable = 0
    for (const item of items) {
      const itemConcession = itemShares.get(item.id) ?? 0
      const itemTaxable = item.grossAmount - itemConcession
      const itemTax = item.taxRatePct ? Math.round((itemTaxable * Number(item.taxRatePct)) / 100) : 0
      invoiceTax += itemTax
      invoiceTaxable += itemTaxable
      await tx.update(feeInvoiceItems).set({
        concessionAmount: itemConcession,
        taxableAmount: itemTaxable,
        taxAmount: itemTax,
        totalAmount: itemTaxable + itemTax,
      }).where(eq(feeInvoiceItems.id, item.id))
    }

    await tx.update(feeInvoices).set({
      concessionAmount,
      taxableAmount: invoiceTaxable,
      taxAmount: invoiceTax,
      totalAmount: invoiceTaxable + invoiceTax,
      updatedAt: new Date(),
    }).where(eq(feeInvoices.id, inv.id))
  }
}

export async function addConcession(tenantId: string, assignmentId: string, approvedBy: string, input: {
  type: FeeConcessionType
  mode: FeeConcessionMode
  value: number
  headId?: string
  reason?: string
}) {
  if (input.mode === 'percent' && input.value > 100) throw Errors.VALIDATION('A percentage concession cannot exceed 100')
  return db.transaction(async (tx) => {
    const [assignment] = await tx.select().from(studentFeeAssignments)
      .where(and(eq(studentFeeAssignments.id, assignmentId), eq(studentFeeAssignments.tenantId, tenantId)))
      .limit(1)
    if (!assignment) throw Errors.NOT_FOUND('Assignment')

    const computedAmount = input.mode === 'percent'
      ? Math.round((assignment.grossAmount * input.value) / 100)
      : toPaise(input.value)

    const [row] = await tx.insert(feeConcessions).values({
      assignmentId,
      headId: input.headId ?? null,
      type: input.type,
      mode: input.mode,
      value: input.value.toString(),
      computedAmount,
      reason: input.reason ?? null,
      approvedBy,
    }).returning()

    await recalcAssignmentConcessions(tx, assignmentId)
    return row
  })
}

type ConcessionRow = typeof feeConcessions.$inferSelect

/**
 * Which grants have been reversed. A reversing row carries no pointer to its
 * original, but it copies the original's (type, mode, value) — and on one
 * assignment identical grants always compute to the same amount, because
 * `grossAmount` never changes. So grants and reversals pair up by that key,
 * oldest first, and the pairing is exact rather than a guess.
 */
export function withConcessionState(rows: ConcessionRow[]) {
  const key = (c: ConcessionRow) => `${c.assignmentId}|${c.type}|${c.mode}|${Number(c.value)}`
  const reversals = new Map<string, number>()
  for (const c of rows) if (c.computedAmount < 0) reversals.set(key(c), (reversals.get(key(c)) ?? 0) + 1)

  return [...rows]
    .sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime())
    .map((c) => {
      if (c.computedAmount < 0) return { ...c, isReversal: true, reversed: false }
      const left = reversals.get(key(c)) ?? 0
      if (left > 0) reversals.set(key(c), left - 1)
      return { ...c, isReversal: false, reversed: left > 0 }
    })
}

export async function reverseConcession(tenantId: string, concessionId: string, approvedBy: string, reason: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ concession: feeConcessions, tenantId: studentFeeAssignments.tenantId })
      .from(feeConcessions)
      .innerJoin(studentFeeAssignments, eq(feeConcessions.assignmentId, studentFeeAssignments.id))
      .where(eq(feeConcessions.id, concessionId))
      .limit(1)
    if (!row || row.tenantId !== tenantId) throw Errors.NOT_FOUND('Concession')

    const original = row.concession
    if (original.computedAmount <= 0) throw Errors.CONFLICT('A reversal cannot itself be reversed')

    // Serialise reversals on this assignment, then refuse a second reversal of
    // the same grant — without this, two clicks wrote two reversing rows.
    await tx.select({ id: studentFeeAssignments.id }).from(studentFeeAssignments)
      .where(eq(studentFeeAssignments.id, original.assignmentId)).for('update')
    const siblings = await tx.select().from(feeConcessions).where(eq(feeConcessions.assignmentId, original.assignmentId))
    if (withConcessionState(siblings).find((c) => c.id === original.id)?.reversed) {
      throw Errors.CONFLICT('Concession is already reversed')
    }

    const [reversal] = await tx.insert(feeConcessions).values({
      assignmentId: original.assignmentId,
      headId: original.headId,
      type: original.type,
      mode: original.mode,
      value: original.value,
      computedAmount: -original.computedAmount,
      reason,
      approvedBy,
    }).returning()

    await recalcAssignmentConcessions(tx, original.assignmentId)
    return reversal
  })
}

// ── Dues views ───────────────────────────────────────────────────────────────

const withDerived = <T extends { status: string; dueDate: string; totalAmount: number; paidAmount: number; waivedAmount: number }>(inv: T, today: string) => ({
  ...inv,
  outstanding: outstandingOf(inv),
  overdue: isOverdue(inv.status as any, inv.dueDate, today),
})

/** Everything the front desk needs about one student — owner view, reversed rows included. */
export async function getStudentLedger(tenantId: string, studentId: string) {
  const today = todayIST()
  const [assignments, concessions, invoices, payments, adjustments, guardians, creditBalance] = await Promise.all([
    db.select().from(studentFeeAssignments)
      .where(and(eq(studentFeeAssignments.tenantId, tenantId), eq(studentFeeAssignments.studentId, studentId)))
      .orderBy(desc(studentFeeAssignments.createdAt)),
    db.select({ concession: feeConcessions }).from(feeConcessions)
      .innerJoin(studentFeeAssignments, eq(feeConcessions.assignmentId, studentFeeAssignments.id))
      .where(and(eq(studentFeeAssignments.tenantId, tenantId), eq(studentFeeAssignments.studentId, studentId))),
    db.select().from(feeInvoices)
      .where(and(eq(feeInvoices.tenantId, tenantId), eq(feeInvoices.studentId, studentId)))
      .orderBy(asc(feeInvoices.dueDate)),
    listStudentPayments(tenantId, studentId, { includeReversed: true }),
    listStudentAdjustments(tenantId, studentId),
    listGuardians(tenantId, studentId),
    getCreditBalance(tenantId, studentId),
  ])

  return {
    assignments,
    concessions: withConcessionState(concessions.map((r) => r.concession)),
    invoices: invoices.map((inv) => withDerived(inv, today)),
    payments,
    adjustments,
    guardians,
    creditBalance,
  }
}

/**
 * §7g. No internal state — reversed payments never appear, cancelled invoices
 * are not billed, and waived money is neither paid nor owed.
 */
export async function getFeesSummary(tenantId: string, studentId: string) {
  const today = todayIST()
  const [invoices, creditBalance] = await Promise.all([
    db.select().from(feeInvoices)
      .where(and(eq(feeInvoices.tenantId, tenantId), eq(feeInvoices.studentId, studentId)))
      .orderBy(asc(feeInvoices.dueDate), asc(feeInvoices.installmentSeq)),
    getCreditBalance(tenantId, studentId),
  ])

  const billed = invoices.filter((i) => i.status !== 'cancelled' && i.status !== 'draft')
  const totalBilled = billed.reduce((s, i) => s + i.totalAmount, 0)
  const totalPaid = billed.reduce((s, i) => s + i.paidAmount, 0)
  const totalWaived = billed.reduce((s, i) => s + i.waivedAmount, 0)
  const open = billed.filter((i) => (OPEN_INVOICE_STATUSES as readonly string[]).includes(i.status))
  const next = open[0] ?? null // already sorted by due date

  return {
    totalBilled,
    totalPaid,
    totalWaived,
    balance: totalBilled - totalPaid - totalWaived,
    overdueAmount: open.filter((i) => i.dueDate < today).reduce((s, i) => s + outstandingOf(i), 0),
    creditBalance,
    nextDue: next ? { invoiceId: next.id, label: next.label, dueDate: next.dueDate, amount: outstandingOf(next) } : null,
    invoices: billed.map((inv) => withDerived(inv, today)),
  }
}

export async function listInvoicesForStudent(tenantId: string, studentId: string, cursor?: string, limit?: number) {
  const size = pageSize(limit)
  const today = todayIST()
  const conditions = [eq(feeInvoices.tenantId, tenantId), eq(feeInvoices.studentId, studentId), sql`${feeInvoices.status} <> 'cancelled'`]
  const extra = cursorCondition(cursor, feeInvoices.createdAt, feeInvoices.id)
  if (extra) conditions.push(extra as any)

  const rows = await db.select().from(feeInvoices).where(and(...conditions))
    .orderBy(desc(feeInvoices.createdAt), desc(feeInvoices.id))
    .limit(size + 1)

  const hasMore = rows.length > size
  const items = hasMore ? rows.slice(0, size) : rows
  return {
    items: items.map((inv) => withDerived(inv, today)),
    nextCursor: nextCursor(items, hasMore),
  }
}

// ── Guardians ────────────────────────────────────────────────────────────────

async function assertStudentMember(tenantId: string, studentId: string) {
  const [m] = await db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, studentId), eq(memberships.role, 'student')))
    .limit(1)
  if (!m) throw Errors.NOT_FOUND('Student')
}

export async function listGuardians(tenantId: string, studentId: string) {
  return db.select().from(studentGuardians)
    .where(and(eq(studentGuardians.tenantId, tenantId), eq(studentGuardians.studentId, studentId)))
    .orderBy(desc(studentGuardians.isPrimary), asc(studentGuardians.createdAt))
}

/**
 * Add a contact. The first guardian becomes primary automatically; naming a
 * new primary demotes the old one in the same transaction, so a student never
 * has two (the partial unique index would refuse it anyway).
 */
export async function addGuardian(tenantId: string, studentId: string, input: {
  name: string
  relation: string
  phone?: string | null
  email?: string | null
  isPrimary?: boolean
}) {
  if (!input.phone && !input.email) throw Errors.VALIDATION('A guardian needs a phone number or an email')
  await assertStudentMember(tenantId, studentId)

  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: studentGuardians.id }).from(studentGuardians)
      .where(and(eq(studentGuardians.tenantId, tenantId), eq(studentGuardians.studentId, studentId)))
    const isPrimary = input.isPrimary ?? existing.length === 0
    if (isPrimary && existing.length > 0) {
      await tx.update(studentGuardians).set({ isPrimary: false })
        .where(and(eq(studentGuardians.tenantId, tenantId), eq(studentGuardians.studentId, studentId)))
    }
    const [row] = await tx.insert(studentGuardians).values({
      tenantId,
      studentId,
      name: input.name,
      relation: input.relation,
      phone: input.phone ?? null,
      email: input.email ?? null,
      isPrimary,
    }).returning()
    return row
  })
}

export async function removeGuardian(tenantId: string, guardianId: string) {
  const [row] = await db.delete(studentGuardians)
    .where(and(eq(studentGuardians.id, guardianId), eq(studentGuardians.tenantId, tenantId)))
    .returning()
  if (!row) throw Errors.NOT_FOUND('Guardian')
  return row
}

/** Primary guardian per student, for reminders and the defaulter list. */
export async function primaryGuardians(tenantId: string, studentIds: string[]) {
  if (studentIds.length === 0) return new Map<string, typeof studentGuardians.$inferSelect>()
  const rows = await db.select().from(studentGuardians).where(and(
    eq(studentGuardians.tenantId, tenantId),
    inArray(studentGuardians.studentId, studentIds),
    eq(studentGuardians.isPrimary, true),
  ))
  return new Map(rows.map((r) => [r.studentId, r]))
}
