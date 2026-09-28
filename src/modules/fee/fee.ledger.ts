// ─────────────────────────────────────────────────────────────────────────────
// The ledger — the ONLY writer of money rows (LLD §2).
//
// Every write that moves a balance lives in this file: payments, allocations,
// bounces, reversals, adjustments, and the materialised `paidAmount` /
// `waivedAmount` / `status` on fee_invoices. If a second file starts writing
// any of those, the invariants in §5 stop being checkable by reading one place.
//
// Lock order, everywhere in this file, is: sequence row (if numbering) →
// payment rows (by id) → invoice rows (by id). One order means two of these
// transactions can wait on each other but never deadlock.
// ─────────────────────────────────────────────────────────────────────────────

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { auditLogs } from '../../shared/audit.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { dispatch } from '../notification/notification.service.js'
import {
  feeAdjustments,
  feeHeads,
  feeInvoiceItems,
  feeInvoices,
  feePaymentAllocations,
  feePayments,
} from './fee.schema.js'
import { getFeeSettings } from './fee.service.js'
import { allocateNumber, buildPartySnapshot, buildReceiptSnapshot } from './fee.receipt.js'
import {
  CHARGE_ADJUSTMENT_TYPES,
  CLEARABLE_MODES,
  OPEN_INVOICE_STATUSES,
  RELIEF_ADJUSTMENT_TYPES,
  deriveInvoiceStatus,
  financialYearOf,
  formatINR,
  isUniqueViolation,
  outstandingOf,
  toPaise,
  todayIST,
  type FeeAdjustmentType,
  type FeePaymentMode,
  type LateFeePolicy,
  type Paise,
  type Tx,
} from './fee.types.js'

/** Actor for writes no human made — the lifecycle tick levying a late fee. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000'

type InvoiceRow = typeof feeInvoices.$inferSelect
type PaymentRow = typeof feePayments.$inferSelect

// ── Shared primitives ─────────────────────────────────────────────────────────

/**
 * Audit rows are written INSIDE the ledger transaction, not through
 * `logInternalAction` (which swallows its own failure by design). For money,
 * "the entry exists but nobody knows who made it" is not an acceptable outcome
 * — if the audit row cannot be written, neither can the entry.
 */
async function audit(tx: Tx, entry: {
  actorId: string
  tenantId: string
  action: string
  targetId: string
  metadata?: Record<string, unknown>
}) {
  await tx.insert(auditLogs).values({
    actorId: entry.actorId,
    tenantId: entry.tenantId,
    action: entry.action,
    targetId: entry.targetId,
    metadata: entry.metadata ?? null,
  })
}

/** Lock invoices in id order and return them keyed by id. */
async function lockInvoices(tx: Tx, ids: string[]): Promise<Map<string, InvoiceRow>> {
  if (ids.length === 0) return new Map()
  const rows = await tx.select().from(feeInvoices)
    .where(inArray(feeInvoices.id, [...new Set(ids)]))
    .orderBy(asc(feeInvoices.id))
    .for('update')
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * Apply a delta to an invoice's materialised balances and re-derive its
 * status. The single place a balance moves — every flow below ends here.
 */
async function moveInvoiceBalance(tx: Tx, inv: InvoiceRow, delta: { paid?: Paise; waived?: Paise }): Promise<InvoiceRow> {
  const paidAmount = inv.paidAmount + (delta.paid ?? 0)
  const waivedAmount = inv.waivedAmount + (delta.waived ?? 0)
  if (paidAmount < 0 || waivedAmount < 0) {
    // Can only happen if the materialised balance has already drifted — refuse
    // rather than write a negative, and let the reconciler repair the row.
    throw Errors.CONFLICT(`Invoice ${inv.id} balance would go negative — run the fee reconciler`)
  }
  const status = deriveInvoiceStatus({ ...inv, paidAmount, waivedAmount })
  const [row] = await tx.update(feeInvoices)
    .set({ paidAmount, waivedAmount, status, updatedAt: new Date() })
    .where(eq(feeInvoices.id, inv.id))
    .returning()
  return row
}

const isOpen = (inv: InvoiceRow) => (OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status)

/** Oldest due first; ties by installment then creation — deterministic. */
function byDueDate(a: InvoiceRow, b: InvoiceRow): number {
  return a.dueDate.localeCompare(b.dueDate)
    || (a.installmentSeq ?? 0) - (b.installmentSeq ?? 0)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || a.id.localeCompare(b.id)
}

async function assertStudentOfTenant(tenantId: string, studentId: string): Promise<void> {
  const [member] = await db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, studentId)))
    .limit(1)
  if (member) return
  // A student who has left the coaching can still settle old dues.
  const [invoice] = await db.select({ id: feeInvoices.id }).from(feeInvoices)
    .where(and(eq(feeInvoices.tenantId, tenantId), eq(feeInvoices.studentId, studentId)))
    .limit(1)
  if (!invoice) throw Errors.NOT_FOUND('Student')
}

