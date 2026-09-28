import { and, asc, desc, eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { db, type DB } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { classes } from '../class/class.schema.js'
import {
  feeHeads,
  feeInvoices,
  feeInvoiceItems,
  feePayments,
  studentFeeAssignments,
  studentGuardians,
  tenantFeeSettings,
} from './fee.schema.js'
import { formatINR, splitGst, type FeeSequenceSeries, type Paise, type Tx } from './fee.types.js'

// ── Gap-free numbering (§10) ──────────────────────────────────────────────────

/**
 * Issue the next number in a tenant's (series, financial year) sequence.
 *
 * MUST be called inside the transaction that writes the numbered row. The
 * upsert takes the sequence row's lock and holds it until commit, which
 * serialises numbering per tenant exactly like the `SELECT … FOR UPDATE` in
 * §7c — and if the transaction rolls back, the increment rolls back with it.
 * That is the whole gap-free guarantee: there is no moment at which a number
 * is spent but its row does not exist.
 *
 * One statement rather than select-then-update so the very first number of a
 * year, when no row exists yet, is as safe as the thousandth: two concurrent
 * inserts on a missing row resolve through the unique index, not a race.
 */
export async function allocateNumber(
  tx: Tx,
  tenantId: string,
  series: FeeSequenceSeries,
  financialYear: string,
  prefix: string,
): Promise<string> {
  const result = await tx.execute<{ prefix: string; last_number: number }>(sql`
    INSERT INTO fee_receipt_sequences (tenant_id, series, financial_year, prefix, last_number)
    VALUES (${tenantId}, ${series}, ${financialYear}, ${prefix}, 1)
    ON CONFLICT (tenant_id, series, financial_year)
    DO UPDATE SET last_number = fee_receipt_sequences.last_number + 1
    RETURNING prefix, last_number
  `)
  const row = result.rows[0]
  const tag = series === 'INVOICE' ? '/INV' : ''
  return `${row.prefix}${tag}/${financialYear}/${String(row.last_number).padStart(5, '0')}`
}

// ── Receipt snapshot ──────────────────────────────────────────────────────────

export interface ReceiptSnapshot {
  version: 1
  coaching: { name: string; gstin: string | null }
  student: { id: string; name: string; email: string | null; phone: string | null }
  classes: string[]
  guardian: { name: string; relation: string; phone: string | null } | null
  receiptNo: string
  financialYear: string
  issuedAt: string
  payment: {
    amount: Paise
    mode: string
    reference: string | null
    instrumentDate: string | null
    bankName: string | null
    receivedAt: string
  }
  allocations: { invoiceId: string; label: string; dueDate: string; amount: Paise }[]
  creditAmount: Paise
  recordedBy: { id: string; name: string }
}

/**
 * Freeze everything the receipt will ever print — read inside the payment
 * transaction, so the document matches the ledger it was written with.
 */
export async function buildReceiptSnapshot(tx: Tx, input: {
  tenantId: string
  studentId: string
  recordedBy: string
  receiptNo: string
  financialYear: string
  payment: ReceiptSnapshot['payment']
  allocations: ReceiptSnapshot['allocations']
}): Promise<ReceiptSnapshot> {
  const [[tenant], [settings], [student], [recorder], classRows, [guardian]] = await Promise.all([
    tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1),
    tx.select({ gstMode: tenantFeeSettings.gstMode, gstin: tenantFeeSettings.gstin })
      .from(tenantFeeSettings).where(eq(tenantFeeSettings.tenantId, input.tenantId)).limit(1),
    tx.select({ id: users.id, name: users.name, email: users.email, phone: users.phoneNumber })
      .from(users).where(eq(users.id, input.studentId)).limit(1),
    tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.recordedBy)).limit(1),
    tx.selectDistinct({ name: classes.name }).from(studentFeeAssignments)
      .innerJoin(classes, eq(studentFeeAssignments.classId, classes.id))
      .where(and(
        eq(studentFeeAssignments.tenantId, input.tenantId),
        eq(studentFeeAssignments.studentId, input.studentId),
        eq(studentFeeAssignments.status, 'active'),
      )),
    tx.select({ name: studentGuardians.name, relation: studentGuardians.relation, phone: studentGuardians.phone })
      .from(studentGuardians)
      .where(and(
        eq(studentGuardians.tenantId, input.tenantId),
        eq(studentGuardians.studentId, input.studentId),
        eq(studentGuardians.isPrimary, true),
      )).limit(1),
  ])

  const allocated = input.allocations.reduce((s, a) => s + a.amount, 0)
  return {
    version: 1,
    coaching: {
      name: tenant?.name ?? '',
      gstin: settings?.gstMode === 'registered' ? settings.gstin : null,
    },
    student: {
      id: input.studentId,
      name: student?.name ?? '',
      email: student?.email ?? null,
      phone: student?.phone ?? null,
    },
    classes: classRows.map((c) => c.name).sort(),
    guardian: guardian ?? null,
    receiptNo: input.receiptNo,
    financialYear: input.financialYear,
    issuedAt: new Date().toISOString(),
    payment: input.payment,
    allocations: input.allocations,
    creditAmount: input.payment.amount - allocated,
    recordedBy: { id: input.recordedBy, name: recorder?.name ?? '' },
  }
}

