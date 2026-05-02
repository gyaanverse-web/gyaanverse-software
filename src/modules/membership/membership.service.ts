import { eq, and, sql, desc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { memberships, coachingJoinCodes } from './membership.schema.js'
import { users } from '../auth/auth.schema.js'
import { getTenantById } from '../tenant/tenant.service.js'
import { assertWithinLimit } from '../billing/billing.service.js'

// ── Coaching join codes ─────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous 0/O, 1/I

async function generateUniqueCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
    const [existing] = await db.select({ id: coachingJoinCodes.id }).from(coachingJoinCodes).where(eq(coachingJoinCodes.code, code)).limit(1)
    if (!existing) return code
  }
  throw new AppError('INTERNAL_ERROR', 'Failed to generate a unique join code, try again', 500)
}

export async function generateCoachingJoinCode(
  tenantId: string,
  createdBy: string,
  options?: { expiresAt?: Date; maxUses?: number },
) {
  const code = await generateUniqueCode()
  const [record] = await db
    .insert(coachingJoinCodes)
    .values({
      tenantId,
      createdBy,
      code,
      expiresAt: options?.expiresAt ?? null,
      maxUses: options?.maxUses ?? 9999,
    })
    .returning()
  return record
}

export async function listCoachingJoinCodes(tenantId: string) {
  return db
    .select()
    .from(coachingJoinCodes)
    .where(and(eq(coachingJoinCodes.tenantId, tenantId), eq(coachingJoinCodes.revoked, false)))
    .orderBy(desc(coachingJoinCodes.createdAt))
}

export async function revokeCoachingJoinCode(tenantId: string, codeId: string) {
  const [record] = await db
    .select({ id: coachingJoinCodes.id })
    .from(coachingJoinCodes)
    .where(and(eq(coachingJoinCodes.id, codeId), eq(coachingJoinCodes.tenantId, tenantId)))
    .limit(1)
  if (!record) throw Errors.NOT_FOUND('Join code')

  await db.update(coachingJoinCodes).set({ revoked: true }).where(eq(coachingJoinCodes.id, codeId))
  return { success: true }
}

export async function previewCoachingJoinCode(code: string) {
  const [record] = await db
    .select()
    .from(coachingJoinCodes)
    .where(eq(coachingJoinCodes.code, code))
    .limit(1)

  if (!record) throw Errors.NOT_FOUND('Join code')
  if (record.revoked) throw new AppError('JOIN_CODE_REVOKED', 'This join code has been revoked', 400)
  if (record.expiresAt && new Date() > record.expiresAt) throw new AppError('JOIN_CODE_EXPIRED', 'This join code has expired', 400)
  if (record.usedCount >= record.maxUses) throw new AppError('JOIN_CODE_EXHAUSTED', 'This join code has reached its usage limit', 400)

  const tenant = await getTenantById(record.tenantId)
  if (!tenant) throw Errors.NOT_FOUND('Coaching')
  return { tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, logoUrl: tenant.logoUrl } }
}

export async function useCoachingJoinCode(userId: string, code: string) {
  const [record] = await db
    .select()
    .from(coachingJoinCodes)
    .where(eq(coachingJoinCodes.code, code))
    .limit(1)

  if (!record) throw Errors.NOT_FOUND('Join code')
  if (record.revoked) throw new AppError('JOIN_CODE_REVOKED', 'This join code has been revoked', 400)
  if (record.expiresAt && new Date() > record.expiresAt) throw new AppError('JOIN_CODE_EXPIRED', 'This join code has expired', 400)
  if (record.usedCount >= record.maxUses) throw new AppError('JOIN_CODE_EXHAUSTED', 'This join code has reached its usage limit', 400)

  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, record.tenantId)))
    .limit(1)
  if (existing) throw new AppError('ALREADY_MEMBER', 'You are already a member of this coaching', 409)

  await assertWithinLimit(record.tenantId, 'students')

  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ userId, tenantId: record.tenantId, role: 'student' })
    await tx.update(users).set({ tenantId: record.tenantId }).where(eq(users.id, userId))
    await tx
      .update(coachingJoinCodes)
      .set({ usedCount: sql`${coachingJoinCodes.usedCount} + 1` })
      .where(eq(coachingJoinCodes.id, record.id))
  })

  const tenant = await getTenantById(record.tenantId)
  return { success: true, role: 'student', tenant }
}