// ── Record a payment (§7c) ────────────────────────────────────────────────────

export interface RecordPaymentInput {
  studentId: string
  /** Rupees. */
  amount: number
  mode: FeePaymentMode
  reference?: string | null
  instrumentDate?: string | null
  bankName?: string | null
  /** ISO timestamp; defaults to now. */
  receivedAt?: string
  /** Explicit allocation in rupees. Omitted = oldest-due-first. */
  allocations?: { invoiceId: string; amount: number }[]
  idempotencyKey: string
}

export interface RecordPaymentResult {
  payment: PaymentRow
  allocations: (typeof feePaymentAllocations.$inferSelect)[]
  replayed: boolean
}

async function findByIdempotencyKey(tenantId: string, key: string) {
  const [payment] = await db.select().from(feePayments)
    .where(and(eq(feePayments.tenantId, tenantId), eq(feePayments.idempotencyKey, key)))
    .limit(1)
  if (!payment) return null
  const allocations = await db.select().from(feePaymentAllocations).where(eq(feePaymentAllocations.paymentId, payment.id))
  return { payment, allocations }
}

function replayOrConflict(existing: { payment: PaymentRow; allocations: any[] }, input: RecordPaymentInput): RecordPaymentResult {
  // Same key, different payment = a client bug, not a retry. Returning the
  // original would silently drop the second payment; say so instead.
  if (existing.payment.studentId !== input.studentId || existing.payment.amount !== toPaise(input.amount)) {
    throw Errors.CONFLICT('Idempotency-Key was already used for a different payment')
  }
  return { ...existing, replayed: true }
}

/**
 * The critical transaction. One receipt number, one payment row, N
 * allocations, N invoice balance moves and an audit row — all or nothing.
 *
 * A replay of the same Idempotency-Key returns the original payment and
 * receipt, never a second one (§10). The unique index is the real guard; the
 * lookup up front is only the fast path.
 */
