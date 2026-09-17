import { eq, and, inArray, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { tenants } from './tenant.schema.js'
import { memberships, coachingJoinCodes } from '../membership/membership.schema.js'
import { classes, classMembers, joinCodes } from '../class/class.schema.js'
import { exams } from '../exam/exam.schema.js'
import { users } from '../auth/auth.schema.js'
import { assertWithinLimit } from '../billing/billing.service.js'
import { type PlanName } from '../../config/plans.js'
import { slugRejectionReason, isReservedSlug } from '../../config/reserved-slugs.js'
import type { Tenant } from './tenant.types.js'

function toTenant(row: { status: string } & Omit<Tenant, 'status'>): Tenant {
  if (row.status !== 'active' && row.status !== 'suspended') {
    throw new AppError('INVALID_TENANT_STATUS', 'Invalid tenant status', 500)
  }
  return { ...row, status: row.status }
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1)
  return row ? toTenant(row) : null
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  return row ? toTenant(row) : null
}

async function validateSlug(slug: string): Promise<void> {
  const reason = slugRejectionReason(slug)
  if (reason) {
    // Reserved is a namespace collision (409); anything else is a malformed
    // value the caller can fix by editing the field (422).
    if (isReservedSlug(slug)) throw new AppError('RESERVED_SLUG', reason, 409)
    throw new AppError('INVALID_SLUG', reason, 422)
  }
  const [existing] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1)
  if (existing) throw Errors.CONFLICT('That slug is already taken')
}

export async function createTenant(data: { slug: string; name: string; ownerId: string }): Promise<Tenant> {
  const slug = data.slug.toLowerCase()
  await validateSlug(slug)

  return db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ slug, name: data.name, ownerId: data.ownerId }).returning()
    return toTenant(tenant)
  })
}

// ── Register a new coaching institute ──────────────────────────────────────

export async function registerCoaching(ownerId: string, data: { slug: string; name: string }) {
  const slug = data.slug.toLowerCase()
  await validateSlug(slug)

  const [owner] = await db
    .select({ emailVerified: users.emailVerified, phoneNumberVerified: users.phoneNumberVerified })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1)
  if (!owner || (!owner.emailVerified && !owner.phoneNumberVerified)) {
    throw new AppError(
      'IDENTITY_NOT_VERIFIED',
      'Verify your email (check your inbox for a verification link) or phone number before creating a coaching institute',
      403,
    )
  }

  // One person may own more than one coaching (D-1: multi-tenancy audit F-9).
  // `memberships` already enforces "one owner per tenant" via the tenant's
  // single `coaching_owner` membership row; nothing here needs to limit how
  // many tenants a single user owns.
  return db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values({ slug, name: data.name, ownerId }).returning()
    await tx.insert(memberships).values({ userId: ownerId, tenantId: tenant.id, role: 'coaching_owner' })
    return { tenant: toTenant(tenant) }
  })
}

// ── Add a teacher to the coaching ──────────────────────────────────────────

export async function addTeacher(tenantId: string, phone: string) {
  const [teacher] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1)
  if (!teacher) {
    throw new AppError(
      'USER_NOT_FOUND',
      'No user found with that phone number. Ask them to sign in first.',
      404,
    )
  }

  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, teacher.id), eq(memberships.tenantId, tenantId)))
    .limit(1)
  if (existing) throw Errors.CONFLICT('User is already a member of this coaching')

  await assertWithinLimit(tenantId, 'teachers')

  await db.insert(memberships).values({ userId: teacher.id, tenantId, role: 'teacher' })

  return { id: teacher.id, name: teacher.name, phone: teacher.phoneNumber, role: 'teacher' }
}

// ── Student joins a coaching ────────────────────────────────────────────────

export async function joinAsStudent(userId: string, tenantId: string) {
  const tenant = await getTenantById(tenantId)
  if (!tenant) throw Errors.NOT_FOUND('Coaching')
  if (tenant.status !== 'active') throw new AppError('TENANT_SUSPENDED', 'This coaching is suspended', 403)

  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
    .limit(1)
  if (existing) throw Errors.CONFLICT('Already a member of this coaching')

  await assertWithinLimit(tenantId, 'students')

  await db.insert(memberships).values({ userId, tenantId, role: 'student' })

  return { success: true }
}

