import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { dispatch } from '@modules/notification/notification.service.js'
import { feeAdjustments, feeInvoices } from '@modules/fee/fee.schema.js'
import { addGuardian, updateFeeSettings } from '@modules/fee/fee.service.js'
import { recordPayment } from '@modules/fee/fee.ledger.js'
import { runFeeLifecycleTick, GUARDIAN_NOTIFY_JOB } from '@modules/fee/fee.reminder.js'
import { getFeeLifecycleQueue } from '@modules/fee/fee.queues.js'
import { idemKey, setFeesEnabled, studentWithInvoices } from './fee-fixtures.js'

const reminderCalls = () => vi.mocked(dispatch).mock.calls.filter(([arg]) => arg.type === 'fee_due_reminder' || arg.type === 'fee_overdue')

beforeEach(() => {
  vi.mocked(dispatch).mockClear()
  vi.mocked(getFeeLifecycleQueue().add).mockClear()
})

describe('fee lifecycle tick (§7f)', () => {
  it('does nothing while fees are switched off', async () => {
    await setFeesEnabled(false)
    const r = await runFeeLifecycleTick()
    expect(r.skipped).toBe('fees-disabled')
  })

  it('reminds the student and the primary guardian on a configured offset, once', async () => {
    await setFeesEnabled(true)
    const { tenant, student } = await studentWithInvoices({ items: [{ amount: 5000 }], installments: [{ dueInDays: 7, sharePct: 100 }] })
    await addGuardian(tenant.id, student.id, { name: 'Parent', relation: 'Father', phone: '+919876543210', email: 'parent@test.local' })
    await updateFeeSettings(tenant.id, { reminderPolicy: { enabled: true, offsetsDays: [-7, 0, 3], channels: ['email', 'sms'] } })

    const first = await runFeeLifecycleTick()
    expect(first.reminders).toBe(1)
    expect(first.guardianMessages).toBe(2)
    expect(reminderCalls()).toHaveLength(1)
    expect(reminderCalls()[0][0]).toMatchObject({ type: 'fee_due_reminder', recipients: { userIds: [student.id] } })
    const guardianJobs = vi.mocked(getFeeLifecycleQueue().add).mock.calls.filter(([name]) => name === GUARDIAN_NOTIFY_JOB)
    expect(guardianJobs.map(([, p]) => (p as any).channel).sort()).toEqual(['email', 'sms'])

    // The tick running twice on the same day does not remind twice.
    const second = await runFeeLifecycleTick()
    expect(second.reminders).toBe(0)
    expect(reminderCalls()).toHaveLength(1)
  })

  it('sends the overdue kind for a positive offset, and nothing for paid invoices', async () => {
    await setFeesEnabled(true)
    const { tenant, owner, student } = await studentWithInvoices({
      items: [{ amount: 5000 }],
      installments: [{ dueInDays: -3, sharePct: 50 }, { dueInDays: -2, sharePct: 50 }],
    })
    await updateFeeSettings(tenant.id, { reminderPolicy: { enabled: true, offsetsDays: [2, 3], channels: [] } })
    // Pay off the older one; only the -2 invoice is still open.
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 2500, mode: 'cash', idempotencyKey: idemKey() })

    await runFeeLifecycleTick()
    expect(reminderCalls()).toHaveLength(1)
    expect(reminderCalls()[0][0].type).toBe('fee_overdue')
    expect(reminderCalls()[0][0].data.body).toContain('₹2,500')
  })

  it('levies one late fee per overdue installment, however many times it runs', async () => {
    await setFeesEnabled(true)
    const { tenant, student, invoices } = await studentWithInvoices({
      items: [{ amount: 10000 }],
      installments: [{ dueInDays: -10, sharePct: 50 }, { dueInDays: -1, sharePct: 50 }],
    })
    await updateFeeSettings(tenant.id, { lateFeePolicy: { enabled: true, graceDays: 3, mode: 'amount', value: 200, capAmount: null } })

    const first = await runFeeLifecycleTick()
    const second = await runFeeLifecycleTick()
    expect(first.lateFees).toBe(1) // only the one past its grace period
    expect(second.lateFees).toBe(0)

    const fees = await db.select().from(feeAdjustments).where(and(eq(feeAdjustments.tenantId, tenant.id), eq(feeAdjustments.type, 'late_fee')))
    expect(fees).toHaveLength(1)
    expect(fees[0].sourceInvoiceId).toBe(invoices[0].id)
    expect(fees[0].amount).toBe(20_000)
    expect(fees[0].createdBy).toBeNull()

    const charges = await db.select().from(feeInvoices).where(and(eq(feeInvoices.studentId, student.id), eq(feeInvoices.kind, 'charge')))
    expect(charges).toHaveLength(1)
    expect(charges[0].totalAmount).toBe(20_000)
  })

  it('percent late fees respect the cap', async () => {
    await setFeesEnabled(true)
    const { tenant } = await studentWithInvoices({ items: [{ amount: 100000 }], installments: [{ dueInDays: -10, sharePct: 100 }] })
    await updateFeeSettings(tenant.id, { lateFeePolicy: { enabled: true, graceDays: 0, mode: 'percent', value: 2, capAmount: 500 } })
    await runFeeLifecycleTick()
    const [fee] = await db.select().from(feeAdjustments).where(eq(feeAdjustments.tenantId, tenant.id))
    expect(fee.amount).toBe(50_000) // 2% of ₹1,00,000 is ₹2,000, capped at ₹500
  })
})