export async function recordPayment(tenantId: string, recordedBy: string, input: RecordPaymentInput): Promise<RecordPaymentResult> {
  const existing = await findByIdempotencyKey(tenantId, input.idempotencyKey)
  if (existing) return replayOrConflict(existing, input)

  const amount = toPaise(input.amount)
  if (!Number.isInteger(amount) || amount <= 0) throw Errors.VALIDATION('amount must be greater than zero')
  if (CLEARABLE_MODES.includes(input.mode) && !input.reference) {
    throw Errors.VALIDATION(`A ${input.mode} payment needs its instrument number in "reference"`)
  }
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date()
  if (isNaN(receivedAt.getTime())) throw Errors.VALIDATION('receivedAt is not a valid timestamp')
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw Errors.VALIDATION('receivedAt cannot be in the future')

  await assertStudentOfTenant(tenantId, input.studentId)
  const settings = await getFeeSettings(tenantId)
  // Numbered by the year the receipt is ISSUED in, so the sequence stays in
  // issue order even when the front desk back-dates a payment across March 31.
  const financialYear = financialYearOf(todayIST(), settings.financialYearStartMonth)

  let result: Omit<RecordPaymentResult, 'replayed'>
  try {
    result = await db.transaction(async (tx) => {
      const receiptNo = await allocateNumber(tx, tenantId, 'RECEIPT', financialYear, settings.receiptPrefix)

      // Plan the allocations against locked invoices.
      const explicit = input.allocations
      let plan: { inv: InvoiceRow; amount: Paise }[] = []

      if (explicit && explicit.length > 0) {
        const ids = explicit.map((a) => a.invoiceId)
        if (new Set(ids).size !== ids.length) throw Errors.VALIDATION('An invoice appears twice in allocations')
        const locked = await lockInvoices(tx, ids)
        for (const a of explicit) {
          const inv = locked.get(a.invoiceId)
          // §5.5 — tenant AND student must match. Reported as not-found so a
          // probe cannot tell "exists in another tenant" from "does not exist".
          if (!inv || inv.tenantId !== tenantId || inv.studentId !== input.studentId) throw Errors.NOT_FOUND('Invoice')
          if (!isOpen(inv)) throw Errors.CONFLICT(`Invoice "${inv.label}" is ${inv.status} and cannot take a payment`)
          const allocAmount = toPaise(a.amount)
          if (allocAmount <= 0) throw Errors.VALIDATION('Allocation amounts must be greater than zero')
          if (allocAmount > outstandingOf(inv)) {
            throw Errors.VALIDATION(`Allocation to "${inv.label}" exceeds its outstanding ${formatINR(outstandingOf(inv))}`)
          }
          plan.push({ inv, amount: allocAmount })
        }
        const planned = plan.reduce((s, p) => s + p.amount, 0)
        if (planned > amount) throw Errors.VALIDATION('Allocations exceed the amount received') // §5.1
      } else {
        const openIds = (await tx.select({ id: feeInvoices.id }).from(feeInvoices).where(and(
          eq(feeInvoices.tenantId, tenantId),
          eq(feeInvoices.studentId, input.studentId),
          inArray(feeInvoices.status, [...OPEN_INVOICE_STATUSES]),
        ))).map((r) => r.id)
        const locked = await lockInvoices(tx, openIds)
        let remaining = amount
        for (const inv of [...locked.values()].filter(isOpen).sort(byDueDate)) {
          if (remaining <= 0) break
          const take = Math.min(remaining, outstandingOf(inv))
          if (take <= 0) continue
          plan.push({ inv, amount: take })
          remaining -= take
        }
      }

      const clearanceStatus = CLEARABLE_MODES.includes(input.mode) ? 'pending' : 'cleared'
      const documentSnapshot = await buildReceiptSnapshot(tx, {
        tenantId,
        studentId: input.studentId,
        recordedBy,
        receiptNo,
        financialYear,
        payment: {
          amount,
          mode: input.mode,
          reference: input.reference ?? null,
          instrumentDate: input.instrumentDate ?? null,
          bankName: input.bankName ?? null,
          receivedAt: receivedAt.toISOString(),
        },
        allocations: plan.map((p) => ({ invoiceId: p.inv.id, label: p.inv.label, dueDate: p.inv.dueDate, amount: p.amount })),
      })

      const [payment] = await tx.insert(feePayments).values({
        tenantId,
        studentId: input.studentId,
        receiptNo,
        financialYear,
        amount,
        mode: input.mode,
        reference: input.reference ?? null,
        instrumentDate: input.instrumentDate ?? null,
        bankName: input.bankName ?? null,
        receivedAt,
        clearanceStatus,
        clearedAt: clearanceStatus === 'cleared' ? new Date() : null,
        recordedBy,
        idempotencyKey: input.idempotencyKey,
        documentSnapshot,
      }).returning()

      const allocations = plan.length > 0
        ? await tx.insert(feePaymentAllocations).values(plan.map((p) => ({
          tenantId,
          paymentId: payment.id,
          invoiceId: p.inv.id,
          amount: p.amount,
        }))).returning()
        : []

      for (const p of plan) await moveInvoiceBalance(tx, p.inv, { paid: p.amount })

      await audit(tx, {
        actorId: recordedBy,
        tenantId,
        action: 'fee.payment.recorded',
        targetId: payment.id,
        metadata: { receiptNo, amount, mode: input.mode, studentId: input.studentId, allocations: plan.map((p) => ({ invoiceId: p.inv.id, amount: p.amount })) },
      })

      return { payment, allocations }
    })
  } catch (err: any) {
    // Lost the race to a concurrent submit of the same key. Our transaction
    // rolled back — receipt number included — so replay the winner's.
    if (isUniqueViolation(err, 'idempotency')) {
      const winner = await findByIdempotencyKey(tenantId, input.idempotencyKey)
      if (winner) return replayOrConflict(winner, input)
    }
    throw err
  }

  void dispatch({
    type: 'fee_payment_recorded',
    recipients: { userIds: [input.studentId] },
    tenantId,
    data: {
      title: `Payment received — receipt ${result.payment.receiptNo}`,
      body: `${formatINR(amount)} received by ${input.mode.replace('_', ' ')}. Receipt ${result.payment.receiptNo}.`,
      link: '/fees',
      metadata: { paymentId: result.payment.id, receiptNo: result.payment.receiptNo },
    },
  })

  return { ...result, replayed: false }
}

// ── Credit ────────────────────────────────────────────────────────────────────

