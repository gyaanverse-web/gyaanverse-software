// Fastify module augmentation — types attached by our middleware.
//
// `authenticate` sets `req.user`. `tenantMiddleware` sets `req.tenant`. Both
// are declared optional because public routes don't run those preHandlers;
// route handlers that DO depend on them use `req.user!` / `req.tenant!`.
//
// This file replaces ~117 `(req as any).user` / `(req as any).tenant` casts
// scattered across the codebase. A rename of `user.id` to `user.userId` will
// now fail to compile instead of breaking at runtime.

import 'fastify'
import type { Role } from '../modules/auth/auth.types.js'
import type { Tenant } from '../modules/tenant/tenant.types.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string
      role: Role
    }
    tenant?: Tenant
  }
}
