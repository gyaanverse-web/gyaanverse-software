import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { feePaymentAllocations } from '@modules/fee/fee.schema.js'
import { recordPayment, applyCredit, getCreditBalance } from '@modules/fee/fee.ledger.js'
import { assign, idemKey, invoiceById, invoicesOf, publishStructure, seedFeeTenant, studentWithInvoices } from './fee-fixtures.js'

// ₹10,000 in two equal installments: 5,00,000 paise each.
const TWO_HALVES = {
  items: [{ amount: 10000 }],
  installments: [{ dueInDays: -30, sharePct: 50 }, { dueInDays: 30, sharePct: 50 }],
}

describe('payment allocation', () => {
  it('partial payment leaves the invoice partially_paid', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 2000, mode: 'cash', idempotencyKey: idemKey() })

    const first = await invoiceById(invoices[0].id)
    expect(first.paidAmount).toBe(200000)
    expect(first.status).toBe('partially_paid')
    expect((await invoiceById(invoices[1].id)).paidAmount).toBe(0)
  })

  it('exact payment marks the invoice paid', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 5000, mode: 'upi', idempotencyKey: idemKey() })
    const first = await invoiceById(invoices[0].id)
    expect(first.paidAmount).toBe(500000)
    expect(first.status).toBe('paid')
  })

  it('default allocation is oldest-due-first across invoices', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    const { allocations } = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 7000, mode: 'cash', idempotencyKey: idemKey() })

    expect(allocations).toHaveLength(2)
    expect((await invoiceById(invoices[0].id)).status).toBe('paid')
    const second = await invoiceById(invoices[1].id)
    expect(second.paidAmount).toBe(200000)
    expect(second.status).toBe('partially_paid')
  })

  it('explicit allocation can target a later invoice', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    await recordPayment(tenant.id, owner.id, {
      studentId: student.id, amount: 5000, mode: 'cash', idempotencyKey: idemKey(),
      allocations: [{ invoiceId: invoices[1].id, amount: 5000 }],
    })
    expect((await invoiceById(invoices[0].id)).paidAmount).toBe(0)
    expect((await invoiceById(invoices[1].id)).status).toBe('paid')
  })

  it('rejects over-allocation of an invoice', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    await expect(recordPayment(tenant.id, owner.id, {
      studentId: student.id, amount: 6000, mode: 'cash', idempotencyKey: idemKey(),
      allocations: [{ invoiceId: invoices[0].id, amount: 6000 }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects allocations that exceed the amount received', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    await expect(recordPayment(tenant.id, owner.id, {
      studentId: student.id, amount: 1000, mode: 'cash', idempotencyKey: idemKey(),
      allocations: [{ invoiceId: invoices[0].id, amount: 2000 }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('a rejected payment writes nothing and burns no receipt number', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    await expect(recordPayment(tenant.id, owner.id, {
      studentId: student.id, amount: 1000, mode: 'cash', idempotencyKey: idemKey(),
      allocations: [{ invoiceId: invoices[0].id, amount: 2000 }],
    })).rejects.toBeTruthy()
    const { payment } = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    expect(payment.receiptNo).toMatch(/\/00001$/)
  })

  it('rejects allocation to another student\'s invoice in the same tenant', async () => {
    const seeded = await seedFeeTenant({ extraStudents: 1 })
    const { structure } = await publishStructure(seeded.tenant.id, seeded.owner.id, TWO_HALVES)
    await assign(seeded.tenant.id, structure.id, seeded.cls.id)
    const [sibling] = await invoicesOf(seeded.tenant.id, seeded.students[1].id)

    await expect(recordPayment(seeded.tenant.id, seeded.owner.id, {
      studentId: seeded.students[0].id, amount: 1000, mode: 'cash', idempotencyKey: idemKey(),
      allocations: [{ invoiceId: sibling.id, amount: 1000 }],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects allocation to another tenant\'s invoice', async () => {
    const a = await studentWithInvoices(TWO_HALVES)
    const b = await seedFeeTenant()
    await expect(recordPayment(b.tenant.id, b.owner.id, {
      studentId: b.student.id, amount: 1000, mode: 'cash', idempotencyKey: idemKey(),
      allocations: [{ invoiceId: a.invoices[0].id, amount: 1000 }],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('remainder beyond all open invoices becomes credit', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(TWO_HALVES)
    const { payment } = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 12000, mode: 'bank_transfer', idempotencyKey: idemKey() })

    expect((await invoiceById(invoices[0].id)).status).toBe('paid')
    expect((await invoiceById(invoices[1].id)).status).toBe('paid')
    expect(await getCreditBalance(tenant.id, student.id)).toBe(200000)
    expect((payment.documentSnapshot as any).creditAmount).toBe(200000)
  })

  it('credit paid in advance is applied to invoices issued later', async () => {
    const seeded = await seedFeeTenant()
    await recordPayment(seeded.tenant.id, seeded.owner.id, { studentId: seeded.student.id, amount: 3000, mode: 'cash', idempotencyKey: idemKey() })
    expect(await getCreditBalance(seeded.tenant.id, seeded.student.id)).toBe(300000)

    const { structure } = await publishStructure(seeded.tenant.id, seeded.owner.id, TWO_HALVES)
    await assign(seeded.tenant.id, structure.id, seeded.cls.id)
    const result = await applyCredit(seeded.tenant.id, seeded.owner.id, seeded.student.id)

    expect(result.allocated).toBe(300000)
    const [first] = await invoicesOf(seeded.tenant.id, seeded.student.id)
    expect(first.paidAmount).toBe(300000)
    expect(await getCreditBalance(seeded.tenant.id, seeded.student.id)).toBe(0)
  })

  it('allocations sum to at most the payment amount (§5.1)', async () => {
    const { tenant, owner, student } = await studentWithInvoices(TWO_HALVES)
    const { payment } = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 12000, mode: 'cash', idempotencyKey: idemKey() })
    const rows = await db.select().from(feePaymentAllocations).where(eq(feePaymentAllocations.paymentId, payment.id))
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeLessThanOrEqual(payment.amount)
  })
})
