import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { feeInvoiceItems } from '@modules/fee/fee.schema.js'
import { addConcession } from '@modules/fee/fee.service.js'
import { renderTaxInvoice } from '@modules/fee/fee.receipt.js'
import { splitGst } from '@modules/fee/fee.types.js'
import { assignmentOf, invoicesOf, studentWithInvoices } from './fee-fixtures.js'

// One ₹10,000 line on an 18% head, one installment.
const TAXED = { items: [{ amount: 10000, taxRatePct: 18 }], installments: [{ dueInDays: 10, sharePct: 100 }] }

describe('GST (§4 tenant_fee_settings.gstMode)', () => {
  it("gstMode='none' produces zero tax and no invoiceNo, even on a head with a rate", async () => {
    const { invoices } = await studentWithInvoices(TAXED)
    expect(invoices[0].taxAmount).toBe(0)
    expect(invoices[0].totalAmount).toBe(1_000_000)
    expect(invoices[0].invoiceNo).toBeNull()
    const [item] = await db.select().from(feeInvoiceItems).where(eq(feeInvoiceItems.invoiceId, invoices[0].id))
    expect(item.taxRatePct).toBeNull()
  })

  it("gstMode='none' refuses to print a tax invoice", async () => {
    const { tenant, invoices } = await studentWithInvoices(TAXED)
    await expect(renderTaxInvoice(tenant.id, invoices[0].id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it("gstMode='registered' numbers the invoice and taxes it", async () => {
    const { invoices } = await studentWithInvoices(TAXED, { gst: {} })
    expect(invoices[0].invoiceNo).toMatch(/\/INV\/\d{4}-\d{2}\/00001$/)
    expect(invoices[0].taxAmount).toBe(180_000)
    expect(invoices[0].totalAmount).toBe(1_180_000)
  })

  it('taxes AFTER the concession, with the correct CGST/SGST split on the discounted line (§13.5)', async () => {
    const { tenant, owner, student } = await studentWithInvoices(TAXED, { gst: {} })
    const assignment = await assignmentOf(tenant.id, student.id)
    await addConcession(tenant.id, assignment.id, owner.id, { type: 'merit', mode: 'percent', value: 10 })

    const [invoice] = await invoicesOf(tenant.id, student.id)
    expect(invoice.taxableAmount).toBe(900_000)
    expect(invoice.taxAmount).toBe(162_000)
    expect(invoice.totalAmount).toBe(1_062_000)

    const doc = await renderTaxInvoice(tenant.id, invoice.id)
    expect(doc.supplyType).toBe('intra_state')
    expect(doc.totals).toMatchObject({ taxableAmount: 900_000, cgst: 81_000, sgst: 81_000, igst: 0, totalAmount: 1_062_000 })
    expect(doc.supplier.gstin).toBe('09ABCDE1234F1Z5')
  })

  it('an inter-state place of supply is IGST', async () => {
    const { tenant, invoices } = await studentWithInvoices(TAXED, { gst: { placeOfSupplyCode: '27' } })
    const doc = await renderTaxInvoice(tenant.id, invoices[0].id)
    expect(doc.supplyType).toBe('inter_state')
    expect(doc.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 180_000 })
  })

  it('an odd tax amount splits without losing a paisa', () => {
    expect(splitGst(101, true)).toEqual({ cgst: 51, sgst: 50, igst: 0 })
    expect(splitGst(101, false)).toEqual({ cgst: 0, sgst: 0, igst: 101 })
  })
})