/**
 * Unallocated remainder per live payment. Bounced and reversed money is not
 * credit.
 *
 * Two grouped queries stitched in JS rather than a correlated subquery: drizzle
 * renders `${feePayments.id}` UNQUALIFIED inside a raw `sql` template when the
 * outer query has no join, so `a.payment_id = ${feePayments.id}` would come out
 * as `a.payment_id = "id"` — bound to the allocation's own id, silently 0.
 */
async function creditByPayment(tx: Tx | typeof db, tenantId: string, studentId: string) {
  const payments = await tx.select({ id: feePayments.id, amount: feePayments.amount }).from(feePayments).where(and(
    eq(feePayments.tenantId, tenantId),
    eq(feePayments.studentId, studentId),
    eq(feePayments.status, 'recorded'),
    sql`${feePayments.clearanceStatus} <> 'bounced'`,
  )).orderBy(asc(feePayments.receivedAt), asc(feePayments.id))
  if (payments.length === 0) return []

  const sums = await tx.select({
    paymentId: feePaymentAllocations.paymentId,
    allocated: sql<string>`sum(${feePaymentAllocations.amount})`,
  }).from(feePaymentAllocations)
    .where(inArray(feePaymentAllocations.paymentId, payments.map((p) => p.id)))
    .groupBy(feePaymentAllocations.paymentId)
  const allocated = new Map(sums.map((s) => [s.paymentId, Number(s.allocated)]))

  return payments
    .map((p) => ({ id: p.id, remaining: p.amount - (allocated.get(p.id) ?? 0) }))
    .filter((r) => r.remaining > 0)
}

export async function getCreditBalance(tenantId: string, studentId: string): Promise<Paise> {
  return (await creditByPayment(db, tenantId, studentId)).reduce((s, r) => s + r.remaining, 0)
}

/**
 * Spend a student's credit (the unallocated remainder of earlier payments) on
 * their open invoices, oldest payment against oldest due. Used when an advance
 * was paid before the invoices it was meant for existed.
 *
 * A (payment, invoice) pair that already has an allocation is skipped rather
 * than topped up — allocation rows are never edited (§5.4).
 */
export async function applyCredit(tenantId: string, actorId: string, studentId: string) {
  return db.transaction(async (tx) => {
    const paymentIds = (await tx.select({ id: feePayments.id }).from(feePayments).where(and(
      eq(feePayments.tenantId, tenantId),
      eq(feePayments.studentId, studentId),
      eq(feePayments.status, 'recorded'),
    ))).map((r) => r.id)
    if (paymentIds.length === 0) return { allocated: 0, allocations: [] }
    await tx.select({ id: feePayments.id }).from(feePayments)
      .where(inArray(feePayments.id, paymentIds)).orderBy(asc(feePayments.id)).for('update')

    const credits = await creditByPayment(tx, tenantId, studentId)
    if (credits.length === 0) return { allocated: 0, allocations: [] }

    const openIds = (await tx.select({ id: feeInvoices.id }).from(feeInvoices).where(and(
      eq(feeInvoices.tenantId, tenantId),
      eq(feeInvoices.studentId, studentId),
      inArray(feeInvoices.status, [...OPEN_INVOICE_STATUSES]),
    ))).map((r) => r.id)
    const locked = await lockInvoices(tx, openIds)
    const invoices = [...locked.values()].filter(isOpen).sort(byDueDate)

    const existingPairs = new Set((await tx.select({ p: feePaymentAllocations.paymentId, i: feePaymentAllocations.invoiceId })
      .from(feePaymentAllocations).where(inArray(feePaymentAllocations.paymentId, credits.map((c) => c.id))))
      .map((r) => `${r.p}:${r.i}`))

    const rows: { paymentId: string; invoiceId: string; amount: Paise }[] = []
    const invoiceOutstanding = new Map(invoices.map((i) => [i.id, outstandingOf(i)]))
    for (const credit of credits) {
      let remaining = credit.remaining
      for (const inv of invoices) {
        if (remaining <= 0) break
        const open = invoiceOutstanding.get(inv.id)!
        if (open <= 0 || existingPairs.has(`${credit.id}:${inv.id}`)) continue
        const take = Math.min(remaining, open)
        rows.push({ paymentId: credit.id, invoiceId: inv.id, amount: take })
        invoiceOutstanding.set(inv.id, open - take)
        remaining -= take
      }
    }
    if (rows.length === 0) return { allocated: 0, allocations: [] }

    const allocations = await tx.insert(feePaymentAllocations).values(rows.map((r) => ({ tenantId, ...r }))).returning()
    const perInvoice = new Map<string, Paise>()
    for (const r of rows) perInvoice.set(r.invoiceId, (perInvoice.get(r.invoiceId) ?? 0) + r.amount)
    for (const [invoiceId, paid] of perInvoice) await moveInvoiceBalance(tx, locked.get(invoiceId)!, { paid })

    const allocated = rows.reduce((s, r) => s + r.amount, 0)
    await audit(tx, { actorId, tenantId, action: 'fee.credit.applied', targetId: studentId, metadata: { allocated, allocations: rows } })
    return { allocated, allocations }
  })
}

