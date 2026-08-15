import { describe, it, expect, beforeEach } from 'vitest'
import {
  assertWithinLimit,
  assertHasFeature,
  isWithinLimit,
  hasFeature,
  resolveEntitlements,
} from '@modules/billing/billing.service.js'
import { setPlatformSetting, __clearPlatformCache } from '@modules/platform/platform.service.js'
import { PLANS } from '@config/plans.js'
import {
  createMembership,
  createTestClass,
  createTestExam,
  createTestUser,
  seedTenantWithUsers,
  createTestTenant,
} from '../../helpers/fixtures.js'

/**
 * Every assertion below is about what happens WHEN BILLING IS ON, which is not
 * the platform default — `billing_enabled` defaults to false so that the MVP
 * ships unmetered. Without this the whole file passes vacuously: the assert
 * helpers short-circuit before they ever count anything, and each
 * `.rejects.toMatchObject` fails with "resolved undefined instead of rejecting".
 *
 * The cache clear matters as much as the write. `platform.service` memoises for
 * 15s, which is far longer than a test file takes to run, so a suite that only
 * inserted the row would read whatever the previous file left behind.
 */
beforeEach(async () => {
  await setPlatformSetting('billing_enabled', true, SYSTEM_ACTOR)
  __clearPlatformCache()
})

/** `platform_settings.updated_by` has no FK, so a sentinel is fine here. */
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000'

describe('assertWithinLimit — students', () => {
  it('allows when under the plan limit', async () => {
    const { tenant } = await seedTenantWithUsers('free') // limit: 30

    // seedTenantWithUsers already created 1 student membership; well under 30.
    await expect(assertWithinLimit(tenant.id, 'students')).resolves.toBeUndefined()
  })

  it('throws PLAN_LIMIT_EXCEEDED when at the cap', async () => {
    const { tenant } = await seedTenantWithUsers('free')
    const limit = PLANS.free.limits.students // 30 — the seed creates 1, need 29 more to fill

    // Top up to exactly the limit
    for (let i = 0; i < limit - 1; i++) {
      const u = await createTestUser({ role: 'student' })
      await createMembership({ userId: u.id, tenantId: tenant.id, role: 'student' })
    }

    expect(await isWithinLimit(tenant.id, 'students')).toBe(false)
    await expect(assertWithinLimit(tenant.id, 'students')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      statusCode: 403,
    })
  })

  it("doesn't count students from other tenants", async () => {
    const a = await seedTenantWithUsers('free')
    const b = await seedTenantWithUsers('free')

    // Add 50 students to tenant B
    for (let i = 0; i < 50; i++) {
      const u = await createTestUser({ role: 'student' })
      await createMembership({ userId: u.id, tenantId: b.tenant.id, role: 'student' })
    }

    // Tenant A still has 1 student; should be well under its own 30 limit.
    await expect(assertWithinLimit(a.tenant.id, 'students')).resolves.toBeUndefined()
  })
})

describe('assertWithinLimit — teachers', () => {
  it('counts only teacher-role memberships', async () => {
    const { tenant } = await seedTenantWithUsers('free') // teacher limit: 5

    // Add 3 more teachers (1 already from seed → 4 total, still under 5)
    for (let i = 0; i < 3; i++) {
      const u = await createTestUser({ role: 'teacher' })
      await createMembership({ userId: u.id, tenantId: tenant.id, role: 'teacher' })
    }

    await expect(assertWithinLimit(tenant.id, 'teachers')).resolves.toBeUndefined()

    // Add 1 more → 5 total → at the cap → should reject
    const fifth = await createTestUser({ role: 'teacher' })
    await createMembership({ userId: fifth.id, tenantId: tenant.id, role: 'teacher' })

    await expect(assertWithinLimit(tenant.id, 'teachers')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
    })
  })
})

describe('assertWithinLimit — classes', () => {
  it('counts only this tenant\'s classes', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('free') // limit: 5
    const other = await seedTenantWithUsers('free')

    // Fill the other tenant — should not affect us
    for (let i = 0; i < 5; i++) {
      await createTestClass({ tenantId: other.tenant.id, teacherId: other.teacher.id })
    }

    await expect(assertWithinLimit(tenant.id, 'classes')).resolves.toBeUndefined()

    // Fill our tenant exactly
    for (let i = 0; i < 5; i++) {
      await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    }

    await expect(assertWithinLimit(tenant.id, 'classes')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
    })
  })
})

describe('assertWithinLimit — plan tiers', () => {
  it('starter tier allows more students than free', async () => {
    const { tenant } = await seedTenantWithUsers('starter') // limit: 100

    // Add 50 students; free would reject, starter should allow
    for (let i = 0; i < 50; i++) {
      const u = await createTestUser({ role: 'student' })
      await createMembership({ userId: u.id, tenantId: tenant.id, role: 'student' })
    }
    await expect(assertWithinLimit(tenant.id, 'students')).resolves.toBeUndefined()
  })

  it('pro tier has practically-unlimited caps', async () => {
    const { tenant } = await seedTenantWithUsers('pro')
    // Don't actually create 99999 rows — just trust the math
    expect(await isWithinLimit(tenant.id, 'students')).toBe(true)
    expect(await isWithinLimit(tenant.id, 'teachers')).toBe(true)
    expect(await isWithinLimit(tenant.id, 'classes')).toBe(true)
  })
})