// ── Receipt rendering ─────────────────────────────────────────────────────────

type PaymentRow = typeof feePayments.$inferSelect

/**
 * The stamp is the ONE thing on a receipt that is read live rather than from
 * the snapshot: the document says what was issued; the stamp says what has
 * happened to it since. A reversed receipt keeps its number (§5.3) and prints
 * marked REVERSED.
 */
export function receiptStamp(p: Pick<PaymentRow, 'status' | 'clearanceStatus'>): string | null {
  if (p.status === 'reversed') return 'REVERSED'
  if (p.clearanceStatus === 'bounced') return 'BOUNCED'
  if (p.clearanceStatus === 'pending') return 'PENDING CLEARANCE'
  return null
}

export function renderReceipt(payment: PaymentRow) {
  return {
    paymentId: payment.id,
    stamp: receiptStamp(payment),
    status: payment.status,
    clearanceStatus: payment.clearanceStatus,
    document: payment.documentSnapshot as ReceiptSnapshot,
  }
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer', cheque: 'Cheque', dd: 'Demand draft', card: 'Card', other: 'Other',
}

/** A printable A5-ish receipt. Self-contained — no external assets. */
export function renderReceiptHtml(payment: PaymentRow): string {
  const { stamp, document: d } = renderReceipt(payment)
  const receivedOn = new Date(d.payment.receivedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
  const rows = d.allocations.map((a) => `
      <tr><td>${esc(a.label)}</td><td>${esc(a.dueDate)}</td><td class="r">${esc(formatINR(a.amount))}</td></tr>`).join('')
  const instrument = [d.payment.reference && `Ref ${d.payment.reference}`, d.payment.bankName, d.payment.instrumentDate]
    .filter(Boolean).map(esc).join(' · ')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Receipt ${esc(d.receiptNo)}</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;color:#111;max-width:640px;margin:24px auto;padding:0 16px;position:relative}
  h1{font-size:20px;margin:0}.muted{color:#555;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}
  th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left}.r{text-align:right}
  .stamp{position:absolute;top:80px;right:16px;border:3px solid #b91c1c;color:#b91c1c;font-weight:800;
    font-size:22px;padding:4px 12px;transform:rotate(-12deg);letter-spacing:2px}
  .foot{margin-top:40px;display:flex;justify-content:space-between;font-size:13px}
</style></head><body>
  ${stamp ? `<div class="stamp">${esc(stamp)}</div>` : ''}
  <h1>${esc(d.coaching.name)}</h1>
  ${d.coaching.gstin ? `<div class="muted">GSTIN ${esc(d.coaching.gstin)}</div>` : ''}
  <p><strong>Fee receipt ${esc(d.receiptNo)}</strong><br><span class="muted">Received on ${esc(receivedOn)}</span></p>
  <p>Received from <strong>${esc(d.student.name)}</strong>${d.classes.length ? ` (${d.classes.map(esc).join(', ')})` : ''}
  ${d.guardian ? `<br><span class="muted">${esc(d.guardian.relation)}: ${esc(d.guardian.name)}</span>` : ''}</p>
  <p>Amount <strong>${esc(formatINR(d.payment.amount))}</strong> by ${esc(MODE_LABEL[d.payment.mode] ?? d.payment.mode)}
  ${instrument ? `<br><span class="muted">${instrument}</span>` : ''}</p>
  <table><thead><tr><th>Towards</th><th>Due</th><th class="r">Amount</th></tr></thead><tbody>${rows}
    ${d.creditAmount > 0 ? `<tr><td>Held as advance / credit</td><td></td><td class="r">${esc(formatINR(d.creditAmount))}</td></tr>` : ''}
  </tbody></table>
  <div class="foot"><span class="muted">Recorded by ${esc(d.recordedBy.name)}</span><span>Authorised signatory</span></div>
</body></html>`
}

// ── GST tax invoice (Phase 5) ─────────────────────────────────────────────────

export interface PartySnapshot {
  coaching: { name: string; gstin: string | null; placeOfSupplyCode: string | null }
  student: { name: string; email: string | null; phone: string | null }
}

/** Frozen on an invoice at issue when the tenant is GST-registered. */
export async function buildPartySnapshot(tx: Tx | DB, tenantId: string, studentId: string): Promise<PartySnapshot> {
  const [[tenant], [settings], [student]] = await Promise.all([
    tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    tx.select({ gstin: tenantFeeSettings.gstin, placeOfSupplyCode: tenantFeeSettings.placeOfSupplyCode })
      .from(tenantFeeSettings).where(eq(tenantFeeSettings.tenantId, tenantId)).limit(1),
    tx.select({ name: users.name, email: users.email, phone: users.phoneNumber }).from(users).where(eq(users.id, studentId)).limit(1),
  ])
  return {
    coaching: {
      name: tenant?.name ?? '',
      gstin: settings?.gstin ?? null,
      placeOfSupplyCode: settings?.placeOfSupplyCode ?? null,
    },
    student: { name: student?.name ?? '', email: student?.email ?? null, phone: student?.phone ?? null },
  }
}

/**
 * The tax-invoice document for one invoice. Refused for an invoice that was
 * not issued under `gstMode = 'registered'` — without an invoice number it is
 * a fee demand, not a tax invoice, and printing one would be worse than
 * printing nothing.
 *
 * Place of supply: intra-state (CGST + SGST) when the configured place of
 * supply matches the state code the GSTIN starts with — the normal case for a
 * coaching teaching local students — otherwise IGST.
 */
export async function renderTaxInvoice(tenantId: string, invoiceId: string, studentId?: string) {
  const conditions = [eq(feeInvoices.id, invoiceId), eq(feeInvoices.tenantId, tenantId)]
  if (studentId) conditions.push(eq(feeInvoices.studentId, studentId))
  const [invoice] = await db.select().from(feeInvoices).where(and(...conditions)).limit(1)
  if (!invoice) throw Errors.NOT_FOUND('Invoice')
  if (!invoice.invoiceNo) throw Errors.CONFLICT('This invoice was not issued as a GST tax invoice')

  const items = await db.select({
    item: feeInvoiceItems,
    headName: feeHeads.name,
    sacCode: feeHeads.sacCode,
  }).from(feeInvoiceItems)
    .innerJoin(feeHeads, eq(feeInvoiceItems.headId, feeHeads.id))
    .where(eq(feeInvoiceItems.invoiceId, invoiceId))
    .orderBy(asc(feeHeads.name))

  const parties = (invoice.partySnapshot as PartySnapshot | null) ?? await buildPartySnapshot(db, tenantId, invoice.studentId)
  const gstinState = parties.coaching.gstin?.slice(0, 2) ?? null
  const intraState = !parties.coaching.placeOfSupplyCode || parties.coaching.placeOfSupplyCode === gstinState

  const lines = items.map(({ item, headName, sacCode }) => ({
    description: headName,
    sacCode,
    grossAmount: item.grossAmount,
    concessionAmount: item.concessionAmount,
    taxableAmount: item.taxableAmount,
    taxRatePct: item.taxRatePct != null ? Number(item.taxRatePct) : 0,
    ...splitGst(item.taxAmount, intraState),
    taxAmount: item.taxAmount,
    totalAmount: item.totalAmount,
  }))

  const sum = (k: 'taxableAmount' | 'cgst' | 'sgst' | 'igst' | 'taxAmount' | 'totalAmount') => lines.reduce((s, l) => s + l[k], 0)

  return {
    invoiceNo: invoice.invoiceNo,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    label: invoice.label,
    supplier: parties.coaching,
    recipient: parties.student,
    placeOfSupplyCode: parties.coaching.placeOfSupplyCode ?? gstinState,
    supplyType: intraState ? 'intra_state' : 'inter_state',
    lines,
    totals: {
      taxableAmount: sum('taxableAmount'),
      cgst: sum('cgst'),
      sgst: sum('sgst'),
      igst: sum('igst'),
      taxAmount: sum('taxAmount'),
      totalAmount: sum('totalAmount'),
    },
    status: invoice.status,
  }
}

/** GET /fees/receipts — the caller's own live receipts, newest first. */
export async function listStudentReceipts(tenantId: string, studentId: string, opts: { cursor?: string; limit: number }) {
  const conditions = [eq(feePayments.tenantId, tenantId), eq(feePayments.studentId, studentId), eq(feePayments.status, 'recorded')]
  if (opts.cursor) {
    const [ts, id] = opts.cursor.split('_')
    const at = new Date(ts)
    if (!isNaN(at.getTime()) && id) conditions.push(sql`(${feePayments.createdAt}, ${feePayments.id}) < (${at.toISOString()}, ${id})` as any)
  }
  const rows = await db.select().from(feePayments).where(and(...conditions))
    .orderBy(desc(feePayments.createdAt), desc(feePayments.id))
    .limit(opts.limit + 1)
  const hasMore = rows.length > opts.limit
  const items = hasMore ? rows.slice(0, opts.limit) : rows
  const last = items.at(-1)
  return {
    items: items.map((p) => ({
      paymentId: p.id,
      receiptNo: p.receiptNo,
      amount: p.amount,
      mode: p.mode,
      receivedAt: p.receivedAt,
      clearanceStatus: p.clearanceStatus,
      stamp: receiptStamp(p),
    })),
    nextCursor: hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
  }
}

/** Load a payment's receipt, scoped to the tenant and optionally to one student. */
export async function getReceipt(tenantId: string, paymentId: string, studentId?: string) {
  const conditions = [eq(feePayments.id, paymentId), eq(feePayments.tenantId, tenantId)]
  // A student never sees reversed rows (§7g) — only the net effect.
  if (studentId) conditions.push(eq(feePayments.studentId, studentId), eq(feePayments.status, 'recorded'))
  const [payment] = await db.select().from(feePayments).where(and(...conditions)).limit(1)
  if (!payment) throw Errors.NOT_FOUND('Receipt')
  return payment
}

