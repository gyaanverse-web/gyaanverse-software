import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { feeInvoices } from '@modules/fee/fee.schema.js'
import { createAdjustment, recordPayment, reverseAdjustment, setPaymentClearance } from '@modules/fee/fee.ledger.js'
import { runFeeReconciler } from '@modules/fee/fee.reconciler.js'
import { getDaybook, getDefaulters, getHeadWiseCollection } from '@modules/fee/fee.reports.js'
import { todayIST } from '@modules/fee/fee.types.js'
import { assign, idemKey, invoiceById, publishStructure, seedFeeTenant, studentWithInvoices } from './fee-fixtures.js'

const TWO = {
  items: [{ amount: 6000 }, { amount: 4000 }],
  installments: [{ dueInDays: -20, sharePct: 50 }, { dueInDays: 20, sharePct: 50 }],
}

describe('fee reconciler (§10 balance drift)', () => {
  it('finds nothing on a healthy ledger', async () => {
    const { tenant, owner, student } = await studentWithInvoices(TWO)
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 7000, mode: 'cash', idempotencyKey: idemKey() })
    const r = await runFeeReconciler({ full: true })
    expect(r).toMatchObject({ repaired: 0, violations: 0 })
    expect(r.checked).toBeGreaterThan(0)
  })

  it('repairs a drifted paidAmount and status from the allocations', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO)
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 5000, mode: 'cash', idempotencyKey: idemKey() })
    // Simulate a hand-run SQL "fix" that got it wrong.
    await db.update(feeInvoices).set({ paidAmount: 0, status: 'issued' }).where(eq(feeInvoices.id, invoices[0].id))

    const r = await runFeeReconciler()
    expect(r.repaired).toBe(1)
    const fixed = await invoiceById(invoices[0].id)
    expect(fixed.paidAmount).toBe(500_000)
    expect(fixed.status).toBe('paid')
  })

  it('agrees with the ledger after a bounce, a waiver and a reversed waiver', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO)
    const cheque = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 3000, mode: 'cheque', reference: '1', idempotencyKey: idemKey() })
    await setPaymentClearance(tenant.id, owner.id, cheque.payment.id, { outcome: 'bounced', reason: 'returned' })
    const waiver = await createAdjustment(tenant.id, owner.id, { studentId: student.id, type: 'waiver', amount: 500, invoiceId: invoices[0].id, reason: 'hardship' })
    await reverseAdjustment(tenant.id, owner.id, waiver.id, 'hardship claim withdrawn')
    await createAdjustment(tenant.id, owner.id, { studentId: student.id, type: 'write_off', amount: 5000, invoiceId: invoices[0].id, reason: 'uncollectable' })

    const inv = await invoiceById(invoices[0].id)
    expect(inv).toMatchObject({ paidAmount: 0, waivedAmount: 500_000, status: 'waived' })
    expect(await runFeeReconciler({ full: true })).toMatchObject({ repaired: 0, violations: 0 })
  })
})

