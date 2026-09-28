import { describe, it, expect } from 'vitest'
import {
  applyCredit,
  createAdjustment,
  recordPayment,
  reverseAdjustment,
  reversePayment,
  setPaymentClearance,
} from '@modules/fee/fee.ledger.js'
import { getReceipt, listStudentReceipts, renderTaxInvoice } from '@modules/fee/fee.receipt.js'
import { addGuardian, getFeesSummary, getStudentLedger, listInvoicesForStudent, removeGuardian } from '@modules/fee/fee.service.js'
import { getDefaulters, listPayments } from '@modules/fee/fee.reports.js'
import { idemKey, seedFeeTenant, publishStructure, assign, invoicesOf, studentWithInvoices } from './fee-fixtures.js'

const ONE = { items: [{ amount: 10000 }], installments: [{ dueInDays: -10, sharePct: 100 }] }

async function tenantWithMoney() {
  const ctx = await studentWithInvoices(ONE, { gst: {} })
  const { payment } = await recordPayment(ctx.tenant.id, ctx.owner.id, {
    studentId: ctx.student.id, amount: 1000, mode: 'cheque', reference: '42', idempotencyKey: idemKey(),
  })
  const adjustment = await createAdjustment(ctx.tenant.id, ctx.owner.id, {
    studentId: ctx.student.id, type: 'waiver', amount: 100, invoiceId: ctx.invoices[0].id, reason: 'goodwill',
  })
  return { ...ctx, payment, adjustment }
}

describe('tenant isolation — every read and write refuses another tenant\'s rows', () => {
  it('receipts, tax invoices and ledger writes are NOT_FOUND across tenants', async () => {
    const a = await tenantWithMoney()
    const b = await seedFeeTenant()

    await expect(getReceipt(b.tenant.id, a.payment.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(renderTaxInvoice(b.tenant.id, a.invoices[0].id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(reversePayment(b.tenant.id, b.owner.id, a.payment.id, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setPaymentClearance(b.tenant.id, b.owner.id, a.payment.id, { outcome: 'cleared' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(reverseAdjustment(b.tenant.id, b.owner.id, a.adjustment.id, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(createAdjustment(b.tenant.id, b.owner.id, {
      studentId: a.student.id, type: 'waiver', amount: 1, invoiceId: a.invoices[0].id, reason: 'x',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(recordPayment(b.tenant.id, b.owner.id, { studentId: a.student.id, amount: 1, mode: 'cash', idempotencyKey: idemKey() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('list and summary reads scoped to another tenant come back empty', async () => {
    const a = await tenantWithMoney()
    const b = await seedFeeTenant()

    const ledger = await getStudentLedger(b.tenant.id, a.student.id)
    expect(ledger.invoices).toHaveLength(0)
    expect(ledger.payments).toHaveLength(0)
    expect(ledger.adjustments).toHaveLength(0)
    expect((await getFeesSummary(b.tenant.id, a.student.id)).totalBilled).toBe(0)
    expect((await listInvoicesForStudent(b.tenant.id, a.student.id)).items).toHaveLength(0)
    expect((await listPayments(b.tenant.id, {})).items).toHaveLength(0)
    expect((await getDefaulters(b.tenant.id, {})).items).toHaveLength(0)
    expect((await applyCredit(b.tenant.id, b.owner.id, a.student.id)).allocated).toBe(0)
  })

  it('guardians cannot be attached to or removed from another tenant\'s student', async () => {
    const a = await seedFeeTenant()
    const b = await seedFeeTenant()
    await expect(addGuardian(b.tenant.id, a.student.id, { name: 'X', relation: 'Father', phone: '9999999999' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    const g = await addGuardian(a.tenant.id, a.student.id, { name: 'Y', relation: 'Mother', phone: '9999999999' })
    await expect(removeGuardian(b.tenant.id, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('student isolation — a student sees only their own money', () => {
  it('cannot fetch another student\'s receipt or tax invoice', async () => {
    const seeded = await seedFeeTenant({ extraStudents: 1, gst: {} })
    const { structure } = await publishStructure(seeded.tenant.id, seeded.owner.id, ONE)
    await assign(seeded.tenant.id, structure.id, seeded.cls.id)
    const [s1, s2] = seeded.students
    const { payment } = await recordPayment(seeded.tenant.id, seeded.owner.id, { studentId: s1.id, amount: 500, mode: 'cash', idempotencyKey: idemKey() })
    const [s1Invoice] = await invoicesOf(seeded.tenant.id, s1.id)

    await expect(getReceipt(seeded.tenant.id, payment.id, s2.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(renderTaxInvoice(seeded.tenant.id, s1Invoice.id, s2.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listStudentReceipts(seeded.tenant.id, s2.id, { limit: 50 })).items).toHaveLength(0)
    // …and the owner of the money can.
    expect((await getReceipt(seeded.tenant.id, payment.id, s1.id)).id).toBe(payment.id)
  })

  it('a reversed receipt disappears from the student\'s view but not the owner\'s', async () => {
    const ctx = await studentWithInvoices(ONE)
    const { payment } = await recordPayment(ctx.tenant.id, ctx.owner.id, { studentId: ctx.student.id, amount: 500, mode: 'cash', idempotencyKey: idemKey() })
    await reversePayment(ctx.tenant.id, ctx.owner.id, payment.id, 'wrong student')

    await expect(getReceipt(ctx.tenant.id, payment.id, ctx.student.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await listStudentReceipts(ctx.tenant.id, ctx.student.id, { limit: 50 })).items).toHaveLength(0)
    expect((await getReceipt(ctx.tenant.id, payment.id)).status).toBe('reversed')
  })
})
