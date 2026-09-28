// ─────────────────────────────────────────────────────────────────────────────
// Fee reports (LLD §14 Phase 5): daybook, defaulters, head-wise collection.
//
// The aggregates are raw SQL with explicit table aliases on purpose. Drizzle
// renders a column interpolated into a `sql` template UNQUALIFIED when the
// outer query has no join, which silently correlates a subquery to itself —
// valid SQL, no error, wrong numbers. Aliased raw SQL cannot do that.
// ─────────────────────────────────────────────────────────────────────────────

import { and, asc, eq, gte, lt, or } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { users } from '../auth/auth.schema.js'
import { feePayments } from './fee.schema.js'
import { getFeeSettings, pageSize, primaryGuardians } from './fee.service.js'
import { addDays, istDayStart, todayIST, type Paise } from './fee.types.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ── Daybook — the front desk's cash closing for one day ───────────────────────

/**
 * Everything that happened to money on one Indian calendar day. Bounded by
 * the day, so it is returned whole rather than paginated.
 *
 * `totalsByMode` counts only money still standing — recorded and not bounced —
 * because that is what the cash drawer and the bank should agree with. Pending
 * cheques are counted there too and also reported separately, since they are
 * not money yet.
 */
export async function getDaybook(tenantId: string, date: string = todayIST()) {
  if (!DATE_RE.test(date)) throw Errors.VALIDATION('date must be YYYY-MM-DD')
  const start = istDayStart(date)
  const end = istDayStart(addDays(date, 1))

  const rows = await db.select({
    id: feePayments.id,
    receiptNo: feePayments.receiptNo,
    studentId: feePayments.studentId,
    studentName: users.name,
    amount: feePayments.amount,
    mode: feePayments.mode,
    reference: feePayments.reference,
    receivedAt: feePayments.receivedAt,
    clearanceStatus: feePayments.clearanceStatus,
    status: feePayments.status,
    reversedAt: feePayments.reversedAt,
    reversalReason: feePayments.reversalReason,
    bouncedAt: feePayments.bouncedAt,
    bounceReason: feePayments.bounceReason,
  }).from(feePayments)
    .innerJoin(users, eq(feePayments.studentId, users.id))
    .where(and(
      eq(feePayments.tenantId, tenantId),
      or(
        and(gte(feePayments.receivedAt, start), lt(feePayments.receivedAt, end)),
        and(gte(feePayments.reversedAt, start), lt(feePayments.reversedAt, end)),
        and(gte(feePayments.bouncedAt, start), lt(feePayments.bouncedAt, end)),
      ),
    ))
    .orderBy(asc(feePayments.receivedAt), asc(feePayments.receiptNo))

  const inDay = (d: Date | null) => !!d && d >= start && d < end
  const collections = rows.filter((r) => inDay(r.receivedAt))
  const standing = collections.filter((r) => r.status === 'recorded' && r.clearanceStatus !== 'bounced')

  const totalsByMode: Record<string, Paise> = {}
  for (const r of standing) totalsByMode[r.mode] = (totalsByMode[r.mode] ?? 0) + r.amount

  return {
    date,
    collections,
    totalsByMode,
    totalCollected: standing.reduce((s, r) => s + r.amount, 0),
    pendingClearance: standing.filter((r) => r.clearanceStatus === 'pending').reduce((s, r) => s + r.amount, 0),
    reversals: rows.filter((r) => inDay(r.reversedAt)),
    bounces: rows.filter((r) => inDay(r.bouncedAt)),
  }
}

// ── Defaulters ────────────────────────────────────────────────────────────────

/**
 * Students with money overdue as of `asOf` (default today) — one row per
 * student, oldest debt first. Keyset-paginated on (oldestDueDate, studentId).
 * `classId` filters through the student's fee assignments, which is what
 * `student_fee_assignments.classId` is recorded for.
 */