// ── Clearance and bounce (§7d) ────────────────────────────────────────────────

async function lockPayment(tx: Tx, tenantId: string, paymentId: string): Promise<PaymentRow> {
  const [payment] = await tx.select().from(feePayments)
    .where(and(eq(feePayments.id, paymentId), eq(feePayments.tenantId, tenantId)))
    .for('update')
  if (!payment) throw Errors.NOT_FOUND('Payment')
  return payment
}

/** Take a payment's live allocations back off their invoices. Allocations are kept. */
async function unwindAllocations(tx: Tx, paymentId: string): Promise<Paise> {
  const allocations = await tx.select().from(feePaymentAllocations).where(eq(feePaymentAllocations.paymentId, paymentId))
  const locked = await lockInvoices(tx, allocations.map((a) => a.invoiceId))
  for (const a of allocations) {
    const inv = locked.get(a.invoiceId)!
    locked.set(inv.id, await moveInvoiceBalance(tx, inv, { paid: -a.amount }))
  }
  return allocations.reduce((s, a) => s + a.amount, 0)
}

export async function setPaymentClearance(
  tenantId: string,
  actorId: string,
  paymentId: string,
  input: { outcome: 'cleared' | 'bounced'; reason?: string },
) {
  const settings = await getFeeSettings(tenantId)

  const outcome = await db.transaction(async (tx) => {
    const payment = await lockPayment(tx, tenantId, paymentId)
    if (payment.status !== 'recorded') throw Errors.CONFLICT('A reversed payment cannot change clearance')
    if (payment.clearanceStatus !== 'pending') throw Errors.CONFLICT(`Payment is already ${payment.clearanceStatus}`)

    if (input.outcome === 'cleared') {
      const [row] = await tx.update(feePayments)
        .set({ clearanceStatus: 'cleared', clearedAt: new Date(), updatedAt: new Date() })
        .where(eq(feePayments.id, paymentId)).returning()
      await audit(tx, { actorId, tenantId, action: 'fee.payment.cleared', targetId: paymentId })
      return { payment: row, bounceCharge: null }
    }

    if (!input.reason) throw Errors.VALIDATION('A bounce needs a reason')
    const [row] = await tx.update(feePayments)
      .set({ clearanceStatus: 'bounced', bouncedAt: new Date(), bounceReason: input.reason, updatedAt: new Date() })
      .where(eq(feePayments.id, paymentId)).returning()

    // paid → partially_paid is the edge implementations forget (§6).
    const unwound = await unwindAllocations(tx, paymentId)

    let bounceCharge = null
    if (settings.bounceChargeAmount > 0) {
      bounceCharge = await levyCharge(tx, {
        tenantId,
        studentId: payment.studentId,
        type: 'bounce_charge',
        amount: settings.bounceChargeAmount,
        paymentId,
        label: `Cheque bounce charge — ${payment.receiptNo}`,
        dueDate: todayIST(),
        reason: input.reason,
        createdBy: actorId,
      })
    }

    await audit(tx, {
      actorId, tenantId, action: 'fee.payment.bounced', targetId: paymentId,
      metadata: { reason: input.reason, unwound, bounceChargeAdjustmentId: bounceCharge?.id ?? null },
    })
    return { payment: row, bounceCharge }
  })

  if (input.outcome === 'bounced') {
    void dispatch({
      type: 'fee_payment_bounced',
      recipients: { userIds: [outcome.payment.studentId] },
      tenantId,
      data: {
        title: `Payment ${outcome.payment.receiptNo} bounced`,
        body: `Your ${outcome.payment.mode.toUpperCase()} payment of ${formatINR(outcome.payment.amount)} (receipt ${outcome.payment.receiptNo}) was returned by the bank. The amount is due again.`,
        link: '/fees',
        metadata: { paymentId, receiptNo: outcome.payment.receiptNo },
      },
    })
  }

  return outcome
}

// ── Reversal of a mis-keyed entry (§7e) ───────────────────────────────────────

