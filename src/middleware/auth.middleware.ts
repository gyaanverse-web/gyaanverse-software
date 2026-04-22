import type { FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from '../shared/errors.js'

type Role = 'super_admin' | 'coaching_owner' | 'teacher' | 'student'

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (req as any).user
    if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    if (!roles.includes(user.role as Role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions', 403)
    }
  }
}
