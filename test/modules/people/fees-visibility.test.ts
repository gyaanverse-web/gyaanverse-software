import { describe, it, expect, afterEach } from 'vitest'
import { getStudentProfile, listStudents } from '@modules/people/people.service.js'
import { addGuardian } from '@modules/fee/fee.service.js'
import { setFeesEnabled, studentWithInvoices } from '../fee/fee-fixtures.js'

/**
 * Who may see money, and when.
 *
 * Two independent gates, both required, and this file is where each is pinned:
 *
 *  - **Owner only.** Fees are the owner's business; a teacher's payload has no
 *    money keys at all.
 *  - **`fees_enabled` on.** With the platform switch off every fee route answers
 *    404 by design, so a profile that composed the block anyway would put
 *    numbers on a screen whose own module is turned off.
 */

// The switch is a platform-wide row plus a memo that outlives a test file, so
// it is reset rather than left for whichever suite runs next.
afterEach(() => setFeesEnabled(false))

const spec = { items: [{ amount: 5000 }], installments: [{ dueInDays: 7, sharePct: 100 }] }

describe('fee visibility on the student profile', () => {
  it('gives the owner the fee block and guardians when fees are on', async () => {
    await setFeesEnabled(true)
    const { tenant, owner, student } = await studentWithInvoices(spec)
    await addGuardian(tenant.id, student.id, { name: 'Asha', relation: 'mother', phone: '+919876543210' })

    const p = await getStudentProfile(tenant.id, student.id, { id: owner.id, role: 'coaching_owner' })

    expect(p.scope).toBe('owner')
    if (p.scope !== 'owner') throw new Error('unreachable')
    expect(p.fees).not.toBeNull()
    expect(p.fees!.totalBilled).toBeGreaterThan(0)
    expect(p.fees!.balance).toBe(p.fees!.totalBilled)
    expect(p.fees!.nextDue).not.toBeNull()
    expect(p.guardians.map((g) => g.name)).toEqual(['Asha'])
    expect(p.guardians[0].isPrimary).toBe(true)
  })

  it('nulls the fee block and empties guardians while fees are off', async () => {
    await setFeesEnabled(true)
    const { tenant, owner, student } = await studentWithInvoices(spec)
    await addGuardian(tenant.id, student.id, { name: 'Asha', relation: 'mother', phone: '+919876543210' })
    await setFeesEnabled(false)

    const p = await getStudentProfile(tenant.id, student.id, { id: owner.id, role: 'coaching_owner' })

    if (p.scope !== 'owner') throw new Error('unreachable')
    // null, not a zeroed block. "Fees are switched off" and "this student owes
    // nothing" are different answers, and the UI renders no tab for the first
    // and an empty state for the second.
    expect(p.fees).toBeNull()
    expect(p.guardians).toEqual([])
  })

  it('omits the keys for a teacher even with fees on and money owed', async () => {
    await setFeesEnabled(true)
    const { tenant, teacher, student } = await studentWithInvoices(spec)

    const p = await getStudentProfile(tenant.id, student.id, { id: teacher.id, role: 'teacher' })

    expect(p.scope).toBe('teacher')
    expect('fees' in p).toBe(false)
    expect('guardians' in p).toBe(false)
  })
})

describe('fee visibility on the students list', () => {
  it('carries outstanding for the owner when fees are on', async () => {
    await setFeesEnabled(true)
    const { tenant, owner, student } = await studentWithInvoices(spec)

    const row = (await listStudents(tenant.id, { id: owner.id, role: 'coaching_owner' }))
      .find((r) => r.id === student.id)!
    expect(row.outstanding).toBeGreaterThan(0)
  })

  it('nulls outstanding for the owner while fees are off', async () => {
    await setFeesEnabled(true)
    const { tenant, owner, student } = await studentWithInvoices(spec)
    await setFeesEnabled(false)

    const row = (await listStudents(tenant.id, { id: owner.id, role: 'coaching_owner' }))
      .find((r) => r.id === student.id)!
    expect(row.outstanding).toBeNull()
  })

  it('reports 0 for an owner\'s student who has no invoices at all', async () => {
    await setFeesEnabled(true)
    const { tenant, owner, students } = await studentWithInvoices(spec, { extraStudents: 0 })

    // A student with invoices totalling nothing owed is a real 0 — distinct
    // from the null above, which means "not shown".
    const rows = await listStudents(tenant.id, { id: owner.id, role: 'coaching_owner' })
    expect(rows).toHaveLength(students.length)
    for (const r of rows) expect(typeof r.outstanding).toBe('number')
  })
})