export async function reversePayment(tenantId: string, actorId: string, paymentId: string, reason: string) {
  if (!reason?.trim()) throw Errors.VALIDATION('A reversal needs a reason')
  return db.transaction(async (tx) => {
    const payment = await lockPayment(tx, tenantId, paymentId)
    if (payment.status === 'reversed') throw Errors.CONFLICT('Payment is already reversed')

    const [row] = await tx.update(feePayments).set({
      status: 'reversed',
      reversedBy: actorId,
      reversedAt: new Date(),
      reversalReason: reason,
      updatedAt: new Date(),
    }).where(eq(feePayments.id, paymentId)).returning()

    // A bounced payment's allocations were already taken off in the bounce.
    const unwound = payment.clearanceStatus === 'bounced' ? 0 : await unwindAllocations(tx, paymentId)

    await audit(tx, {
      actorId, tenantId, action: 'fee.payment.reversed', targetId: paymentId,
      metadata: { reason, receiptNo: payment.receiptNo, amount: payment.amount, unwound },
    })
    return row
  })
}

// ── Adjustments ───────────────────────────────────────────────────────────────

const SYSTEM_HEADS: Record<string, { code: string; name: string; category: string }> = {
  late_fee: { code: 'LATE_FEE', name: 'Late Fee', category: 'penalty' },
  bounce_charge: { code: 'BOUNCE_CHARGE', name: 'Cheque Bounce Charge', category: 'penalty' },
  opening_balance: { code: 'OPENING_BALANCE', name: 'Opening Balance', category: 'other' },
}

/**
 * The head a charge invoice's single line is billed under. Created on first
 * use; if the owner already made a head with that code, theirs is used — and
 * with it their tax rate and SAC code.
 */
async function ensureSystemHead(tx: Tx, tenantId: string, type: FeeAdjustmentType) {
  const spec = SYSTEM_HEADS[type]
  await tx.insert(feeHeads).values({ tenantId, ...spec }).onConflictDoNothing()
  const [head] = await tx.select().from(feeHeads).where(and(eq(feeHeads.tenantId, tenantId), eq(feeHeads.code, spec.code))).limit(1)
  return head
}

interface ChargeInput {
  tenantId: string
  studentId: string
  type: FeeAdjustmentType
  amount: Paise
  label: string
  dueDate: string
  reason?: string | null
  sourceInvoiceId?: string
  paymentId?: string
  createdBy: string | null
}

/**
 * Raise what a student owes by a positive adjustment: the adjustment row plus
 * a `charge` invoice (one line, on the matching system head) that a payment
 * can be allocated against.
 *
 * The adjustment is inserted FIRST, under the partial unique indexes, so a
 * late fee or bounce charge that was already levied short-circuits here and
 * returns null — the "tick that runs twice cannot charge twice" guarantee.
 */
export async function levyCharge(tx: Tx, input: ChargeInput) {
  const [adjustment] = await tx.insert(feeAdjustments).values({
    tenantId: input.tenantId,
    studentId: input.studentId,
    type: input.type,
    amount: input.amount,
    sourceInvoiceId: input.sourceInvoiceId ?? null,
    paymentId: input.paymentId ?? null,
    reason: input.reason ?? null,
    createdBy: input.createdBy,
  }).onConflictDoNothing().returning()
  if (!adjustment) return null

  const settings = await getFeeSettings(input.tenantId)
  const head = await ensureSystemHead(tx, input.tenantId, input.type)
  const registered = settings.gstMode === 'registered'
  const taxRatePct = registered ? head.taxRatePct : null
  const taxAmount = taxRatePct ? Math.round((input.amount * Number(taxRatePct)) / 100) : 0
  const issueDate = todayIST()

  const [invoice] = await tx.insert(feeInvoices).values({
    tenantId: input.tenantId,
    kind: 'charge',
    studentId: input.studentId,
    label: input.label.slice(0, 80),
    invoiceNo: registered
      ? await allocateNumber(tx, input.tenantId, 'INVOICE', financialYearOf(issueDate, settings.financialYearStartMonth), settings.receiptPrefix)
      : null,
    issueDate,
    dueDate: input.dueDate,
    grossAmount: input.amount,
    taxableAmount: input.amount,
    taxAmount,
    totalAmount: input.amount + taxAmount,
    partySnapshot: registered ? await buildPartySnapshot(tx, input.tenantId, input.studentId) : null,
  }).returning()

  await tx.insert(feeInvoiceItems).values({
    invoiceId: invoice.id,
    headId: head.id,
    grossAmount: input.amount,
    taxableAmount: input.amount,
    taxRatePct,
    taxAmount,
    totalAmount: input.amount + taxAmount,
  })

  // Linking the charge invoice is not an amount change (§5.4 is about amounts).
  const [linked] = await tx.update(feeAdjustments).set({ invoiceId: invoice.id }).where(eq(feeAdjustments.id, adjustment.id)).returning()

  await audit(tx, {
    actorId: input.createdBy ?? SYSTEM_ACTOR,
    tenantId: input.tenantId,
    action: `fee.adjustment.${input.type}`,
    targetId: adjustment.id,
    metadata: { amount: input.amount, invoiceId: invoice.id, sourceInvoiceId: input.sourceInvoiceId ?? null, paymentId: input.paymentId ?? null },
  })
  return linked
}

