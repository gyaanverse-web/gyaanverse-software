import { describe, it, expect } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireTenantRole, requireRole } from '@middleware/auth.middleware.js'
import { AppError } from '@shared/errors.js'
import {
  createMembership,
  createTestTenant,
  createTestUser,
  seedTenantWithUsers,
} from '../helpers/fixtures.js'

// Build a stub req with whatever shape the middleware reads. We only need
// `.user` and `.tenant` on it — not a full FastifyRequest.
function fakeReq(opts: { user?: any; tenant?: any } = {}) {
  return { ...opts } as unknown as FastifyRequest
}
const noopReply = {} as FastifyReply

describe('requireTenantRole', () => {
  it('allows a user with the matching role in this tenant', async () => {
    const { tenant, owner } = await seedTenantWithUsers()
    const mw = requireTenantRole('coaching_owner')

    await expect(
      mw(fakeReq({ user: { id: owner.id, role: 'coaching_owner' }, tenant }), noopReply),
    ).resolves.toBeUndefined()
  })

  it('rejects a user without a membership in this tenant', async () => {
    const { tenant } = await seedTenantWithUsers()
    // Outsider — exists but has no membership row for this tenant.
    const outsider = await createTestUser({ role: 'student' })
    const mw = requireTenantRole('coaching_owner', 'teacher', 'student')

    await expect(
      mw(fakeReq({ user: { id: outsider.id, role: 'student' }, tenant }), noopReply),
    ).rejects.toMatchObject({ name: 'AppError', code: 'FORBIDDEN', statusCode: 403 })
  })

  it('rejects a member with the wrong role for this route', async () => {
    const { tenant, teacher } = await seedTenantWithUsers()
    const ownerOnly = requireTenantRole('coaching_owner')

    await expect(
      ownerOnly(fakeReq({ user: { id: teacher.id, role: 'teacher' }, tenant }), noopReply),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  // The critical multi-tenant isolation test: a user who is a `coaching_owner`
  // of tenant A must NOT pass `requireTenantRole('coaching_owner')` when the
  // resolved tenant on the request is tenant B.
  it('CRITICAL: blocks cross-tenant access even with matching global role', async () => {
    const a = await seedTenantWithUsers()
    const b = await seedTenantWithUsers()
    const mw = requireTenantRole('coaching_owner')

    // a.owner authenticated, but request is scoped to tenant B
    await expect(
      mw(fakeReq({ user: { id: a.owner.id, role: 'coaching_owner' }, tenant: b.tenant }), noopReply),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('respects the actual membership.role, not the global users.role', async () => {
    // User is a `student` in tenant A globally, but holds a `teacher`
    // membership in tenant B. Should pass teacher checks in B.
    const a = await seedTenantWithUsers()
    const b = await createTestTenant()
    await createMembership({ userId: a.student.id, tenantId: b.id, role: 'teacher' })

    const teacherOk = requireTenantRole('teacher')

    await expect(
      teacherOk(fakeReq({ user: { id: a.student.id, role: 'student' }, tenant: b }), noopReply),
    ).resolves.toBeUndefined()
  })

  it('throws UNAUTHORIZED when req.user is missing', async () => {
    const mw = requireTenantRole('coaching_owner')
    await expect(mw(fakeReq({ tenant: { id: 'x' } }), noopReply)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('throws TENANT_REQUIRED when req.tenant is missing', async () => {
    const mw = requireTenantRole('coaching_owner')
    await expect(
      mw(fakeReq({ user: { id: '00000000-0000-0000-0000-000000000000', role: 'coaching_owner' } }), noopReply),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('requireRole (global)', () => {
  it('allows when the global role matches', async () => {
    const mw = requireRole('super_admin')
    await expect(
      mw(fakeReq({ user: { id: 'x', role: 'super_admin' } }), noopReply),
    ).resolves.toBeUndefined()
  })

  it('rejects when the global role does not match', async () => {
    const mw = requireRole('super_admin')
    await expect(
      mw(fakeReq({ user: { id: 'x', role: 'coaching_owner' } }), noopReply),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects with 401 when user is missing entirely', async () => {
    const mw = requireRole('super_admin')
    await expect(mw(fakeReq(), noopReply)).rejects.toBeInstanceOf(AppError)
  })
})
