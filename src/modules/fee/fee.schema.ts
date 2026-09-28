import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  numeric,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { classes } from '../class/class.schema.js'

// ── Supporting ────────────────────────────────────────────────────────────────

export const tenantFeeSettings = pgTable('tenant_fee_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  // 'none' | 'registered' — §1's per-tenant tax-compliance decision.
  gstMode: varchar('gst_mode', { length: 20 }).notNull().default('none'),
  gstin: varchar('gstin', { length: 15 }),
  placeOfSupplyCode: varchar('place_of_supply_code', { length: 2 }),
  receiptPrefix: varchar('receipt_prefix', { length: 12 }).notNull(),
  financialYearStartMonth: integer('financial_year_start_month').notNull().default(4),
  lateFeePolicy: jsonb('late_fee_policy').notNull(),
  reminderPolicy: jsonb('reminder_policy').notNull(),
  // Levied as a `bounce_charge` adjustment when a cheque bounces. 0 = off.
  bounceChargeAmount: bigint('bounce_charge_amount', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Layer 1 · Catalogue ───────────────────────────────────────────────────────

export const feeHeads = pgTable('fee_heads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: varchar('name', { length: 120 }).notNull(),
  code: varchar('code', { length: 32 }).notNull(),
  category: varchar('category', { length: 20 }).notNull(),
  isRefundable: boolean('is_refundable').notNull().default(false),
  taxRatePct: numeric('tax_rate_pct', { precision: 5, scale: 2 }),
  sacCode: varchar('sac_code', { length: 10 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('fee_heads_tenant_id_idx').on(t.tenantId),
  uniqueIndex('fee_heads_tenant_code_uniq').on(t.tenantId, t.code),
])

export const feeStructures = pgTable('fee_structures', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: varchar('name', { length: 160 }).notNull(),
  academicYear: varchar('academic_year', { length: 9 }).notNull(),
  version: integer('version').notNull().default(1),
  // Points at the revision that replaced this one — set on the OLD row the
  // moment `reviseStructure` creates the new draft. See fee.service.ts.
  supersededById: uuid('superseded_by_id').references((): AnyPgColumn => feeStructures.id),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('fee_structures_tenant_id_idx').on(t.tenantId)])

export const feeStructureItems = pgTable('fee_structure_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  structureId: uuid('structure_id').notNull().references(() => feeStructures.id),
  headId: uuid('head_id').notNull().references(() => feeHeads.id),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  order: integer('order').notNull().default(0),
}, (t) => [index('fee_structure_items_structure_id_idx').on(t.structureId)])

// Absolute due dates rather than day offsets — academic calendars are absolute.
export const feeStructureInstallments = pgTable('fee_structure_installments', {
  id: uuid('id').primaryKey().defaultRandom(),
  structureId: uuid('structure_id').notNull().references(() => feeStructures.id),
  seq: integer('seq').notNull(),
  label: varchar('label', { length: 80 }).notNull(),
  dueDate: date('due_date').notNull(),
  sharePct: numeric('share_pct', { precision: 5, scale: 2 }).notNull(),
}, (t) => [
  index('fee_structure_installments_structure_id_idx').on(t.structureId),
  uniqueIndex('fee_structure_installments_structure_seq_uniq').on(t.structureId, t.seq),
])

// ── Layer 2 · Obligation ──────────────────────────────────────────────────────

export const studentFeeAssignments = pgTable('student_fee_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  // Recorded for reporting, not authority — the structure/installments are.
  classId: uuid('class_id').notNull().references(() => classes.id),
  structureId: uuid('structure_id').notNull().references(() => feeStructures.id),
  academicYear: varchar('academic_year', { length: 9 }).notNull(),
  // Snapshotted downward at assignment time — never re-read from the structure.
  grossAmount: bigint('gross_amount', { mode: 'number' }).notNull(),
  concessionAmount: bigint('concession_amount', { mode: 'number' }).notNull().default(0),
  netAmount: bigint('net_amount', { mode: 'number' }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  effectiveFrom: date('effective_from').notNull(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('student_fee_assignments_tenant_id_idx').on(t.tenantId),
  index('student_fee_assignments_student_id_idx').on(t.studentId),
  uniqueIndex('student_fee_assignments_student_structure_year_uniq')
    .on(t.studentId, t.structureId, t.academicYear),
])

// Append-only — revoking writes a reversing row (negated computedAmount),
// never a delete or an update. See fee.service.ts#reverseConcession.
export const feeConcessions = pgTable('fee_concessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  assignmentId: uuid('assignment_id').notNull().references(() => studentFeeAssignments.id),
  // Informational only in Phase 1 — a concession always reduces the assignment
  // proportionally across every invoice/head. Head-scoped redistribution is a
  // later-phase refinement (see the comment on recalcAssignmentConcessions).
  headId: uuid('head_id').references(() => feeHeads.id),
  type: varchar('type', { length: 20 }).notNull(),
  mode: varchar('mode', { length: 10 }).notNull(),
  value: numeric('value', { precision: 10, scale: 2 }).notNull(),
  computedAmount: bigint('computed_amount', { mode: 'number' }).notNull(),
  reason: text('reason'),
  approvedBy: uuid('approved_by').notNull().references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('fee_concessions_assignment_id_idx').on(t.assignmentId)])

export const feeInvoices = pgTable('fee_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  // 'installment' (from a structure) | 'charge' (raised by a positive
  // adjustment — late fee, bounce charge, opening balance). A charge has no
  // assignment and no installment seq, and concessions never touch it.
  kind: varchar('kind', { length: 20 }).notNull().default('installment'),
  assignmentId: uuid('assignment_id').references(() => studentFeeAssignments.id),
  // Denormalised — every dues query filters on it.
  studentId: uuid('student_id').notNull().references(() => users.id),
  installmentSeq: integer('installment_seq'),
  label: varchar('label', { length: 80 }).notNull(),
  // Only set when gstMode = 'registered'; otherwise the receipt is the
  // document. Drawn from fee_receipt_sequences, series INVOICE.
  invoiceNo: varchar('invoice_no', { length: 40 }),
  issueDate: date('issue_date').notNull(),
  dueDate: date('due_date').notNull(),
  grossAmount: bigint('gross_amount', { mode: 'number' }).notNull(),
  concessionAmount: bigint('concession_amount', { mode: 'number' }).notNull().default(0),
  taxableAmount: bigint('taxable_amount', { mode: 'number' }).notNull(),
  taxAmount: bigint('tax_amount', { mode: 'number' }).notNull().default(0),
  totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
  // Both materialised, written only by fee.ledger.ts and repaired by
  // fee.reconciler.ts. paid = live allocations; waived = relief adjustments.
  paidAmount: bigint('paid_amount', { mode: 'number' }).notNull().default(0),
  waivedAmount: bigint('waived_amount', { mode: 'number' }).notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('issued'),
  // Parties as they stood at issue (tenant name/GSTIN, student name), for the
  // GST tax-invoice document — same reasoning as fee_payments.documentSnapshot.
  partySnapshot: jsonb('party_snapshot'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // The reconciler's "touched recently" window keys off this.
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('fee_invoices_tenant_status_due_idx').on(t.tenantId, t.status, t.dueDate),
  index('fee_invoices_student_id_idx').on(t.studentId),
  index('fee_invoices_assignment_id_idx').on(t.assignmentId),
  index('fee_invoices_updated_at_idx').on(t.updatedAt),
])

export const feeInvoiceItems = pgTable('fee_invoice_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => feeInvoices.id),
  headId: uuid('head_id').notNull().references(() => feeHeads.id),
  grossAmount: bigint('gross_amount', { mode: 'number' }).notNull(),
  concessionAmount: bigint('concession_amount', { mode: 'number' }).notNull().default(0),
  taxableAmount: bigint('taxable_amount', { mode: 'number' }).notNull(),
  taxRatePct: numeric('tax_rate_pct', { precision: 5, scale: 2 }),
  taxAmount: bigint('tax_amount', { mode: 'number' }).notNull().default(0),
  totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
}, (t) => [index('fee_invoice_items_invoice_id_idx').on(t.invoiceId)])