/**
 * The lifecycle tick's late fee on one overdue installment (§7f). Computed on
 * the outstanding balance read under the invoice's lock, capped by policy, and
 * deduplicated by the partial unique index inside `levyCharge` — so however
 * many times the tick runs, an invoice carries at most one late fee.
 */
export async function levyLateFee(tenantId: string, sourceInvoiceId: string, policy: LateFeePolicy) {
  return db.transaction(async (tx) => {
    const source = (await lockInvoices(tx, [sourceInvoiceId])).get(sourceInvoiceId)
    if (!source || source.tenantId !== tenantId || source.kind !== 'installment' || !isOpen(source)) return null
    const outstanding = outstandingOf(source)
    if (outstanding <= 0) return null

    let amount = policy.mode === 'percent' ? Math.round((outstanding * policy.value) / 100) : Math.round(policy.value)
    if (policy.capAmount != null) amount = Math.min(amount, policy.capAmount)
    if (amount <= 0) return null

    return levyCharge(tx, {
      tenantId,
      studentId: source.studentId,
      type: 'late_fee',
      amount,
      label: `Late fee — ${source.label}`,
      dueDate: todayIST(),
      reason: `Levied automatically: ${source.label} was due ${source.dueDate}`,
      sourceInvoiceId,
      createdBy: null,
    })
  })
}

export interface CreateAdjustmentInput {
  studentId: string
  type: Exclude<FeeAdjustmentType, 'bounce_charge'>
  /** Rupees, always positive — the type decides the sign. */
  amount: number
  /** Relief types: the invoice relieved. late_fee: the overdue invoice it is levied on. */
  invoiceId?: string
  /** Charge types only; defaults to today. */
  dueDate?: string
  reason: string
}

/**
 * Owner-entered adjustments. `bounce_charge` is not accepted here — it is
 * only ever levied by the bounce flow, against the payment that bounced.
 */
export async function createAdjustment(tenantId: string, actorId: string, input: CreateAdjustmentInput) {
  const amount = toPaise(input.amount)
  if (amount <= 0) throw Errors.VALIDATION('amount must be greater than zero')
  if (!input.reason?.trim()) throw Errors.VALIDATION('An adjustment needs a reason')
  await assertStudentOfTenant(tenantId, input.studentId)

  if (RELIEF_ADJUSTMENT_TYPES.includes(input.type)) {
    if (!input.invoiceId) throw Errors.VALIDATION(`A ${input.type} must name the invoice it relieves`)
    return db.transaction(async (tx) => {
      const inv = (await lockInvoices(tx, [input.invoiceId!])).get(input.invoiceId!)
      if (!inv || inv.tenantId !== tenantId || inv.studentId !== input.studentId) throw Errors.NOT_FOUND('Invoice')
      if (!isOpen(inv)) throw Errors.CONFLICT(`Invoice "${inv.label}" is ${inv.status} — nothing left to relieve`)
      if (amount > outstandingOf(inv)) {
        throw Errors.VALIDATION(`${input.type} exceeds the outstanding ${formatINR(outstandingOf(inv))} on "${inv.label}"`)
      }
      const [adjustment] = await tx.insert(feeAdjustments).values({
        tenantId,
        studentId: input.studentId,
        type: input.type,
        amount: -amount,
        invoiceId: inv.id,
        reason: input.reason,
        createdBy: actorId,
      }).returning()
      await moveInvoiceBalance(tx, inv, { waived: amount })
      await audit(tx, { actorId, tenantId, action: `fee.adjustment.${input.type}`, targetId: adjustment.id, metadata: { amount: -amount, invoiceId: inv.id } })
      return adjustment
    })
  }

  if (!CHARGE_ADJUSTMENT_TYPES.includes(input.type)) throw Errors.VALIDATION(`Unknown adjustment type "${input.type}"`)

  return db.transaction(async (tx) => {
    let label = 'Opening balance'
    if (input.type === 'late_fee') {
      if (!input.invoiceId) throw Errors.VALIDATION('A late fee must name the overdue invoice it is levied on')
      const source = (await lockInvoices(tx, [input.invoiceId])).get(input.invoiceId)
      if (!source || source.tenantId !== tenantId || source.studentId !== input.studentId) throw Errors.NOT_FOUND('Invoice')
      label = `Late fee — ${source.label}`
    }
    const adjustment = await levyCharge(tx, {
      tenantId,
      studentId: input.studentId,
      type: input.type,
      amount,
      label,
      dueDate: input.dueDate ?? todayIST(),
      reason: input.reason,
      sourceInvoiceId: input.type === 'late_fee' ? input.invoiceId : undefined,
      createdBy: actorId,
    })
    if (!adjustment) throw Errors.CONFLICT('A late fee has already been levied on this invoice')
    return adjustment
  })
}

