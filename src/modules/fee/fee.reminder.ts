// ─────────────────────────────────────────────────────────────────────────────
// The once-daily fee tick (LLD §7f): reminders, late fees, then the reconciler.
//
// A grading tick that stops is bad. A fee-reminder tick that stops is a
// coaching that quietly stops chasing its money and does not find out for a
// month — which is why its schedule is re-asserted by `assertSchedules()` in
// worker.ts rather than registered once at boot.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq, inArray, lt } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { env } from '../../config/env.js'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { dispatch } from '../notification/notification.service.js'
import { sendEmail } from '../notification/channels/email.channel.js'
import { sendSms } from '../notification/channels/sms.channel.js'
import { resolveEmailTemplate } from '../notification/templates/index.js'
import { isFeesEnabled } from '../platform/platform.service.js'
import { feeAdjustments, feeInvoices, feeReminderLog, tenantFeeSettings } from './fee.schema.js'
import { getFeeLifecycleQueue } from './fee.queues.js'
import { primaryGuardians } from './fee.service.js'
import { levyLateFee } from './fee.ledger.js'
import { runFeeReconciler, type FeeReconcileResult } from './fee.reconciler.js'
import {
  OPEN_INVOICE_STATUSES,
  addDays,
  formatINR,
  outstandingOf,
  todayIST,
  type LateFeePolicy,
  type ReminderPolicy,
} from './fee.types.js'

export const FEE_TICK_JOB = 'fee-daily-tick'
export const GUARDIAN_NOTIFY_JOB = 'guardian-notify'

/**
 * Register the daily tick. Same repeat key every call — a no-op when the entry
 * exists, a repair when a Redis flush deleted it.
 */
export async function ensureFeeLifecycleSchedule(): Promise<void> {
  await getFeeLifecycleQueue().add(
    FEE_TICK_JOB,
    {},
    {
      repeat: { pattern: env.FEE_LIFECYCLE_CRON, tz: env.FEE_LIFECYCLE_TZ },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  )
}

// ── Guardian delivery ─────────────────────────────────────────────────────────
//
// Guardians have no user account, so they cannot go through `dispatch()` (which
// addresses user ids and writes an in-app row). Their messages ride this queue
// instead, with BullMQ's retries, and use the same email chrome and SMS
// template lookup as every other notification.

export interface GuardianNotifyPayload {
  channel: 'email' | 'sms'
  to: string
  guardianName: string
  type: 'fee_due_reminder' | 'fee_overdue'
  title: string
  body: string
}

export async function deliverGuardianMessage(p: GuardianNotifyPayload): Promise<void> {
  if (p.channel === 'email') {
    const template = resolveEmailTemplate(p.type, { recipientName: p.guardianName, title: p.title, body: p.body, link: null })
    await sendEmail({ to: p.to, ...template, text: p.body })
    return
  }
  await sendSms({
    to: p.to.replace(/^\+/, ''),
    body: p.body,
    templateId: process.env[`MSG91_${p.type.toUpperCase()}_TEMPLATE_ID`] ?? env.MSG91_TEMPLATE_ID,
    vars: { name: p.guardianName },
  })
}

// ── Reminders ─────────────────────────────────────────────────────────────────

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/**
 * Invoices whose due date sits exactly on a configured offset from today.
 * Exact-day matching is deliberate: the reminder log makes each (invoice,
 * offset) fire once, and a missed day simply skips that one nudge rather than
 * sending three at once when the tick recovers.
 */
async function sendTenantReminders(tenantId: string, tenantName: string, policy: ReminderPolicy, today: string) {
  const offsets = [...new Set(policy.offsetsDays)]
  const dueDates = offsets.map((o) => addDays(today, -o))
  const invoices = await db.select().from(feeInvoices).where(and(
    eq(feeInvoices.tenantId, tenantId),
    inArray(feeInvoices.status, [...OPEN_INVOICE_STATUSES]),
    inArray(feeInvoices.dueDate, dueDates),
  ))
  if (invoices.length === 0) return { reminders: 0, guardianMessages: 0 }

  // Claim each (invoice, offset) first; only what we claimed is sent.
  const claimed: typeof invoices = []
  for (const inv of invoices) {
    const offset = daysBetween(inv.dueDate, today)
    const [row] = await db.insert(feeReminderLog).values({ invoiceId: inv.id, offsetDays: offset, sentOn: today })
      .onConflictDoNothing().returning()
    if (row) claimed.push(inv)
  }
  if (claimed.length === 0) return { reminders: 0, guardianMessages: 0 }

  // One message per student per kind, listing every invoice it covers.
  const groups = new Map<string, { studentId: string; overdue: boolean; invoices: typeof invoices }>()
  for (const inv of claimed) {
    const overdue = inv.dueDate < today
    const key = `${inv.studentId}:${overdue}`
    const g = groups.get(key) ?? { studentId: inv.studentId, overdue, invoices: [] }
    g.invoices.push(inv)
    groups.set(key, g)
  }

  const studentIds = [...new Set(claimed.map((i) => i.studentId))]
  const [guardians, studentRows] = await Promise.all([
    primaryGuardians(tenantId, studentIds),
    db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, studentIds)),
  ])
  const studentName = new Map(studentRows.map((s) => [s.id, s.name]))

  let reminders = 0
  let guardianMessages = 0
  for (const g of groups.values()) {
    const amount = g.invoices.reduce((s, i) => s + outstandingOf(i), 0)
    const list = g.invoices.map((i) => `${i.label} (due ${i.dueDate})`).join(', ')
    const type = g.overdue ? 'fee_overdue' as const : 'fee_due_reminder' as const
    const title = g.overdue ? `Fee overdue — ${formatINR(amount)}` : `Fee due — ${formatINR(amount)}`
    const body = g.overdue
      ? `${formatINR(amount)} is overdue at ${tenantName}: ${list}. Please pay at the earliest.`
      : `${formatINR(amount)} is due at ${tenantName}: ${list}.`

    await dispatch({
      type,
      recipients: { userIds: [g.studentId] },
      tenantId,
      data: { title, body, link: '/fees', metadata: { invoiceIds: g.invoices.map((i) => i.id) } },
    })
    reminders += 1

    const guardian = guardians.get(g.studentId)
    if (!guardian) continue
    const guardianBody = `${studentName.get(g.studentId) ?? 'Your ward'}: ${body}`
    const targets: GuardianNotifyPayload[] = []
    if (policy.channels.includes('email') && guardian.email) {
      targets.push({ channel: 'email', to: guardian.email, guardianName: guardian.name, type, title, body: guardianBody })
    }
    if (policy.channels.includes('sms') && guardian.phone) {
      targets.push({ channel: 'sms', to: guardian.phone, guardianName: guardian.name, type, title, body: guardianBody })
    }
    for (const payload of targets) {
      await getFeeLifecycleQueue().add(GUARDIAN_NOTIFY_JOB, payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      })
      guardianMessages += 1
    }
  }

  return { reminders, guardianMessages }
}