// ── Get the coaching the current user belongs to ────────────────────────────

async function oldestMembership(userId: string) {
  const [row] = await db
    .select({ tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt, memberships.tenantId)
    .limit(1)
  return row ?? null
}

/**
 * The coaching the user belongs to, plus **the role they hold in it**.
 *
 * `membershipRole` is the authoritative role for anything tenant-scoped. It is
 * NOT the same as `user.accountRole` on the session, which is platform-level
 * only (`super_admin` or the default `student`) and never describes a role
 * held inside any particular coaching.
 * Clients must gate tenant UI on this value, mirroring `requireTenantRole` on
 * the server, or they will show owner-only screens to a non-owner.
 *
 * `slug` is the coaching the browser is on (subdomain / X-Tenant-Slug). When
 * there is one, the answer is the membership in **that** coaching and nothing
 * else — every other request from that page is authorised against it, so
 * describing a different coaching would give the page the wrong name, role and
 * entitlements. It never falls back to another membership:
 *   - member of no coaching at all  → null (404), the ordinary "no coaching yet"
 *   - member elsewhere, not here (or no such coaching) → 403 NOT_A_MEMBER, so
 *     the client sends them to their own coaching instead of offering to
 *     create one
 *
 * With no slug (the app host, where reserved slugs like the frontend's `dev`
 * placeholder also land) there is no coaching to prefer: the oldest membership
 * wins, so the answer is at least stable between requests.
 */
export async function getMyTenant(
  userId: string,
  slug?: string,
): Promise<{ tenant: Tenant; membershipRole: string } | null> {
  if (slug && !isReservedSlug(slug)) {
    const tenant = await getTenantBySlug(slug)
    const [row] = tenant
      ? await db
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenant.id)))
          .limit(1)
      : []
    if (tenant && row) return { tenant, membershipRole: row.role }
    if (!(await oldestMembership(userId))) return null
    throw new AppError('NOT_A_MEMBER', 'You are not a member of this coaching', 403)
  }

  const row = await oldestMembership(userId)
  if (!row) return null
  const tenant = await getTenantById(row.tenantId)
  return tenant ? { tenant, membershipRole: row.role } : null
}

/**
 * Every coaching the user belongs to, oldest first — the data behind a tenant
 * switcher. `getMyTenant` (above) answers "which ONE coaching"; this answers
 * "which coachings, plural", for the app-host case where there is no subdomain
 * to prefer among them.
 */
export async function listMyMemberships(
  userId: string,
): Promise<Array<{ tenant: Tenant; membershipRole: string }>> {
  const rows = await db
    .select({ tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(memberships.createdAt, memberships.tenantId)

  if (rows.length === 0) return []

  const tenantRows = await db.select().from(tenants).where(inArray(tenants.id, rows.map((r) => r.tenantId)))
  const tenantById = new Map(tenantRows.map((t) => [t.id, toTenant(t)]))

  return rows
    .map((r) => {
      const tenant = tenantById.get(r.tenantId)
      return tenant ? { tenant, membershipRole: r.role } : null
    })
    .filter((r): r is { tenant: Tenant; membershipRole: string } => r !== null)
}

// ── List members of a coaching ──────────────────────────────────────────────

export async function listMembers(tenantId: string, role?: string) {
  const condition = role
    ? and(eq(memberships.tenantId, tenantId), eq(memberships.role, role))
    : eq(memberships.tenantId, tenantId)

  return db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      name: users.name,
      phone: users.phoneNumber,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(condition)
}

/**
 * Owner-facing teachers roster with per-teacher workload: how many batches each
 * teacher owns, how many approved students sit across those batches, and how
 * many exams they have authored. Aggregated in three grouped queries (no
 * per-teacher round-trips) rather than one giant join, so the student and exam
 * counts don't multiply each other.
 */
export async function listTeachersWithWorkload(tenantId: string) {
  const teachers = await db
    .select({
      userId: memberships.userId,
      name: users.name,
      email: users.email,
      phone: users.phoneNumber,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'teacher')))

  if (teachers.length === 0) return []

  const teacherIds = teachers.map((t) => t.userId)

  const classAgg = await db
    .select({
      teacherId: classes.teacherId,
      classCount: sql<number>`count(distinct ${classes.id})`.mapWith(Number),
      studentCount: sql<number>`count(distinct ${classMembers.studentId}) filter (where ${classMembers.status} = 'approved')`.mapWith(Number),
    })
    .from(classes)
    .leftJoin(classMembers, eq(classMembers.classId, classes.id))
    .where(and(eq(classes.tenantId, tenantId), inArray(classes.teacherId, teacherIds)))
    .groupBy(classes.teacherId)

  const examAgg = await db
    .select({
      createdBy: exams.createdBy,
      examCount: sql<number>`count(*)`.mapWith(Number),
    })
    .from(exams)
    .where(and(eq(exams.tenantId, tenantId), inArray(exams.createdBy, teacherIds)))
    .groupBy(exams.createdBy)

  const classByTeacher = new Map(classAgg.map((c) => [c.teacherId, c]))
  const examByTeacher = new Map(examAgg.map((e) => [e.createdBy, e]))

  return teachers.map((t) => ({
    ...t,
    classCount: classByTeacher.get(t.userId)?.classCount ?? 0,
    studentCount: classByTeacher.get(t.userId)?.studentCount ?? 0,
    examCount: examByTeacher.get(t.userId)?.examCount ?? 0,
  }))
}

// ── Update coaching details ─────────────────────────────────────────────────

export async function updateTenant(
  tenantId: string,
  requesterId: string,
  data: { name?: string; logoUrl?: string | null },
): Promise<Tenant> {
  const tenant = await getTenantById(tenantId)
  if (!tenant) throw Errors.NOT_FOUND('Coaching')
  if (tenant.ownerId !== requesterId) throw Errors.FORBIDDEN()

  const [updated] = await db
    .update(tenants)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId))
    .returning()
  return toTenant(updated)
}

