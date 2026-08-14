import type { FastifyRequest, FastifyReply } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { fromNodeHeaders } from 'better-auth/node'
import { AppError, Errors } from '../shared/errors.js'
import { auth } from '../config/auth.js'
import { db } from '../shared/db.js'
import { memberships } from '../modules/membership/membership.schema.js'
import type { Role } from '../modules/auth/auth.types.js'

export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
  if (!session) throw Errors.UNAUTHORIZED()
  req.user = { id: session.user.id, role: ((session.user as { role?: Role }).role ?? 'student') as Role }
  // When the operator actually signed in — not when the session was last refreshed.
  // Better Auth extends `expiresAt` on activity but leaves `createdAt` alone, which
  // is the only reason a "re-authenticate every N hours" rule can mean anything:
  // read off `expiresAt` instead and a session stays valid forever as long as
  // somebody keeps using it. Consumed by `internalAuth` (middleware/internal.ts);
  // published here rather than re-fetched there so the cap costs no extra query.
  req.sessionCreatedAt = session.session?.createdAt ?? undefined
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    if (!roles.includes(req.user.role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions', 403)
    }
  }
}

// Checks the user's role in the resolved tenant's memberships table, not the global user.role.
// Must run after both `authenticate` and `tenantMiddleware`.
//
// The resolved membership role is published on `req.tenantRole` so handlers and
// services authorise on the role the caller holds *in this coaching*. Reading
// `req.user.role` for a tenant decision is a bug: the account role is global and
// a user can own one coaching while teaching in another.
export function requireTenantRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    if (!req.tenant) throw new AppError('TENANT_REQUIRED', 'Tenant context missing', 400)

    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, req.user.id), eq(memberships.tenantId, req.tenant.id)))
      .limit(1)

    if (!membership || !roles.includes(membership.role as Role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions', 403)
    }

    req.tenantRole = membership.role as Role
  }
}