/**
 * Reverse an adjustment by writing its opposite (same type, negated amount,
 * `reversesId` set). A relief reversal puts the balance back on the invoice;
 * a charge reversal cancels the charge invoice — allowed only while nothing
 * has been paid or relieved on it (§5.8). Reverse the payment first.
 */
export async function reverseAdjustment(tenantId: string, actorId: string, adjustmentId: string, reason: string) {
  if (!reason?.trim()) throw Errors.VALIDATION('A reversal needs a reason')
  return db.transaction(async (tx) => {
    const [original] = await tx.select().from(feeAdjustments)
      .where(and(eq(feeAdjustments.id, adjustmentId), eq(feeAdjustments.tenantId, tenantId)))
      .for('update')
    if (!original) throw Errors.NOT_FOUND('Adjustment')
    if (original.reversesId) throw Errors.CONFLICT('A reversal cannot itself be reversed')
    const [already] = await tx.select({ id: feeAdjustments.id }).from(feeAdjustments).where(eq(feeAdjustments.reversesId, original.id)).limit(1)
    if (already) throw Errors.CONFLICT('Adjustment is already reversed')

    const inv = original.invoiceId ? (await lockInvoices(tx, [original.invoiceId])).get(original.invoiceId) : undefined
    if (!inv) throw Errors.CONFLICT('Adjustment has no invoice to reverse against')

    if (original.amount < 0) {
      await moveInvoiceBalance(tx, inv, { waived: original.amount })
    } else {
      if (inv.paidAmount > 0 || inv.waivedAmount > 0) {
        throw Errors.CONFLICT('Money has already been applied to this charge — reverse that payment or waive the charge instead')
      }
      await tx.update(feeInvoices).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(feeInvoices.id, inv.id))
    }

    const [reversal] = await tx.insert(feeAdjustments).values({
      tenantId,
      studentId: original.studentId,
      type: original.type,
      amount: -original.amount,
      invoiceId: original.invoiceId,
      sourceInvoiceId: original.sourceInvoiceId,
      paymentId: original.paymentId,
      reversesId: original.id,
      reason,
      createdBy: actorId,
    }).returning()

    await audit(tx, { actorId, tenantId, action: 'fee.adjustment.reversed', targetId: original.id, metadata: { reason, reversalId: reversal.id, amount: original.amount } })
    return reversal
  })
}

// ── Reads over the ledger ─────────────────────────────────────────────────────

export async function listStudentAdjustments(tenantId: string, studentId: string) {
  return db.select().from(feeAdjustments)
    .where(and(eq(feeAdjustments.tenantId, tenantId), eq(feeAdjustments.studentId, studentId)))
    .orderBy(asc(feeAdjustments.createdAt))
}

export async function listStudentPayments(tenantId: string, studentId: string, opts: { includeReversed: boolean }) {
  const conditions = [eq(feePayments.tenantId, tenantId), eq(feePayments.studentId, studentId)]
  if (!opts.includeReversed) conditions.push(eq(feePayments.status, 'recorded'))
  const payments = await db.select().from(feePayments).where(and(...conditions)).orderBy(asc(feePayments.receivedAt))
  const allocations = payments.length
    ? await db.select().from(feePaymentAllocations).where(inArray(feePaymentAllocations.paymentId, payments.map((p) => p.id)))
    : []
  return payments.map((p) => ({ ...p, allocations: allocations.filter((a) => a.paymentId === p.id) }))
}