// ── Delete a coaching institute ─────────────────────────────────────────────

export async function deleteCoaching(tenantId: string, requesterId: string): Promise<void> {
  const tenant = await getTenantById(tenantId)
  if (!tenant) throw Errors.NOT_FOUND('Coaching')
  if (tenant.ownerId !== requesterId) throw Errors.FORBIDDEN()

  await db.transaction(async (tx) => {
    // Remove class-level data before deleting classes
    const tenantClasses = await tx
      .select({ id: classes.id })
      .from(classes)
      .where(eq(classes.tenantId, tenantId))

    const classIds = tenantClasses.map((c) => c.id)
    if (classIds.length > 0) {
      await tx.delete(classMembers).where(inArray(classMembers.classId, classIds))
      await tx.delete(joinCodes).where(inArray(joinCodes.classId, classIds))
    }

    await tx.delete(classes).where(eq(classes.tenantId, tenantId))
    await tx.delete(memberships).where(eq(memberships.tenantId, tenantId))
    await tx.delete(coachingJoinCodes).where(eq(coachingJoinCodes.tenantId, tenantId))
    // invites cascade automatically (onDelete: 'cascade' on invites.tenantId)
    await tx.delete(tenants).where(eq(tenants.id, tenantId))
  })
}

// ── Change the tenant's plan ────────────────────────────────────────────────

export async function upgradePlan(tenantId: string, requesterId: string, plan: PlanName): Promise<Tenant> {
  const tenant = await getTenantById(tenantId)
  if (!tenant) throw Errors.NOT_FOUND('Coaching')
  if (tenant.ownerId !== requesterId) throw Errors.FORBIDDEN()

  const [updated] = await db
    .update(tenants)
    .set({ plan, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId))
    .returning()
  return toTenant(updated)
}

// ── Remove a member from the coaching ──────────────────────────────────────

export async function removeMember(tenantId: string, targetUserId: string, requesterId: string) {
  if (targetUserId === requesterId) throw new AppError('FORBIDDEN', 'Cannot remove yourself', 403)

  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, targetUserId), eq(memberships.tenantId, tenantId)))
    .limit(1)
  if (!membership) throw Errors.NOT_FOUND('Membership')
  if (membership.role === 'coaching_owner') {
    throw new AppError('FORBIDDEN', 'Cannot remove the coaching owner', 403)
  }

  await db
    .delete(memberships)
    .where(and(eq(memberships.userId, targetUserId), eq(memberships.tenantId, tenantId)))

  return { success: true }
}