// ── Late fees ─────────────────────────────────────────────────────────────────

async function levyTenantLateFees(tenantId: string, policy: LateFeePolicy, today: string): Promise<number> {
  const cutoff = addDays(today, -policy.graceDays) // due strictly before this = past grace
  const candidates = await db.select({ id: feeInvoices.id }).from(feeInvoices).where(and(
    eq(feeInvoices.tenantId, tenantId),
    eq(feeInvoices.kind, 'installment'),
    inArray(feeInvoices.status, [...OPEN_INVOICE_STATUSES]),
    lt(feeInvoices.dueDate, cutoff),
  ))
  if (candidates.length === 0) return 0

  // Cheap pre-filter; the partial unique index is the actual guarantee.
  const already = new Set((await db.select({ id: feeAdjustments.sourceInvoiceId }).from(feeAdjustments).where(and(
    eq(feeAdjustments.type, 'late_fee'),
    inArray(feeAdjustments.sourceInvoiceId, candidates.map((c) => c.id)),
  ))).map((r) => r.id))

  let levied = 0
  for (const c of candidates) {
    if (already.has(c.id)) continue
    try {
      if (await levyLateFee(tenantId, c.id, policy)) levied += 1
    } catch (err) {
      console.error(`[fee-lifecycle] late fee failed tenant=${tenantId} invoice=${c.id}:`, err)
    }
  }
  return levied
}

// ── The tick ──────────────────────────────────────────────────────────────────

export interface FeeTickResult {
  skipped?: 'fees-disabled'
  reminders: number
  guardianMessages: number
  lateFees: number
  errors: number
  reconcile?: FeeReconcileResult
}

export async function runFeeLifecycleTick(now: Date = new Date()): Promise<FeeTickResult> {
  const result: FeeTickResult = { reminders: 0, guardianMessages: 0, lateFees: 0, errors: 0 }
  if (!(await isFeesEnabled())) return { ...result, skipped: 'fees-disabled' }

  const today = todayIST(now)
  const rows = await db.select({
    tenantId: tenantFeeSettings.tenantId,
    tenantName: tenants.name,
    reminderPolicy: tenantFeeSettings.reminderPolicy,
    lateFeePolicy: tenantFeeSettings.lateFeePolicy,
  }).from(tenantFeeSettings)
    .innerJoin(tenants, eq(tenantFeeSettings.tenantId, tenants.id))
    .where(eq(tenants.status, 'active'))

  // One tenant's failure must not cost every other coaching its reminders.
  for (const row of rows) {
    const reminderPolicy = row.reminderPolicy as ReminderPolicy
    const lateFeePolicy = row.lateFeePolicy as LateFeePolicy
    try {
      if (reminderPolicy?.enabled) {
        const r = await sendTenantReminders(row.tenantId, row.tenantName, reminderPolicy, today)
        result.reminders += r.reminders
        result.guardianMessages += r.guardianMessages
      }
      if (lateFeePolicy?.enabled) {
        result.lateFees += await levyTenantLateFees(row.tenantId, lateFeePolicy, today)
      }
    } catch (err) {
      result.errors += 1
      console.error(`[fee-lifecycle] tenant=${row.tenantId} failed:`, err)
    }
  }

  // Last, so it also checks everything this tick just wrote.
  result.reconcile = await runFeeReconciler({ now })
  return result
}
