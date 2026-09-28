// Shared setup for the fee suite: a tenant with a class of students, a
// published structure, and the fan-out run synchronously (the queue is mocked
// in test/setup.ts, so tests call the worker body directly).

import { and, asc, eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { feeInvoices, studentFeeAssignments } from '@modules/fee/fee.schema.js'
import {
  addStructureInstallment,
  addStructureItem,
  createFeeHead,
  createFeeStructure,
  publishFeeStructure,
  runAssignmentFanout,
  updateFeeSettings,
} from '@modules/fee/fee.service.js'
import { addDays, financialYearOf, todayIST } from '@modules/fee/fee.types.js'
import { setPlatformSetting, __clearPlatformCache } from '@modules/platform/platform.service.js'
import {
  createMembership,
  createTestClass,
  createTestUser,
  enrollStudent,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

let _seq = 0

export async function seedFeeTenant(opts: { extraStudents?: number; gst?: { placeOfSupplyCode?: string } } = {}) {
  const { tenant, owner, teacher, student } = await seedTenantWithUsers()
  const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
  const students = [student]
  for (let i = 0; i < (opts.extraStudents ?? 0); i++) {
    const s = await createTestUser()
    await createMembership({ userId: s.id, tenantId: tenant.id, role: 'student' })
    students.push(s)
  }
  for (const s of students) await enrollStudent({ classId: cls.id, studentId: s.id })

  if (opts.gst) {
    await updateFeeSettings(tenant.id, {
      gstMode: 'registered',
      gstin: '09ABCDE1234F1Z5',
      placeOfSupplyCode: opts.gst.placeOfSupplyCode ?? '09',
    })
  }
  return { tenant, owner, teacher, cls, students, student }
}

export interface StructureSpec {
  items: { amount: number; taxRatePct?: number | null; code?: string }[]
  /** Due dates as day offsets from today (negative = past). */
  installments: { label?: string; dueInDays: number; sharePct: number }[]
}

/**
 * Create heads + a structure and publish it. The academic year is derived from
 * the earliest due date, so relative due dates always pass publish validation
 * whatever day the suite runs on.
 */
export async function publishStructure(tenantId: string, ownerId: string, spec: StructureSpec) {
  const today = todayIST()
  const dueDates = spec.installments.map((i) => addDays(today, i.dueInDays))
  const academicYear = financialYearOf([...dueDates].sort()[0], 4)

  const structure = await createFeeStructure(tenantId, ownerId, { name: `Structure ${_seq++}`, academicYear })
  const heads = []
  for (const [idx, item] of spec.items.entries()) {
    const head = await createFeeHead(tenantId, {
      name: `Head ${idx}`,
      code: item.code ?? `H${_seq++}`,
      category: 'tuition',
      taxRatePct: item.taxRatePct ?? null,
    })
    heads.push(head)
    await addStructureItem(tenantId, structure.id, { headId: head.id, amount: item.amount, order: idx })
  }
  for (const [idx, inst] of spec.installments.entries()) {
    await addStructureInstallment(tenantId, structure.id, {
      seq: idx + 1,
      label: inst.label ?? `Installment ${idx + 1}`,
      dueDate: dueDates[idx],
      sharePct: inst.sharePct,
    })
  }
  const published = await publishFeeStructure(tenantId, structure.id)
  return { structure: published, heads, academicYear, dueDates }
}

export async function assign(tenantId: string, structureId: string, classId: string) {
  return runAssignmentFanout({ tenantId, structureId, classId })
}

export async function invoicesOf(tenantId: string, studentId: string) {
  return db.select().from(feeInvoices)
    .where(and(eq(feeInvoices.tenantId, tenantId), eq(feeInvoices.studentId, studentId)))
    .orderBy(asc(feeInvoices.dueDate), asc(feeInvoices.createdAt))
}

export async function invoiceById(id: string) {
  const [inv] = await db.select().from(feeInvoices).where(eq(feeInvoices.id, id))
  return inv
}

export async function assignmentOf(tenantId: string, studentId: string) {
  const [a] = await db.select().from(studentFeeAssignments)
    .where(and(eq(studentFeeAssignments.tenantId, tenantId), eq(studentFeeAssignments.studentId, studentId)))
  return a
}

/** The common case: one student, one head, installments as given, assigned. */
export async function studentWithInvoices(spec: StructureSpec, opts: Parameters<typeof seedFeeTenant>[0] = {}) {
  const seeded = await seedFeeTenant(opts)
  const { structure, heads } = await publishStructure(seeded.tenant.id, seeded.owner.id, spec)
  await assign(seeded.tenant.id, structure.id, seeded.cls.id)
  const invoices = await invoicesOf(seeded.tenant.id, seeded.student.id)
  return { ...seeded, structure, heads, invoices }
}

export async function setFeesEnabled(enabled: boolean) {
  await setPlatformSetting('fees_enabled', enabled, '00000000-0000-0000-0000-000000000000')
  __clearPlatformCache()
}

let _key = 0
export const idemKey = () => `test-key-${Date.now()}-${_key++}`
