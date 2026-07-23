import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { invites } from '@modules/invite/invite.schema.js'
import { memberships } from '@modules/membership/membership.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { acceptInvite, revokeInvite } from '@modules/invite/invite.service.js'
import {
  createTestInvite,
  createTestUser,
  seedTenantWithUsers,
} from '../../helpers/fixtures.js'

describe('acceptInvite', () => {
  it('happy path: inserts membership, updates user, marks invite accepted — all atomic', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const teacherUser = await createTestUser({ email: 'teach@x.com' })
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'teach@x.com',
    })

    const result = await acceptInvite(teacherUser.id, invite.token)
    expect(result.success).toBe(true)
    expect(result.role).toBe('teacher')

    // Membership inserted
    const [m] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, teacherUser.id))
    expect(m.role).toBe('teacher')
    expect(m.tenantId).toBe(tenant.id)

    // User row updated
    const [u] = await db.select().from(users).where(eq(users.id, teacherUser.id))
    expect(u.role).toBe('teacher')
    expect(u.tenantId).toBe(tenant.id)

    // Invite marked accepted
    const [i] = await db.select().from(invites).where(eq(invites.id, invite.id))
    expect(i.status).toBe('accepted')
  })

  it('rejects an unknown token', async () => {
    const user = await createTestUser()
    await expect(acceptInvite(user.id, 'nope-not-a-real-token')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects an already-used invite', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const user = await createTestUser({ email: 'taken@x.com' })
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'taken@x.com',
      status: 'accepted',
    })

    await expect(acceptInvite(user.id, invite.token)).rejects.toMatchObject({
      code: 'INVITE_ALREADY_USED',
    })
  })

  it('rejects a revoked invite', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const user = await createTestUser({ email: 'r@x.com' })
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'r@x.com',
      status: 'revoked',
    })

    await expect(acceptInvite(user.id, invite.token)).rejects.toMatchObject({
      code: 'INVITE_ALREADY_USED', // service uses the same code for any non-pending state
    })
  })

  it('rejects an expired invite', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const user = await createTestUser({ email: 'exp@x.com' })
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'exp@x.com',
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    })

    await expect(acceptInvite(user.id, invite.token)).rejects.toMatchObject({
      code: 'INVITE_EXPIRED',
    })
  })

  it('CRITICAL: rejects when accepting user\'s contact does not match invite', async () => {
    // Privilege-escalation prevention: someone else's account must NOT be
    // usable to consume an invite issued to a different email/phone.
    const { tenant, owner } = await seedTenantWithUsers()
    const invitee = await createTestUser({ email: 'intended@x.com' })
    const attacker = await createTestUser({ email: 'attacker@x.com' })

    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'intended@x.com',
    })

    await expect(acceptInvite(attacker.id, invite.token)).rejects.toMatchObject({
      code: 'INVITE_CONTACT_MISMATCH',
      statusCode: 403,
    })

    // Invitee can still accept it — the invite wasn't consumed
    const result = await acceptInvite(invitee.id, invite.token)
    expect(result.success).toBe(true)
  })

  it('matches by phone when contactType=phone', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const user = await createTestUser({ phoneNumber: '+919999999999' })
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: '+919999999999',
      contactType: 'phone',
    })

    const result = await acceptInvite(user.id, invite.token)
    expect(result.success).toBe(true)
  })

  it('rejects users who are already members of the coaching', async () => {
    const { tenant, owner, teacher } = await seedTenantWithUsers()
    // teacher already has a membership; try to consume an invite anyway
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: teacher.email!,
    })

    await expect(acceptInvite(teacher.id, invite.token)).rejects.toMatchObject({
      code: 'ALREADY_MEMBER',
    })
  })
})

describe('revokeInvite', () => {
  it('marks a pending invite as revoked', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'v@x.com',
    })

    await revokeInvite(tenant.id, invite.id)
    const [i] = await db.select().from(invites).where(eq(invites.id, invite.id))
    expect(i.status).toBe('revoked')
  })

  it('refuses to revoke an already-accepted invite', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const invite = await createTestInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      contact: 'a@x.com',
      status: 'accepted',
    })

    await expect(revokeInvite(tenant.id, invite.id)).rejects.toMatchObject({
      code: 'INVITE_NOT_PENDING',
    })
  })

  it("CRITICAL: tenant A cannot revoke tenant B's invite", async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const inviteInB = await createTestInvite({
      tenantId: b.tenant.id,
      invitedBy: b.owner.id,
      contact: 'x@y.com',
    })

    await expect(revokeInvite(a.tenant.id, inviteInB.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
