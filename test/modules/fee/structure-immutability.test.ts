import { describe, it, expect } from 'vitest'
import {
  addStructureInstallment,
  addStructureItem,
  assignStructureToClass,
  getFeeStructureDetail,
  publishFeeStructure,
  reviseFeeStructure,
} from '@modules/fee/fee.service.js'
import { addDays, todayIST } from '@modules/fee/fee.types.js'
import { assignmentOf, invoicesOf, studentWithInvoices } from './fee-fixtures.js'

const ONE = { items: [{ amount: 10000 }], installments: [{ dueInDays: 10, sharePct: 100 }] }

describe('published structures are immutable (§4)', () => {
  it('editing a published structure is refused', async () => {
    const { tenant, structure, heads } = await studentWithInvoices(ONE)
    await expect(addStructureItem(tenant.id, structure.id, { headId: heads[0].id, amount: 500 }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(addStructureInstallment(tenant.id, structure.id, { seq: 2, label: 'Extra', dueDate: addDays(todayIST(), 50), sharePct: 10 }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('revise creates version 2 as a draft copy and supersedes version 1', async () => {
    const { tenant, owner, structure } = await studentWithInvoices(ONE)
    const v2 = await reviseFeeStructure(tenant.id, structure.id, owner.id)

    expect(v2.version).toBe(2)
    expect(v2.status).toBe('draft')
    const v1 = await getFeeStructureDetail(tenant.id, structure.id)
    expect(v1.structure.supersededById).toBe(v2.id)
    const copy = await getFeeStructureDetail(tenant.id, v2.id)
    expect(copy.items).toHaveLength(v1.items.length)
    expect(copy.installments).toHaveLength(v1.installments.length)

    await expect(assignStructureToClass(tenant.id, structure.id, 'c3b1a9f8-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('raising the fee in v2 leaves v1 assignments and invoices untouched', async () => {
    const { tenant, owner, student, structure, heads } = await studentWithInvoices(ONE)
    const before = await invoicesOf(tenant.id, student.id)

    const v2 = await reviseFeeStructure(tenant.id, structure.id, owner.id)
    await addStructureItem(tenant.id, v2.id, { headId: heads[0].id, amount: 2500 })
    await publishFeeStructure(tenant.id, v2.id)

    const after = await invoicesOf(tenant.id, student.id)
    expect(after.map((i) => i.totalAmount)).toEqual(before.map((i) => i.totalAmount))
    expect((await assignmentOf(tenant.id, student.id)).grossAmount).toBe(1_000_000)
  })

  it('a superseded structure cannot be revised again', async () => {
    const { tenant, owner, structure } = await studentWithInvoices(ONE)
    await reviseFeeStructure(tenant.id, structure.id, owner.id)
    await expect(reviseFeeStructure(tenant.id, structure.id, owner.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
