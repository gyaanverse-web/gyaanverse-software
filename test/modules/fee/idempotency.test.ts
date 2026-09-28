import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { feePayments } from '@modules/fee/fee.schema.js'
import { recordPayment } from '@modules/fee/fee.ledger.js'
import { idemKey, invoiceById, studentWithInvoices } from './fee-fixtures.js'

const ONE = { items: [{ amount: 10000 }], installments: [{ dueInDays: 10, sharePct: 100 }] }

describe('Idempotency-Key (§10 double submission)', () => {
  it('the same key twice → one payment, one receipt, replayed on the second call', async () => {
    const { tenant, owner, student, invoices } = await studentWithInvoices(ONE)
    const key = idemKey()
    const input = { studentId: student.id, amount: 4000, mode: 'cash' as const, idempotencyKey: key }

    const first = await recordPayment(tenant.id, owner.id, input)
    const second = await recordPayment(tenant.id, owner.id, input)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.payment.id).toBe(first.payment.id)
    expect(second.payment.receiptNo).toBe(first.payment.receiptNo)

    const rows = await db.select().from(feePayments).where(eq(feePayments.tenantId, tenant.id))
    expect(rows).toHaveLength(1)
    expect((await invoiceById(invoices[0].id)).paidAmount).toBe(400000) // applied once, not twice
  })

  it('concurrent submits of the same key still produce one payment', async () => {
    const { tenant, owner, student } = await studentWithInvoices(ONE)
    const input = { studentId: student.id, amount: 1000, mode: 'cash' as const, idempotencyKey: idemKey() }

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => recordPayment(tenant.id, owner.id, input)))

    expect(new Set(results.map((r) => r.payment.id)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    const rows = await db.select().from(feePayments)
      .where(and(eq(feePayments.tenantId, tenant.id), eq(feePayments.idempotencyKey, input.idempotencyKey)))
    expect(rows).toHaveLength(1)
    // The losers' rolled-back transactions spent no receipt number.
    expect(rows[0].receiptNo).toMatch(/\/00001$/)
  })

  it('the same key reused for a different payment is a conflict, not a silent replay', async () => {
    const { tenant, owner, student } = await studentWithInvoices(ONE)
    const key = idemKey()
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 1000, mode: 'cash', idempotencyKey: key })
    await expect(recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 2000, mode: 'cash', idempotencyKey: key }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('keys are scoped per tenant', async () => {
    const a = await studentWithInvoices(ONE)
    const b = await studentWithInvoices(ONE)
    const key = idemKey()
    const pa = await recordPayment(a.tenant.id, a.owner.id, { studentId: a.student.id, amount: 1000, mode: 'cash', idempotencyKey: key })
    const pb = await recordPayment(b.tenant.id, b.owner.id, { studentId: b.student.id, amount: 1000, mode: 'cash', idempotencyKey: key })
    expect(pb.replayed).toBe(false)
    expect(pb.payment.id).not.toBe(pa.payment.id)
  })
})
