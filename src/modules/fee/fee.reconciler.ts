// ─────────────────────────────────────────────────────────────────────────────
// Fee balance reconciler (LLD §10 "Balance drift").
//
// `paidAmount`, `waivedAmount` and `status` on fee_invoices are materialised so
// the defaulter list is not an aggregate over the whole ledger on every page
// load. The price of materialising is that the copy can drift from the truth
// — a bug, a hand-run SQL fix, a transaction that half-happened in some future
// code path. This sweep recomputes the copy from the ledger rows and repairs it.
//
// Same contract as evaluation.reconciler.ts: on a healthy system it finds
// nothing and prints nothing, so any line at all is worth reading.
//
//   repaired   — a materialised balance disagreed with the ledger and was fixed.
//   violation  — an invariant the reconciler cannot fix by itself (§5.1, §5.5,
//                §5.6). Logged loudly for a human; never "repaired", because the
//                right fix depends on which of the two rows is wrong.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq, gte, inArray, ne, or, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import {
  feeAdjustments,
  feeInvoiceItems,
  feeInvoices,
  feePaymentAllocations,
  feePayments,
} from './fee.schema.js'
import { RELIEF_ADJUSTMENT_TYPES, deriveInvoiceStatus } from './fee.types.js'

const CHUNK = 500

export interface FeeReconcileResult {
  checked: number
  repaired: number
  violations: number
}

async function touchedInvoiceIds(since: Date): Promise<string[]> {
  const [direct, viaPayments, viaAdjustments] = await Promise.all([
    db.select({ id: feeInvoices.id }).from(feeInvoices).where(gte(feeInvoices.updatedAt, since)),
    db.selectDistinct({ id: feePaymentAllocations.invoiceId }).from(feePaymentAllocations)
      .innerJoin(feePayments, eq(feePaymentAllocations.paymentId, feePayments.id))
      .where(or(gte(feePayments.updatedAt, since), gte(feePaymentAllocations.createdAt, since))),
    db.selectDistinct({ id: feeAdjustments.invoiceId }).from(feeAdjustments)
      .where(and(gte(feeAdjustments.createdAt, since), sql`${feeAdjustments.invoiceId} IS NOT NULL`)),
  ])
  return [...new Set([...direct, ...viaPayments, ...viaAdjustments].map((r) => r.id!).filter(Boolean))]
}

/** What the ledger says, per invoice. Grouped queries with joins — never a correlated `sql` subquery. */
async function ledgerTruth(invoiceIds: string[]) {
  const [paid, waived, items] = await Promise.all([
    db.select({ invoiceId: feePaymentAllocations.invoiceId, sum: sql<string>`sum(${feePaymentAllocations.amount})` })
      .from(feePaymentAllocations)
      .innerJoin(feePayments, eq(feePaymentAllocations.paymentId, feePayments.id))
      .where(and(
        inArray(feePaymentAllocations.invoiceId, invoiceIds),
        eq(feePayments.status, 'recorded'),
        ne(feePayments.clearanceStatus, 'bounced'),
      ))
      .groupBy(feePaymentAllocations.invoiceId),
    db.select({ invoiceId: feeAdjustments.invoiceId, sum: sql<string>`sum(${feeAdjustments.amount})` })
      .from(feeAdjustments)
      .where(and(inArray(feeAdjustments.invoiceId, invoiceIds), inArray(feeAdjustments.type, [...RELIEF_ADJUSTMENT_TYPES])))
      .groupBy(feeAdjustments.invoiceId),
    db.select({ invoiceId: feeInvoiceItems.invoiceId, sum: sql<string>`sum(${feeInvoiceItems.totalAmount})` })
      .from(feeInvoiceItems)
      .where(inArray(feeInvoiceItems.invoiceId, invoiceIds))
      .groupBy(feeInvoiceItems.invoiceId),
  ])
  return {
    paid: new Map(paid.map((r) => [r.invoiceId, Number(r.sum)])),
    // Relief rows are stored negative; reversals of relief are positive.
    waived: new Map(waived.map((r) => [r.invoiceId!, -Number(r.sum)])),
    itemTotal: new Map(items.map((r) => [r.invoiceId, Number(r.sum)])),
  }
}

/**
 * Re-check one invoice under its row lock and repair it if it still
 * disagrees. Re-reading inside the lock matters: the first pass read without
 * one, so a payment may have landed in between and fixed nothing was wrong.
 */
