import { describe, it, expect } from 'vitest'
import { isOverdue } from '@modules/fee/fee.types.js'
import { getFeesSummary } from '@modules/fee/fee.service.js'
import { recordPayment } from '@modules/fee/fee.ledger.js'
import { idemKey, studentWithInvoices } from './fee-fixtures.js'

describe('overdue is derived, never stored (§4, §6)', () => {
  it('flips exactly across the due date boundary', () => {
    expect(isOverdue('issued', '2026-09-10', '2026-09-09')).toBe(false)
    expect(isOverdue('issued', '2026-09-10', '2026-09-10')).toBe(false) // due today is not overdue
    expect(isOverdue('issued', '2026-09-10', '2026-09-11')).toBe(true)
    expect(isOverdue('partially_paid', '2026-09-10', '2026-09-11')).toBe(true)
  })

  it('a closed invoice never reads overdue', () => {
    for (const status of ['paid', 'waived', 'cancelled', 'draft'] as const) {
      expect(isOverdue(status, '2020-01-01', '2026-09-11')).toBe(false)
    }
  })

  it('the student summary flags past-due open invoices and stops once they are paid', async () => {
    const { tenant, owner, student } = await studentWithInvoices({
      items: [{ amount: 10000 }],
      installments: [{ dueInDays: -5, sharePct: 50 }, { dueInDays: 25, sharePct: 50 }],
    })

    const before = await getFeesSummary(tenant.id, student.id)
    expect(before.invoices.map((i) => i.overdue)).toEqual([true, false])
    expect(before.overdueAmount).toBe(500_000)

    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 5000, mode: 'cash', idempotencyKey: idemKey() })
    const after = await getFeesSummary(tenant.id, student.id)
    expect(after.invoices.map((i) => i.overdue)).toEqual([false, false])
    expect(after.overdueAmount).toBe(0)
    expect(after.balance).toBe(500_000)
    expect(after.nextDue?.amount).toBe(500_000)
  })

  it('status is never written as "overdue"', async () => {
    const { invoices } = await studentWithInvoices({ items: [{ amount: 100 }], installments: [{ dueInDays: -30, sharePct: 100 }] })
    expect(invoices[0].status).toBe('issued')
  })
})