// ── Layer 3 · Ledger ──────────────────────────────────────────────────────────
// Every write to these tables goes through fee.ledger.ts (§2). No row here is
// ever UPDATEd for an amount (§5.4) — corrections are new rows.

export const feePayments = pgTable('fee_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  // Gap-free per (tenant, series, financialYear) — see fee.receipt.ts.
  receiptNo: varchar('receipt_no', { length: 40 }).notNull(),
  financialYear: varchar('financial_year', { length: 9 }).notNull(),
  // Total received; may exceed allocations — the remainder is credit.
  amount: bigint('amount', { mode: 'number' }).notNull(),
  mode: varchar('mode', { length: 20 }).notNull(),
  reference: varchar('reference', { length: 120 }),
  instrumentDate: date('instrument_date'),
  bankName: varchar('bank_name', { length: 120 }),
  // When money changed hands — not createdAt.
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  clearanceStatus: varchar('clearance_status', { length: 20 }).notNull(),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  bounceReason: text('bounce_reason'),
  status: varchar('status', { length: 20 }).notNull().default('recorded'),
  reversedBy: uuid('reversed_by').references(() => users.id),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversalReason: text('reversal_reason'),
  // Becomes nullable when the gateway lands (§12) — a machine recorded it.
  recordedBy: uuid('recorded_by').notNull().references(() => users.id),
  idempotencyKey: varchar('idempotency_key', { length: 64 }),
  // Everything the receipt prints, frozen at issue. Never re-rendered from
  // live tables — see LLD §4 "Why documentSnapshot exists".
  documentSnapshot: jsonb('document_snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('fee_payments_tenant_receipt_uniq').on(t.tenantId, t.receiptNo),
  uniqueIndex('fee_payments_tenant_idempotency_uniq').on(t.tenantId, t.idempotencyKey),
  index('fee_payments_tenant_received_idx').on(t.tenantId, t.receivedAt),
  index('fee_payments_student_id_idx').on(t.studentId),
])