export async function getDefaulters(tenantId: string, filter: { asOf?: string; classId?: string; cursor?: string; limit?: number }) {
  const asOf = filter.asOf ?? todayIST()
  if (!DATE_RE.test(asOf)) throw Errors.VALIDATION('asOf must be YYYY-MM-DD')
  const size = pageSize(filter.limit)

  const classFilter = filter.classId
    ? sql`AND i.student_id IN (SELECT a.student_id FROM student_fee_assignments a WHERE a.tenant_id = ${tenantId} AND a.class_id = ${filter.classId})`
    : sql``

  let having = sql``
  if (filter.cursor) {
    const [cDue, cId] = filter.cursor.split('_')
    if (DATE_RE.test(cDue ?? '') && cId) having = sql`HAVING (min(i.due_date), i.student_id) > (${cDue}::date, ${cId}::uuid)`
  }

  const base = sql`
    FROM fee_invoices i
    WHERE i.tenant_id = ${tenantId}
      AND i.status IN ('issued', 'partially_paid')
      AND i.due_date < ${asOf}::date
      ${classFilter}`

  const [page, totals] = await Promise.all([
    db.execute<{
      student_id: string
      name: string
      email: string | null
      phone_number: string | null
      invoice_count: number
      overdue_amount: string
      oldest_due_date: string
    }>(sql`
      SELECT i.student_id, u.name, u.email, u.phone_number,
             count(*)::int AS invoice_count,
             sum(i.total_amount - i.paid_amount - i.waived_amount) AS overdue_amount,
             to_char(min(i.due_date), 'YYYY-MM-DD') AS oldest_due_date
      FROM fee_invoices i
      JOIN users u ON u.id = i.student_id
      WHERE i.tenant_id = ${tenantId}
        AND i.status IN ('issued', 'partially_paid')
        AND i.due_date < ${asOf}::date
        ${classFilter}
      GROUP BY i.student_id, u.name, u.email, u.phone_number
      ${having}
      ORDER BY min(i.due_date) ASC, i.student_id ASC
      LIMIT ${size + 1}`),
    db.execute<{ students: number; overdue: string | null }>(sql`
      SELECT count(DISTINCT i.student_id)::int AS students,
             sum(i.total_amount - i.paid_amount - i.waived_amount) AS overdue
      ${base}`),
  ])

  const rows = page.rows
  const hasMore = rows.length > size
  const items = hasMore ? rows.slice(0, size) : rows
  const guardians = await primaryGuardians(tenantId, items.map((r) => r.student_id))
  const last = items.at(-1)

  return {
    asOf,
    totalStudents: totals.rows[0]?.students ?? 0,
    totalOverdue: Number(totals.rows[0]?.overdue ?? 0),
    items: items.map((r) => {
      const g = guardians.get(r.student_id)
      return {
        studentId: r.student_id,
        name: r.name,
        email: r.email,
        phone: r.phone_number,
        invoiceCount: r.invoice_count,
        overdueAmount: Number(r.overdue_amount),
        oldestDueDate: r.oldest_due_date,
        daysOverdue: Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${r.oldest_due_date}T00:00:00Z`)) / 86_400_000),
        guardian: g ? { name: g.name, relation: g.relation, phone: g.phone, email: g.email } : null,
      }
    }),
    nextCursor: hasMore && last ? `${last.oldest_due_date}_${last.student_id}` : null,
  }
}

// ── Head-wise collection ──────────────────────────────────────────────────────

/**
 * Billed / collected / waived / outstanding per fee head for one academic
 * year. Installment invoices count by their assignment's academic year;
 * charge invoices (late fees etc.) by the financial year they were issued in.
 *
 * Allocations are per invoice, not per head, so collection is attributed to
 * heads pro rata by each line's share of the invoice total — the standard
 * treatment, and the only one that needs no per-head allocation rows. Summed
 * in numeric and rounded once per head.
 */
export async function getHeadWiseCollection(tenantId: string, academicYear: string) {
  if (!/^\d{4}(-\d{2})?$/.test(academicYear)) throw Errors.VALIDATION('academicYear must look like "2026-27"')
  const settings = await getFeeSettings(tenantId)
  const startYear = Number(academicYear.slice(0, 4))
  const fyStart = `${startYear}-${String(settings.financialYearStartMonth).padStart(2, '0')}-01`
  const fyEnd = `${startYear + 1}-${String(settings.financialYearStartMonth).padStart(2, '0')}-01`

  const result = await db.execute<{
    head_id: string
    code: string
    name: string
    category: string
    gross: string
    concession: string
    tax: string
    billed: string
    collected: string
    waived: string
  }>(sql`
    SELECT h.id AS head_id, h.code, h.name, h.category,
           sum(it.gross_amount) AS gross,
           sum(it.concession_amount) AS concession,
           sum(it.tax_amount) AS tax,
           sum(it.total_amount) AS billed,
           round(sum(CASE WHEN i.total_amount > 0 THEN it.total_amount::numeric * i.paid_amount / i.total_amount ELSE 0 END)) AS collected,
           round(sum(CASE WHEN i.total_amount > 0 THEN it.total_amount::numeric * i.waived_amount / i.total_amount ELSE 0 END)) AS waived
    FROM fee_invoice_items it
    JOIN fee_invoices i ON i.id = it.invoice_id
    JOIN fee_heads h ON h.id = it.head_id
    LEFT JOIN student_fee_assignments a ON a.id = i.assignment_id
    WHERE i.tenant_id = ${tenantId}
      AND i.status NOT IN ('cancelled', 'draft')
      AND (
        a.academic_year = ${academicYear}
        OR (i.assignment_id IS NULL AND i.issue_date >= ${fyStart}::date AND i.issue_date < ${fyEnd}::date)
      )
    GROUP BY h.id, h.code, h.name, h.category
    ORDER BY h.name ASC`)

  const heads = result.rows.map((r) => {
    const billed = Number(r.billed)
    const collected = Number(r.collected)
    const waived = Number(r.waived)
    return {
      headId: r.head_id,
      code: r.code,
      name: r.name,
      category: r.category,
      grossAmount: Number(r.gross),
      concessionAmount: Number(r.concession),
      taxAmount: Number(r.tax),
      billed,
      collected,
      waived,
      outstanding: billed - collected - waived,
    }
  })

  const total = (k: 'billed' | 'collected' | 'waived' | 'outstanding' | 'concessionAmount' | 'taxAmount') => heads.reduce((s, h) => s + h[k], 0)
  return {
    academicYear,
    heads,
    totals: {
      billed: total('billed'),
      collected: total('collected'),
      waived: total('waived'),
      outstanding: total('outstanding'),
      concessionAmount: total('concessionAmount'),
      taxAmount: total('taxAmount'),
    },
  }
}

// ── Payments list ─────────────────────────────────────────────────────────────

/** GET /tenant/fees/payments — newest first, keyset on (createdAt, id). */
export async function listPayments(tenantId: string, filter: {
  from?: string
  to?: string
  mode?: string
  studentId?: string
  cursor?: string
  limit?: number
}) {
  const size = pageSize(filter.limit)
  const conditions = [eq(feePayments.tenantId, tenantId)]
  if (filter.from) {
    if (!DATE_RE.test(filter.from)) throw Errors.VALIDATION('from must be YYYY-MM-DD')
    conditions.push(gte(feePayments.receivedAt, istDayStart(filter.from)))
  }
  if (filter.to) {
    if (!DATE_RE.test(filter.to)) throw Errors.VALIDATION('to must be YYYY-MM-DD')
    conditions.push(lt(feePayments.receivedAt, istDayStart(addDays(filter.to, 1))))
  }
  if (filter.mode) conditions.push(eq(feePayments.mode, filter.mode))
  if (filter.studentId) conditions.push(eq(feePayments.studentId, filter.studentId))
  if (filter.cursor) {
    const [ts, id] = filter.cursor.split('_')
    const at = new Date(ts)
    if (!isNaN(at.getTime()) && id) {
      conditions.push(sql`(${feePayments.createdAt}, ${feePayments.id}) < (${at.toISOString()}, ${id})`)
    }
  }

  // Join users so the list is readable without N lookups — and because a
  // joined query is one drizzle qualifies its columns in.
  const rows = await db.select({ payment: feePayments, studentName: users.name })
    .from(feePayments)
    .innerJoin(users, eq(feePayments.studentId, users.id))
    .where(and(...conditions))
    .orderBy(sql`${feePayments.createdAt} DESC`, sql`${feePayments.id} DESC`)
    .limit(size + 1)

  const hasMore = rows.length > size
  const items = (hasMore ? rows.slice(0, size) : rows).map(({ payment, studentName }) => {
    const { documentSnapshot: _omit, ...rest } = payment
    return { ...rest, studentName }
  })
  const last = items.at(-1)
  return { items, nextCursor: hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null }
}