describe('adjustments', () => {
  it('a relief cannot exceed what is outstanding', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO)
    await expect(createAdjustment(tenant.id, owner.id, { studentId: student.id, type: 'waiver', amount: 5001, invoiceId: invoices[0].id, reason: 'x' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('an opening balance raises a payable charge invoice, and reversing it cancels that invoice', async () => {
    const { tenant, owner, student } = await seedFeeTenant()
    const adj = await createAdjustment(tenant.id, owner.id, { studentId: student.id, type: 'opening_balance', amount: 1500, reason: 'carried over from the register' })
    const charge = await invoiceById(adj.invoiceId!)
    expect(charge).toMatchObject({ kind: 'charge', totalAmount: 150_000, status: 'issued' })

    await reverseAdjustment(tenant.id, owner.id, adj.id, 'duplicate entry')
    expect((await invoiceById(adj.invoiceId!)).status).toBe('cancelled')
  })

  it('a charge with money against it cannot be reversed (§5.8)', async () => {
    const { tenant, owner, student } = await seedFeeTenant()
    const adj = await createAdjustment(tenant.id, owner.id, { studentId: student.id, type: 'opening_balance', amount: 1500, reason: 'old dues' })
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    await expect(reverseAdjustment(tenant.id, owner.id, adj.id, 'x')).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('reports', () => {
  it('daybook totals standing money by mode and lists reversals and bounces', async () => {
    const { tenant, owner, student } = await studentWithInvoices(TWO)
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 1000, mode: 'cash', idempotencyKey: idemKey() })
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 2000, mode: 'upi', idempotencyKey: idemKey() })
    const cheque = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 500, mode: 'cheque', reference: '9', idempotencyKey: idemKey() })
    await setPaymentClearance(tenant.id, owner.id, cheque.payment.id, { outcome: 'bounced', reason: 'returned' })

    const day = await getDaybook(tenant.id, todayIST())
    expect(day.collections).toHaveLength(3)
    expect(day.totalsByMode).toEqual({ cash: 100_000, upi: 200_000 })
    expect(day.totalCollected).toBe(300_000)
    expect(day.bounces).toHaveLength(1)
  })

  it('defaulters lists students with overdue balances, oldest first, filtered by class', async () => {
    const seeded = await seedFeeTenant({ extraStudents: 2 })
    const { structure } = await publishStructure(seeded.tenant.id, seeded.owner.id, TWO)
    await assign(seeded.tenant.id, structure.id, seeded.cls.id)
    const [s1, s2] = seeded.students
    // s1 pays off the overdue installment; s2 pays part of it.
    await recordPayment(seeded.tenant.id, seeded.owner.id, { studentId: s1.id, amount: 5000, mode: 'cash', idempotencyKey: idemKey() })
    await recordPayment(seeded.tenant.id, seeded.owner.id, { studentId: s2.id, amount: 1000, mode: 'cash', idempotencyKey: idemKey() })

    const page = await getDefaulters(seeded.tenant.id, { classId: seeded.cls.id })
    expect(page.totalStudents).toBe(2)
    expect(page.items.map((i) => i.studentId)).not.toContain(s1.id)
    const s2Row = page.items.find((i) => i.studentId === s2.id)!
    expect(s2Row.overdueAmount).toBe(400_000)
    expect(s2Row.daysOverdue).toBe(20)
    expect(page.totalOverdue).toBe(900_000)

    const firstPage = await getDefaulters(seeded.tenant.id, { limit: 1 })
    expect(firstPage.items).toHaveLength(1)
    const secondPage = await getDefaulters(seeded.tenant.id, { limit: 1, cursor: firstPage.nextCursor! })
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0].studentId).not.toBe(firstPage.items[0].studentId)
    expect(secondPage.nextCursor).toBeNull()
  })

  it('head-wise attributes collection pro rata across heads', async () => {
    const seeded = await seedFeeTenant()
    const { structure, academicYear, heads } = await publishStructure(seeded.tenant.id, seeded.owner.id, TWO)
    await assign(seeded.tenant.id, structure.id, seeded.cls.id)
    await recordPayment(seeded.tenant.id, seeded.owner.id, { studentId: seeded.student.id, amount: 5000, mode: 'cash', idempotencyKey: idemKey() })

    const report = await getHeadWiseCollection(seeded.tenant.id, academicYear)
    const byHead = new Map(report.heads.map((h) => [h.headId, h]))
    expect(byHead.get(heads[0].id)).toMatchObject({ billed: 600_000, collected: 300_000, outstanding: 300_000 })
    expect(byHead.get(heads[1].id)).toMatchObject({ billed: 400_000, collected: 200_000, outstanding: 200_000 })
    expect(report.totals).toMatchObject({ billed: 1_000_000, collected: 500_000 })
  })
})