describe('assertHasFeature', () => {
  it('throws FEATURE_GATED on free for analytics', async () => {
    const tenant = await createTestTenant({ plan: 'free' })
    expect(await hasFeature(tenant.id, 'analytics')).toBe(false)
    await expect(assertHasFeature(tenant.id, 'analytics')).rejects.toMatchObject({
      code: 'FEATURE_NOT_AVAILABLE',
      statusCode: 403,
    })
  })

  it('allows analytics on growth and pro', async () => {
    const growth = await createTestTenant({ plan: 'growth' })
    const pro = await createTestTenant({ plan: 'pro' })

    await expect(assertHasFeature(growth.id, 'analytics')).resolves.toBeUndefined()
    await expect(assertHasFeature(pro.id, 'analytics')).resolves.toBeUndefined()
  })

  it('only pro has custom_branding', async () => {
    const starter = await createTestTenant({ plan: 'starter' })
    const growth = await createTestTenant({ plan: 'growth' })
    const pro = await createTestTenant({ plan: 'pro' })

    await expect(assertHasFeature(starter.id, 'custom_branding')).rejects.toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' })
    await expect(assertHasFeature(growth.id, 'custom_branding')).rejects.toMatchObject({ code: 'FEATURE_NOT_AVAILABLE' })
    await expect(assertHasFeature(pro.id, 'custom_branding')).resolves.toBeUndefined()
  })
})

describe('mocks_per_month limit', () => {
  // The quota counts papers SUBMITTED for review this month, not exams created.
  // The wizard opens a draft row on the teacher's first click, so counting
  // creations would bill the coaching for every abandoned attempt.
  it('counts papers submitted in the current calendar month', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('free') // 3 mocks/month
    for (let i = 0; i < 3; i++) {
      await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'under_review' })
    }
    await expect(assertWithinLimit(tenant.id, 'mocks_per_month')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
    })
  })

  it('CRITICAL: unsubmitted drafts do not count against the quota', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('free')
    for (let i = 0; i < 10; i++) {
      await createTestExam({ tenantId: tenant.id, createdBy: teacher.id, status: 'draft' })
    }
    await expect(assertWithinLimit(tenant.id, 'mocks_per_month')).resolves.toBeUndefined()
  })

  it('ignores papers submitted in an earlier month', async () => {
    const { tenant, teacher } = await seedTenantWithUsers('free')
    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1, 15)
    for (let i = 0; i < 5; i++) {
      await createTestExam({
        tenantId: tenant.id, createdBy: teacher.id, status: 'live', submittedAt: lastMonth,
      })
    }
    await expect(assertWithinLimit(tenant.id, 'mocks_per_month')).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The other half of the switch: what the resolver answers with billing OFF.
//
// These override the file-level `beforeEach`, and they are the tests that would
// have caught a regression in the MVP posture — every case above is about
// enforcement, so all of them stay green if the switch silently stops working.
// ─────────────────────────────────────────────────────────────────────────────

describe('billing disabled', () => {
  beforeEach(async () => {
    await setPlatformSetting('billing_enabled', false, SYSTEM_ACTOR)
    __clearPlatformCache()
  })

  it('enforces no limit, however far past the cap the tenant is', async () => {
    const { tenant } = await seedTenantWithUsers('free') // students limit: 30
    for (let i = 0; i < PLANS.free.limits.students; i++) {
      const u = await createTestUser({ role: 'student' })
      await createMembership({ userId: u.id, tenantId: tenant.id, role: 'student' })
    }

    await expect(assertWithinLimit(tenant.id, 'students')).resolves.toBeUndefined()
  })

  it('gates no feature, on any plan', async () => {
    const free = await createTestTenant({ plan: 'free' })

    await expect(assertHasFeature(free.id, 'custom_branding')).resolves.toBeUndefined()
    await expect(assertHasFeature(free.id, 'api_access')).resolves.toBeUndefined()
    expect(await hasFeature(free.id, 'public_mocks')).toBe(true)
  })

  it("leaves the tenant's stored plan alone, so enabling billing restores it", async () => {
    const tenant = await createTestTenant({ plan: 'growth' })

    const off = await resolveEntitlements(tenant.id)
    expect(off.billingEnabled).toBe(false)
    expect(off.limits.students).toBe(99999)

    await setPlatformSetting('billing_enabled', true, SYSTEM_ACTOR)
    __clearPlatformCache()

    const on = await resolveEntitlements(tenant.id)
    expect(on.billingEnabled).toBe(true)
    expect(on.plan.name).toBe('growth')
    expect(on.limits.students).toBe(PLANS.growth.limits.students)
  })
})
