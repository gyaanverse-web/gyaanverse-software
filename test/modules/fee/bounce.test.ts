import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { dispatch } from '@modules/notification/notification.service.js'
import { feeAdjustments, feePaymentAllocations } from '@modules/fee/fee.schema.js'
import { recordPayment, reversePayment, setPaymentClearance } from '@modules/fee/fee.ledger.js'
import { getReceipt, renderReceipt } from '@modules/fee/fee.receipt.js'
import { updateFeeSettings } from '@modules/fee/fee.service.js'
import { idemKey, invoiceById, invoicesOf, studentWithInvoices } from './fee-fixtures.js'

const ONE = { items: [{ amount: 10000 }], installments: [{ dueInDays: 10, sharePct: 100 }] }

async function paidByCashAndCheque() {
  const ctx = await studentWithInvoices(ONE)
  await recordPayment(ctx.tenant.id, ctx.owner.id, { studentId: ctx.student.id, amount: 3000, mode: 'cash', idempotencyKey: idemKey() })
  const cheque = await recordPayment(ctx.tenant.id, ctx.owner.id, {
    studentId: ctx.student.id, amount: 7000, mode: 'cheque', reference: '000123', bankName: 'SBI', idempotencyKey: idemKey(),
  })
  return { ...ctx, cheque: cheque.payment }
}

describe('cheque clearance and bounce (§7d)', () => {
  it('cheques are created pending and still count toward the balance', async () => {
    const { cheque, invoices } = await paidByCashAndCheque()
    expect(cheque.clearanceStatus).toBe('pending')
    expect((await invoiceById(invoices[0].id)).status).toBe('paid')
  })

  it('a cheque needs its instrument number', async () => {
    const ctx = await studentWithInvoices(ONE)
    await expect(recordPayment(ctx.tenant.id, ctx.owner.id, { studentId: ctx.student.id, amount: 100, mode: 'cheque', idempotencyKey: idemKey() }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('bounce walks a paid invoice back to partially_paid and restores the balance exactly', async () => {
    const { tenant, owner, cheque, invoices } = await paidByCashAndCheque()
    await setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'bounced', reason: 'Insufficient funds' })

    const inv = await invoiceById(invoices[0].id)
    expect(inv.status).toBe('partially_paid')
    expect(inv.paidAmount).toBe(300000)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'fee_payment_bounced' }))
  })

  it('bounce keeps the allocations as the audit trail', async () => {
    const { tenant, owner, cheque } = await paidByCashAndCheque()
    await setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'bounced', reason: 'Signature mismatch' })
    const rows = await db.select().from(feePaymentAllocations).where(eq(feePaymentAllocations.paymentId, cheque.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(700000)
  })

  it('the bounced receipt keeps its number, prints BOUNCED, and the next receipt does not reuse it', async () => {
    const { tenant, owner, student, cheque } = await paidByCashAndCheque()
    await setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'bounced', reason: 'Insufficient funds' })

    const rendered = renderReceipt(await getReceipt(tenant.id, cheque.id))
    expect(rendered.stamp).toBe('BOUNCED')
    expect(rendered.document.receiptNo).toBe(cheque.receiptNo)

    const next = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 7000, mode: 'cash', idempotencyKey: idemKey() })
    expect(next.payment.receiptNo).not.toBe(cheque.receiptNo)
    expect(Number(next.payment.receiptNo.split('/').at(-1))).toBe(3)
  })

  it('levies the bounce charge exactly once', async () => {
    const { tenant, owner, student, cheque } = await paidByCashAndCheque()
    await updateFeeSettings(tenant.id, { bounceCharge: 500 })

    const { bounceCharge } = await setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'bounced', reason: 'Insufficient funds' })
    expect(bounceCharge?.amount).toBe(50000)

    // A second bounce of the same cheque is refused outright.
    await expect(setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'bounced', reason: 'again' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })

    const charges = await db.select().from(feeAdjustments).where(eq(feeAdjustments.paymentId, cheque.id))
    expect(charges).toHaveLength(1)
    const chargeInvoice = (await invoicesOf(tenant.id, student.id)).find((i) => i.kind === 'charge')
    expect(chargeInvoice?.totalAmount).toBe(50000)
    expect(chargeInvoice?.status).toBe('issued')
  })

  it('clearing a cheque changes no balance', async () => {
    const { tenant, owner, cheque, invoices } = await paidByCashAndCheque()
    const { payment } = await setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'cleared' })
    expect(payment.clearanceStatus).toBe('cleared')
    expect((await invoiceById(invoices[0].id)).paidAmount).toBe(1000000)
  })

  it('cash cannot bounce', async () => {
    const ctx = await studentWithInvoices(ONE)
    const { payment } = await recordPayment(ctx.tenant.id, ctx.owner.id, { studentId: ctx.student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    await expect(setPaymentClearance(ctx.tenant.id, ctx.owner.id, payment.id, { outcome: 'bounced', reason: 'x' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('reversing a bounced cheque does not unwind the balance a second time', async () => {
    const { tenant, owner, cheque, invoices } = await paidByCashAndCheque()
    await setPaymentClearance(tenant.id, owner.id, cheque.id, { outcome: 'bounced', reason: 'Insufficient funds' })
    await reversePayment(tenant.id, owner.id, cheque.id, 'entered in error')
    expect((await invoiceById(invoices[0].id)).paidAmount).toBe(300000)
  })
})
