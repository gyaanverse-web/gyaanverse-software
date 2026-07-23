import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { memberships, coachingJoinCodes } from '@modules/membership/membership.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import {
  useCoachingJoinCode,
  previewCoachingJoinCode,
} from '@modules/membership/membership.service.js'
import { PLANS } from '@config/plans.js'
import {
  createTestUser,
  createTestCoachingJoinCode,
  seedTenantWithUsers,
  createMembership,
} from '../../helpers/fixtures.js'

describe('useCoachingJoinCode', () => {
  it('happy path: inserts membership, updates user, increments usedCount', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const student = await createTestUser({ role: 'student' })
    const code = await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'TESTCODE',
    })

    const result = await useCoachingJoinCode(student.id, 'TESTCODE')
    expect(result.success).toBe(true)
    expect(result.role).toBe('student')

    // Membership inserted
    const [m] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, student.id))
    expect(m.role).toBe('student')
    expect(m.tenantId).toBe(tenant.id)

    // User updated
    const [u] = await db.select().from(users).where(eq(users.id, student.id))
    expect(u.tenantId).toBe(tenant.id)

    // usedCount bumped
    const [c] = await db
      .select()
      .from(coachingJoinCodes)
      .where(eq(coachingJoinCodes.id, code.id))
    expect(c.usedCount).toBe(1)
  })

  it('rejects an unknown code', async () => {
    const student = await createTestUser()
    await expect(useCoachingJoinCode(student.id, 'NOSUCH')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects a revoked code', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const student = await createTestUser()
    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'REVOKED1',
      revoked: true,
    })

    await expect(useCoachingJoinCode(student.id, 'REVOKED1')).rejects.toMatchObject({
      code: 'JOIN_CODE_REVOKED',
    })
  })

  it('rejects an expired code', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const student = await createTestUser()
    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'EXPIRED1',
      expiresAt: new Date(Date.now() - 60_000),
    })

    await expect(useCoachingJoinCode(student.id, 'EXPIRED1')).rejects.toMatchObject({
      code: 'JOIN_CODE_EXPIRED',
    })
  })

  it('rejects a fully-used code', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const student = await createTestUser()
    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'USED1',
      maxUses: 5,
      usedCount: 5,
    })

    await expect(useCoachingJoinCode(student.id, 'USED1')).rejects.toMatchObject({
      code: 'JOIN_CODE_EXHAUSTED',
    })
  })

  it('rejects double-membership (same coaching, same user)', async () => {
    const { tenant, owner, student } = await seedTenantWithUsers()
    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'DUPCODE',
    })

    await expect(useCoachingJoinCode(student.id, 'DUPCODE')).rejects.toMatchObject({
      code: 'ALREADY_MEMBER',
    })
  })

  it('CRITICAL: enforces students plan limit', async () => {
    // Fill the tenant to its free-plan student cap (30), then try to join.
    const { tenant, owner } = await seedTenantWithUsers('free')
    const limit = PLANS.free.limits.students // 30, seed already has 1

    for (let i = 0; i < limit - 1; i++) {
      const u = await createTestUser()
      await createMembership({ userId: u.id, tenantId: tenant.id, role: 'student' })
    }

    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'OVERCAP',
    })

    const overflowStudent = await createTestUser()
    await expect(useCoachingJoinCode(overflowStudent.id, 'OVERCAP')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
    })

    // And: usedCount was NOT bumped (rejection happens before the transaction)
    const [c] = await db
      .select()
      .from(coachingJoinCodes)
      .where(eq(coachingJoinCodes.code, 'OVERCAP'))
    expect(c.usedCount).toBe(0)
  })
})

describe('previewCoachingJoinCode', () => {
  it('returns coaching info for a valid code', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'PREVIEW1',
    })

    const result = await previewCoachingJoinCode('PREVIEW1')
    expect(result.tenant.id).toBe(tenant.id)
    expect(result.tenant.slug).toBe(tenant.slug)
  })

  it('rejects revoked codes (does not leak tenant info)', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    await createTestCoachingJoinCode({
      tenantId: tenant.id,
      createdBy: owner.id,
      code: 'REVOKED2',
      revoked: true,
    })

    await expect(previewCoachingJoinCode('REVOKED2')).rejects.toMatchObject({
      code: 'JOIN_CODE_REVOKED',
    })
  })
})
