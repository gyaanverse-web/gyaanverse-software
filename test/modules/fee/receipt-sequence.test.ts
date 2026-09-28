import { describe, it, expect } from 'vitest'
import { recordPayment, reversePayment } from '@modules/fee/fee.ledger.js'
import { getFeeSettings } from '@modules/fee/fee.service.js'
import { financialYearOf, todayIST } from '@modules/fee/fee.types.js'
import { idemKey, seedFeeTenant } from './fee-fixtures.js'

const seqOf = (receiptNo: string) => Number(receiptNo.split('/').at(-1))

describe('gap-free receipt numbering (§10)', () => {
  it('50 concurrent payments get 50 contiguous receipt numbers — no gaps, no duplicates', async () => {
    const { tenant, owner, student } = await seedFeeTenant()

    const results = await Promise.all(Array.from({ length: 50 }, () =>
      recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })))

    const numbers = results.map((r) => seqOf(r.payment.receiptNo)).sort((a, b) => a - b)
    expect(new Set(numbers).size).toBe(50)
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  }, 60_000)

  it('formats as PREFIX/FY/NNNNN from tenant settings', async () => {
    const { tenant, owner, student } = await seedFeeTenant()
    const settings = await getFeeSettings(tenant.id)
    const { payment } = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    const fy = financialYearOf(todayIST(), 4)
    expect(payment.receiptNo).toBe(`${settings.receiptPrefix}/${fy}/00001`)
    expect(payment.financialYear).toBe(fy)
  })

  it('sequences are per tenant', async () => {
    const a = await seedFeeTenant()
    const b = await seedFeeTenant()
    const pa = await recordPayment(a.tenant.id, a.owner.id, { studentId: a.student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    const pb = await recordPayment(b.tenant.id, b.owner.id, { studentId: b.student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    expect(seqOf(pa.payment.receiptNo)).toBe(1)
    expect(seqOf(pb.payment.receiptNo)).toBe(1)
  })

  it('a reversed receipt keeps its number and the next payment does not reuse it (§5.3)', async () => {
    const { tenant, owner, student } = await seedFeeTenant()
    const first = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })
    const reversed = await reversePayment(tenant.id, owner.id, first.payment.id, 'keyed against the wrong student')
    const next = await recordPayment(tenant.id, owner.id, { studentId: student.id, amount: 100, mode: 'cash', idempotencyKey: idemKey() })

    expect(reversed.receiptNo).toBe(first.payment.receiptNo)
    expect(reversed.status).toBe('reversed')
    expect(seqOf(next.payment.receiptNo)).toBe(2)
  })
})