// A payment is never attached to an invoice by FK — this table is what makes
// partial, advance and one-cheque-two-installments payments correct. Rows are
// KEPT when a payment bounces or is reversed: they are the audit trail.
export const feePaymentAllocations = pgTable('fee_payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  paymentId: uuid('payment_id').notNull().references(() => feePayments.id),
  invoiceId: uuid('invoice_id').notNull().references(() => feeInvoices.id),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('fee_payment_allocations_payment_invoice_uniq').on(t.paymentId, t.invoiceId),
  index('fee_payment_allocations_invoice_id_idx').on(t.invoiceId),
])

// Signed. Positive (late_fee, bounce_charge, opening_balance) raise a `charge`
// invoice; negative (waiver, write_off, credit_note) add to one invoice's
// waivedAmount. Append-only — reversing writes an opposing row of the same
// type with `reversesId` set.
export const feeAdjustments = pgTable('fee_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  type: varchar('type', { length: 20 }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  // The charge invoice this raised, or the invoice this relieves.
  invoiceId: uuid('invoice_id').references(() => feeInvoices.id),
  // late_fee only — the overdue invoice the fee was levied on.
  sourceInvoiceId: uuid('source_invoice_id').references(() => feeInvoices.id),
  // bounce_charge only — the bounced payment.
  paymentId: uuid('payment_id').references(() => feePayments.id),
  reversesId: uuid('reverses_id').references((): AnyPgColumn => feeAdjustments.id),
  reason: text('reason'),
  // Null when the lifecycle tick levied it (late fees) — no human did.
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('fee_adjustments_student_idx').on(t.tenantId, t.studentId),
  index('fee_adjustments_invoice_id_idx').on(t.invoiceId),
  // A tick that runs twice cannot charge twice (§7f). A reversed late fee keeps
  // its original row, so it is not re-levied the next morning either.
  uniqueIndex('fee_adjustments_late_fee_once_uniq').on(t.sourceInvoiceId)
    .where(sql`type = 'late_fee' AND reverses_id IS NULL`),
  uniqueIndex('fee_adjustments_bounce_charge_once_uniq').on(t.paymentId)
    .where(sql`type = 'bounce_charge' AND reverses_id IS NULL`),
  uniqueIndex('fee_adjustments_reverses_uniq').on(t.reversesId),
])

// Allocated by an upsert that increments `lastNumber` inside the payment
// transaction. The row lock serialises numbering per tenant and a rollback
// takes the increment with it, so a gap can never appear (§10).
export const feeReceiptSequences = pgTable('fee_receipt_sequences', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  series: varchar('series', { length: 20 }).notNull(),
  financialYear: varchar('financial_year', { length: 9 }).notNull(),
  // Fixed when the year's first number is issued, so renaming the prefix
  // mid-year cannot split one sequence into two differently-prefixed runs.
  prefix: varchar('prefix', { length: 12 }).notNull(),
  lastNumber: integer('last_number').notNull().default(0),
}, (t) => [
  uniqueIndex('fee_receipt_sequences_tenant_series_fy_uniq').on(t.tenantId, t.series, t.financialYear),
])

// ── Supporting · guardians and reminder bookkeeping ───────────────────────────

// Not columns on `users`: Better Auth owns that table, and a student can have
// two contactable guardians. Guardians have no login in v1.
export const studentGuardians = pgTable('student_guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  name: varchar('name', { length: 120 }).notNull(),
  relation: varchar('relation', { length: 30 }).notNull(),
  phone: varchar('phone', { length: 20 }),
  email: varchar('email', { length: 255 }),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('student_guardians_student_idx').on(t.tenantId, t.studentId),
  uniqueIndex('student_guardians_one_primary_uniq').on(t.tenantId, t.studentId).where(sql`is_primary`),
])

// One row per (invoice, offset) actually sent, so a tick retried after a
// partial failure does not remind a parent twice for the same offset.
export const feeReminderLog = pgTable('fee_reminder_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => feeInvoices.id),
  offsetDays: integer('offset_days').notNull(),
  sentOn: date('sent_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('fee_reminder_log_invoice_offset_uniq').on(t.invoiceId, t.offsetDays),
])