async function repairInvoice(invoiceId: string): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(feeInvoices).where(eq(feeInvoices.id, invoiceId)).for('update')
    if (!inv) return null
    const [[paidRow], [waivedRow]] = await Promise.all([
      tx.select({ sum: sql<string>`coalesce(sum(${feePaymentAllocations.amount}), 0)` })
        .from(feePaymentAllocations)
        .innerJoin(feePayments, eq(feePaymentAllocations.paymentId, feePayments.id))
        .where(and(eq(feePaymentAllocations.invoiceId, invoiceId), eq(feePayments.status, 'recorded'), ne(feePayments.clearanceStatus, 'bounced'))),
      tx.select({ sum: sql<string>`coalesce(sum(${feeAdjustments.amount}), 0)` })
        .from(feeAdjustments)
        .where(and(eq(feeAdjustments.invoiceId, invoiceId), inArray(feeAdjustments.type, [...RELIEF_ADJUSTMENT_TYPES]))),
    ])
    const paidAmount = Number(paidRow.sum)
    const waivedAmount = -Number(waivedRow.sum)
    const status = deriveInvoiceStatus({ ...inv, paidAmount, waivedAmount })
    if (paidAmount === inv.paidAmount && waivedAmount === inv.waivedAmount && status === inv.status) return null

    await tx.update(feeInvoices).set({ paidAmount, waivedAmount, status, updatedAt: new Date() }).where(eq(feeInvoices.id, invoiceId))
    return {
      before: { paidAmount: inv.paidAmount, waivedAmount: inv.waivedAmount, status: inv.status },
      after: { paidAmount, waivedAmount, status },
    }
  })
}

async function crossPartyAllocations(invoiceIds: string[]) {
  // §5.5 — an allocation's payment and invoice must share tenant AND student.
  return db.select({ allocationId: feePaymentAllocations.id, paymentId: feePayments.id, invoiceId: feeInvoices.id })
    .from(feePaymentAllocations)
    .innerJoin(feePayments, eq(feePaymentAllocations.paymentId, feePayments.id))
    .innerJoin(feeInvoices, eq(feePaymentAllocations.invoiceId, feeInvoices.id))
    .where(and(
      inArray(feePaymentAllocations.invoiceId, invoiceIds),
      or(ne(feePayments.tenantId, feeInvoices.tenantId), ne(feePayments.studentId, feeInvoices.studentId)),
    ))
}

async function overAllocatedPayments(invoiceIds: string[]) {
  // §5.1 — sum(allocations) <= payment.amount, for payments touching these invoices.
  const paymentIds = (await db.selectDistinct({ id: feePaymentAllocations.paymentId }).from(feePaymentAllocations)
    .where(inArray(feePaymentAllocations.invoiceId, invoiceIds))).map((r) => r.id)
  if (paymentIds.length === 0) return []
  const rows = await db.select({
    paymentId: feePayments.id,
    amount: feePayments.amount,
    allocated: sql<string>`sum(${feePaymentAllocations.amount})`,
  }).from(feePayments)
    .innerJoin(feePaymentAllocations, eq(feePaymentAllocations.paymentId, feePayments.id))
    .where(inArray(feePayments.id, paymentIds))
    .groupBy(feePayments.id, feePayments.amount)
  return rows.filter((r) => Number(r.allocated) > r.amount)
}

/**
 * @param opts.full  Sweep every invoice instead of the last `sinceHours`. For
 *                   an operator after a manual data fix, and for tests.
 */
export async function runFeeReconciler(opts: { sinceHours?: number; full?: boolean; now?: Date } = {}): Promise<FeeReconcileResult> {
  const now = opts.now ?? new Date()
  const ids = opts.full
    ? (await db.select({ id: feeInvoices.id }).from(feeInvoices)).map((r) => r.id)
    : await touchedInvoiceIds(new Date(now.getTime() - (opts.sinceHours ?? 24) * 3_600_000))

  let repaired = 0
  let violations = 0

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const [invoices, truth] = await Promise.all([
      db.select().from(feeInvoices).where(inArray(feeInvoices.id, chunk)),
      ledgerTruth(chunk),
    ])

    for (const inv of invoices) {
      const paid = truth.paid.get(inv.id) ?? 0
      const waived = truth.waived.get(inv.id) ?? 0
      const status = deriveInvoiceStatus({ ...inv, paidAmount: paid, waivedAmount: waived })
      if (paid !== inv.paidAmount || waived !== inv.waivedAmount || status !== inv.status) {
        const fix = await repairInvoice(inv.id)
        if (fix) {
          repaired += 1
          console.warn(`[fee-reconciler] repaired invoice=${inv.id} tenant=${inv.tenantId} before=${JSON.stringify(fix.before)} after=${JSON.stringify(fix.after)}`)
        }
      }

      const itemTotal = truth.itemTotal.get(inv.id)
      if (itemTotal !== undefined && itemTotal !== inv.totalAmount) {
        violations += 1
        console.error(`[fee-reconciler] VIOLATION §5.6 invoice=${inv.id} totalAmount=${inv.totalAmount} sum(items)=${itemTotal}`)
      }
    }

    for (const row of await crossPartyAllocations(chunk)) {
      violations += 1
      console.error(`[fee-reconciler] VIOLATION §5.5 allocation=${row.allocationId} payment=${row.paymentId} invoice=${row.invoiceId} — tenant/student mismatch`)
    }
    for (const row of await overAllocatedPayments(chunk)) {
      violations += 1
      console.error(`[fee-reconciler] VIOLATION §5.1 payment=${row.paymentId} amount=${row.amount} allocated=${row.allocated}`)
    }
  }

  return { checked: ids.length, repaired, violations }
}
