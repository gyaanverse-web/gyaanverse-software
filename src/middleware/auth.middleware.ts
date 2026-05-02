import type { FastifyRequest, FastifyReply } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { fromNodeHeaders } from 'better-auth/node'
import { AppError, Errors } from '../shared/errors.js'
import { auth } from '../config/auth.js'
import { db } from '../shared/db.js'
import { memberships } from '../modules/membership/membership.schema.js'

type Role = 'super_admin' | 'coaching_owner' | 'teacher' | 'student'

export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
  if (!session) throw Errors.UNAUTHORIZED()
  ;(req as any).user = { id: session.user.id, role: (session.user as any).role ?? 'student' }
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const user = (req as any).user
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    if (!roles.includes(user.role as Role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions', 403)
    }
  }
}

// Checks the user's role in the resolved tenant's memberships table, not the global user.role.
// Must run after both `authenticate` and `tenantMiddleware`.
export function requireTenantRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const user = (req as any).user
    const tenant = (req as any).tenant
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    if (!tenant) throw new AppError('TENANT_REQUIRED', 'Tenant context missing', 400)

    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.tenantId, tenant.id)))
      .limit(1)

    if (!membership || !roles.includes(membership.role as Role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions', 403)
    }
  }
}
