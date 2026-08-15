import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { tenants, tenantSettings } from '@modules/tenant/tenant.schema.js'
import { memberships } from '@modules/membership/membership.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { classes, classMembers } from '@modules/class/class.schema.js'
import {
  registerCoaching,
  deleteCoaching,
  removeMember,
  getMyTenant,
} from '@modules/tenant/tenant.service.js'
import {
  createTestUser,
  createTestTenant,
  createTestClass,
  enrollStudent,
  createMembership,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

describe('registerCoaching', () => {
  it('creates tenant + settings + owner membership + updates user role atomically', async () => {
    const owner = await createTestUser({ role: 'student', emailVerified: true })
    const result = await registerCoaching(owner.id, { slug: 'newcoaching', name: 'New Coaching' })

    expect(result.tenant.slug).toBe('newcoaching')
    expect(result.tenant.ownerId).toBe(owner.id)

    // Settings row created
    const [settings] = await db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, result.tenant.id))
    expect(settings).toBeDefined()

    // Membership row created with coaching_owner role
    const [m] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, owner.id))
    expect(m.role).toBe('coaching_owner')
    expect(m.tenantId).toBe(result.tenant.id)

    // User row updated
    const [u] = await db.select().from(users).where(eq(users.id, owner.id))
    expect(u.role).toBe('coaching_owner')
    expect(u.tenantId).toBe(result.tenant.id)
  })

  it('rejects unverified users', async () => {
    const owner = await createTestUser({ emailVerified: false })
    await expect(
      registerCoaching(owner.id, { slug: 'unverified', name: 'Unverified' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_VERIFIED', statusCode: 403 })
  })

  it('rejects reserved slugs', async () => {
    const owner = await createTestUser({ emailVerified: true })
    for (const slug of ['admin', 'www', 'auth', 'cdn', 'staging', 'secure', 'billing', 'gyaanverse']) {
      await expect(
        registerCoaching(owner.id, { slug, name: `Reserved ${slug}` }),
      ).rejects.toMatchObject({ code: 'RESERVED_SLUG' })
    }
  })

  it('rejects duplicate slugs', async () => {
    const a = await createTestUser({ emailVerified: true })
    const b = await createTestUser({ emailVerified: true })
    await registerCoaching(a.id, { slug: 'sharma-classes', name: 'Sharma' })

    await expect(
      registerCoaching(b.id, { slug: 'sharma-classes', name: 'Other Sharma' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects an owner who already owns a coaching', async () => {
    const owner = await createTestUser({ emailVerified: true })
    await registerCoaching(owner.id, { slug: 'first', name: 'First' })

    await expect(
      registerCoaching(owner.id, { slug: 'second', name: 'Second' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects invalid slug formats', async () => {
    const owner = await createTestUser({ emailVerified: true })
    await expect(
      registerCoaching(owner.id, { slug: 'Has Spaces', name: 'Bad' }),
    ).rejects.toMatchObject({ code: 'INVALID_SLUG' })
  })

  // These all used to be accepted and would have produced a tenant on an
  // unreachable hostname (or, for xn--, a homograph-spoofable one).
  it('rejects slugs that are not valid DNS labels', async () => {
    const owner = await createTestUser({ emailVerified: true })
    for (const slug of ['-leading', 'trailing-', '-', 'ab', 'xn--80ak6aa92e']) {
      await expect(
        registerCoaching(owner.id, { slug, name: `Bad ${slug}` }),
      ).rejects.toMatchObject({ code: 'INVALID_SLUG' })
    }
  })
})

describe('deleteCoaching', () => {
  it('only the owner can delete', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    await expect(deleteCoaching(tenant.id, teacher.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('cascades classes, class members, memberships, settings, and resets users', async () => {
    const { tenant, owner, teacher, student } = await seedTenantWithUsers()

    // Add some real content to verify cascades
    const cls = await createTestClass({ tenantId: tenant.id, teacherId: teacher.id })
    await enrollStudent({ classId: cls.id, studentId: student.id })

    await deleteCoaching(tenant.id, owner.id)

    // Tenant gone
    const tenantRows = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(tenantRows).toHaveLength(0)

    // Settings gone
    const settingsRows = await db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenant.id))
    expect(settingsRows).toHaveLength(0)

    // Memberships gone
    const membershipRows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenant.id))
    expect(membershipRows).toHaveLength(0)

    // Classes gone
    const classRows = await db.select().from(classes).where(eq(classes.tenantId, tenant.id))
    expect(classRows).toHaveLength(0)

    // Class members gone
    const classMemberRows = await db
      .select()
      .from(classMembers)
      .where(eq(classMembers.classId, cls.id))
    expect(classMemberRows).toHaveLength(0)

    // Member users reset to student + tenantId = null
    const [resetStudent] = await db.select().from(users).where(eq(users.id, student.id))
    expect(resetStudent.tenantId).toBeNull()
    expect(resetStudent.role).toBe('student')

    const [resetOwner] = await db.select().from(users).where(eq(users.id, owner.id))
    expect(resetOwner.tenantId).toBeNull()
    expect(resetOwner.role).toBe('student')
  })

  it("doesn't touch other tenants' data", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const bClass = await createTestClass({ tenantId: b.tenant.id, teacherId: b.teacher.id })

    await deleteCoaching(a.tenant.id, a.owner.id)

    // B's tenant still there
    const bRows = await db.select().from(tenants).where(eq(tenants.id, b.tenant.id))
    expect(bRows).toHaveLength(1)

    // B's class still there
    const classRows = await db.select().from(classes).where(eq(classes.id, bClass.id))
    expect(classRows).toHaveLength(1)
  })
})

describe('removeMember', () => {
  it('owner can remove a teacher', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    const result = await removeMember(tenant.id, teacher.id, owner.id)
    expect(result.success).toBe(true)

    const rows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, teacher.id))
    expect(rows).toHaveLength(0)
  })

  it('blocks self-removal', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    await expect(removeMember(tenant.id, owner.id, owner.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('blocks removing the coaching_owner', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    await expect(removeMember(tenant.id, owner.id, teacher.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it("only clears users.tenantId if it still pointed to this tenant", async () => {
    // User belongs to tenant A; they later joined tenant B and users.tenantId
    // now points to B. Removing them from A must NOT clear their B linkage.
    const a = await seedTenantWithUsers()
    const b = await createTestTenant()
    await createMembership({ userId: a.student.id, tenantId: b.id, role: 'student' })
    await db.update(users).set({ tenantId: b.id }).where(eq(users.id, a.student.id))

    await removeMember(a.tenant.id, a.student.id, a.owner.id)

    const [u] = await db.select().from(users).where(eq(users.id, a.student.id))
    expect(u.tenantId).toBe(b.id) // unchanged
  })
})

describe('getMyTenant', () => {
  it('returns null when the user has no memberships', async () => {
    const user = await createTestUser()
    expect(await getMyTenant(user.id)).toBeNull()
  })

  it('returns the tenant for a member', async () => {
    const { tenant, student } = await seedTenantWithUsers()
    const result = await getMyTenant(student.id)
    expect(result?.tenant.id).toBe(tenant.id)
  })

  // Clients gate tenant-scoped UI on this value rather than the global session
  // role, so it has to reflect the caller's membership in *this* coaching.
  it('CRITICAL: reports the caller\'s role within the coaching', async () => {
    const { owner, teacher, student } = await seedTenantWithUsers()
    expect((await getMyTenant(owner.id))?.membershipRole).toBe('coaching_owner')
    expect((await getMyTenant(teacher.id))?.membershipRole).toBe('teacher')
    expect((await getMyTenant(student.id))?.membershipRole).toBe('student')
  })
})
