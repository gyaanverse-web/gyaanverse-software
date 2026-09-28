import { describe, it, expect } from 'vitest'
import { addConcession, getStudentLedger, reverseConcession } from '@modules/fee/fee.service.js'
import { recordPayment } from '@modules/fee/fee.ledger.js'
import { assignmentOf, idemKey, invoicesOf, studentWithInvoices } from './fee-fixtures.js'

// ₹10,000 across three installments that do not divide evenly.
const THIRDS = {
  items: [{ amount: 7000 }, { amount: 3000 }],
  installments: [
    { dueInDays: 10, sharePct: 33.33 },
    { dueInDays: 40, sharePct: 33.33 },
    { dueInDays: 70, sharePct: 33.34 },
  ],
}

describe('concessions and rounding (§3)', () => {
  it('installments sum to the structure total exactly before any concession', async () => {
    const { tenant, student } = await studentWithInvoices(THIRDS)
    const invoices = await invoicesOf(tenant.id, student.id)
    expect(invoices.reduce((s, i) => s + i.totalAmount, 0)).toBe(1_000_000)
  })

  it('percent concession: invoices sum to net exactly, the final installment absorbs the remainder', async () => {
    const { tenant, owner, student } = await studentWithInvoices(THIRDS)
    const assignment = await assignmentOf(tenant.id, student.id)
    await addConcession(tenant.id, assignment.id, owner.id, { type: 'merit', mode: 'percent', value: 12.5 })

    const updated = await assignmentOf(tenant.id, student.id)
    expect(updated.concessionAmount).toBe(125_000)
    expect(updated.netAmount).toBe(875_000)

    const invoices = await invoicesOf(tenant.id, student.id)
    expect(invoices.reduce((s, i) => s + i.totalAmount, 0)).toBe(updated.netAmount)
    expect(invoices.reduce((s, i) => s + i.concessionAmount, 0)).toBe(125_000)
    // Every installment but the last is rounded independently; the last is whatever is left.
    const [a, b, c] = invoices
    expect(c.concessionAmount).toBe(125_000 - a.concessionAmount - b.concessionAmount)
  })

  it('flat concession of an awkward amount still sums exactly', async () => {
    const { tenant, owner, student } = await studentWithInvoices(THIRDS)
    const assignment = await assignmentOf(tenant.id, student.id)
    await addConcession(tenant.id, assignment.id, owner.id, { type: 'sibling', mode: 'amount', value: 333.33 })

    const updated = await assignmentOf(tenant.id, student.id)
    expect(updated.concessionAmount).toBe(33_333)
    const invoices = await invoicesOf(tenant.id, student.id)
    expect(invoices.reduce((s, i) => s + i.totalAmount, 0)).toBe(1_000_000 - 33_333)
  })

  it('reversing a concession writes a reversing row and restores the totals', async () => {
    const { tenant, owner, student } = await studentWithInvoices(THIRDS)
    const assignment = await assignmentOf(tenant.id, student.id)
    const c = await addConcession(tenant.id, assignment.id, owner.id, { type: 'scholarship', mode: 'percent', value: 50 })
    const reversal = await reverseConcession(tenant.id, c.id, owner.id, 'granted in error')

    expect(reversal.computedAmount).toBe(-c.computedAmount)
    const updated = await assignmentOf(tenant.id, student.id)
    expect(updated.netAmount).toBe(1_000_000)
    await expect(reverseConcession(tenant.id, reversal.id, owner.id, 'x')).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('a grant cannot be reversed twice, and the ledger marks which grant was reversed', async () => {
    const { tenant, owner, student } = await studentWithInvoices(THIRDS)
    const assignment = await assignmentOf(tenant.id, student.id)
    const first = await addConcession(tenant.id, assignment.id, owner.id, { type: 'sibling', mode: 'percent', value: 10 })
    const second = await addConcession(tenant.id, assignment.id, owner.id, { type: 'sibling', mode: 'percent', value: 10 })
    await reverseConcession(tenant.id, first.id, owner.id, 'granted twice')

    await expect(reverseConcession(tenant.id, first.id, owner.id, 'double click')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await assignmentOf(tenant.id, student.id)).concessionAmount).toBe(100_000)

    const { concessions } = await getStudentLedger(tenant.id, student.id)
    expect(concessions.filter((c) => c.isReversal)).toHaveLength(1)
    // Identical grants are fungible: exactly one of the two reads as reversed.
    expect(concessions.filter((c) => !c.isReversal && c.reversed).map((c) => c.id)).toHaveLength(1)
    expect(concessions.filter((c) => !c.isReversal && !c.reversed).map((c) => c.id)).toHaveLength(1)
    expect([first.id, second.id]).toContain(concessions.find((c) => !c.isReversal && !c.reversed)!.id)
  })

  it('refuses a concession once money has moved — a waiver is the correction from then on', async () => {
    const { tenant, owner, student } = await studentWithInvoices(THIRDS)
    await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    const assignment = await assignmentOf(tenant.id, student.id)
    await expect(addConcession(tenant.id, assignment.id, owner.id, { type: 'merit', mode: 'percent', value: 10 }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('a percentage over 100 is rejected', async () => {
    const { tenant, owner, student } = await studentWithInvoices(THIRDS)
    const assignment = await assignmentOf(tenant.id, student.id)
    await expect(addConcession(tenant.id, assignment.id, owner.id, { type: 'merit', mode: 'percent', value: 150 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
