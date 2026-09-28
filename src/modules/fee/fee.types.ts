import type { DB } from '../../shared/db.js'

/** The handle inside `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]

// Branded by convention only — always an integer, always paise. See §3 of the LLD.
export type Paise = number

export const toPaise = (rupees: string | number): Paise => Math.round(Number(rupees) * 100)

export const formatINR = (p: Paise): string =>
  (p / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })

export type FeeHeadCategory =
  | 'tuition'
  | 'admission'
  | 'transport'
  | 'exam'
  | 'material'
  | 'penalty'
  | 'other'

export type FeeHeadStatus = 'active' | 'archived'
export type FeeStructureStatus = 'draft' | 'published' | 'archived'
export type FeeAssignmentStatus = 'active' | 'completed' | 'withdrawn'
export type FeeConcessionType = 'scholarship' | 'sibling' | 'staff_ward' | 'merit' | 'need_based' | 'other'
export type FeeConcessionMode = 'percent' | 'amount'
export type GstMode = 'none' | 'registered'

// draft is not reachable from the current write path (invoices are generated
// straight into `issued`) — kept in the union because §6 defines it as a state.
export type FeeInvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'waived' | 'cancelled'

// `installment` invoices come from a structure via the assignment fan-out.
// `charge` invoices are raised by a positive adjustment (late fee, bounce
// charge, opening balance) so that every rupee owed is something a payment
// can be allocated against — they carry no assignment and no installment seq.
export type FeeInvoiceKind = 'installment' | 'charge'

export const OPEN_INVOICE_STATUSES = ['issued', 'partially_paid'] as const

// ── Layer 3 ──────────────────────────────────────────────────────────────────

export type FeePaymentMode = 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'dd' | 'card' | 'other'
export type FeePaymentStatus = 'recorded' | 'reversed'
export type FeeClearanceStatus = 'cleared' | 'pending' | 'bounced'

/** Instruments that can bounce — created `pending`, everything else `cleared`. */
export const CLEARABLE_MODES: readonly FeePaymentMode[] = ['cheque', 'dd']

export type FeeAdjustmentType =
  | 'late_fee'
  | 'bounce_charge'
  | 'opening_balance'
  | 'waiver'
  | 'write_off'
  | 'credit_note'

/** Raise what is owed — each one creates a `charge` invoice. */
export const CHARGE_ADJUSTMENT_TYPES: readonly FeeAdjustmentType[] = ['late_fee', 'bounce_charge', 'opening_balance']
/** Reduce what is owed on one invoice — materialised into `waivedAmount`. */
export const RELIEF_ADJUSTMENT_TYPES: readonly FeeAdjustmentType[] = ['waiver', 'write_off', 'credit_note']

export type FeeSequenceSeries = 'RECEIPT' | 'INVOICE'

// ── Policies (stored as jsonb on tenant_fee_settings) ────────────────────────

export interface LateFeePolicy {
  enabled: boolean
  /** Days after the due date before the fee is levied. */
  graceDays: number
  mode: 'percent' | 'amount'
  /** A percentage of the outstanding balance when mode='percent', paise when mode='amount'. */
  value: number
  capAmount: Paise | null
}

export interface ReminderPolicy {
  enabled: boolean
  /** Days relative to the due date: negative = before, 0 = on the day, positive = overdue. */
  offsetsDays: number[]
  /**
   * Channels used for the primary GUARDIAN only. The student's own channels are
   * decided by NOTIFICATION_CONFIG like every other notification — callers
   * never choose them.
   */
  channels: ('email' | 'sms')[]
}

export const DEFAULT_LATE_FEE_POLICY: LateFeePolicy = {
  enabled: false,
  graceDays: 0,
  mode: 'amount',
  value: 0,
  capAmount: null,
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  enabled: false,
  offsetsDays: [-7, -1, 0, 3, 7],
  channels: ['email'],
}

// ── Dates — coachings keep Indian calendars, the servers run in UTC ──────────

/** Today's calendar date in India, as YYYY-MM-DD. */
export function todayIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The instant an Indian calendar day starts. */
export function istDayStart(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+05:30`)
}

/** "2026-27" for an April-start year; "2026" for a January-start one. */
export function financialYearOf(isoDate: string, startMonth: number): string {
  const [y, m] = isoDate.split('-').map(Number)
  const start = m >= startMonth ? y : y - 1
  if (startMonth === 1) return String(start)
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/**
 * Is this a Postgres unique violation (optionally on a named constraint)?
 * drizzle 0.45 wraps driver errors in a DrizzleQueryError, so the pg fields
 * live on `err.cause` — checking `err.code` alone never matches.
 */
export function isUniqueViolation(err: unknown, constraintFragment?: string): boolean {
  const pg = (err as any)?.cause?.code ? (err as any).cause : err
  if (pg?.code !== '23505') return false
  return !constraintFragment || String(pg.constraint ?? '').includes(constraintFragment)
}

// ── Invoice arithmetic ───────────────────────────────────────────────────────

interface InvoiceBalance {
  status: string
  totalAmount: Paise
  paidAmount: Paise
  waivedAmount: Paise
}

export function outstandingOf(inv: Omit<InvoiceBalance, 'status'>): Paise {
  return Math.max(0, inv.totalAmount - inv.paidAmount - inv.waivedAmount)
}

/**
 * The one definition of an invoice's status from its balances (§6). Used by the
 * ledger on every write and by the reconciler to detect drift, so the two can
 * never disagree about what "paid" means.
 *
 * `waived` means the invoice closed with some of it forgiven rather than paid —
 * which is the thing a collections report needs to tell apart from `paid`.
 * `cancelled` and `draft` are never derived; they are set explicitly.
 */
export function deriveInvoiceStatus(inv: InvoiceBalance): FeeInvoiceStatus {
  if (inv.status === 'cancelled' || inv.status === 'draft') return inv.status
  const outstanding = inv.totalAmount - inv.paidAmount - inv.waivedAmount
  if (outstanding <= 0) return inv.waivedAmount > 0 ? 'waived' : 'paid'
  return inv.paidAmount > 0 ? 'partially_paid' : 'issued'
}

/** `overdue` is derived, never stored — see the invariant in LLD §4/§6. */
export function isOverdue(status: FeeInvoiceStatus, dueDate: string, today: string = todayIST()): boolean {
  if (status !== 'issued' && status !== 'partially_paid') return false
  return dueDate < today
}

/**
 * CGST/SGST for an intra-state supply, IGST otherwise. Split from the persisted
 * integer tax, so it is deterministic at every render — not a second rounding.
 */
export function splitGst(taxAmount: Paise, intraState: boolean) {
  if (!intraState) return { cgst: 0, sgst: 0, igst: taxAmount }
  const cgst = Math.round(taxAmount / 2)
  return { cgst, sgst: taxAmount - cgst, igst: 0 }
}
