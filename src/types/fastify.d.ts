// Fastify module augmentation — types attached by our middleware.
//
// `authenticate` sets `req.user`. `tenantMiddleware` sets `req.tenant`.
// `requireTenantRole` sets `req.tenantRole`. All are declared optional because
// public routes don't run those preHandlers; route handlers that DO depend on
// them use `req.user!` / `req.tenant!` / `req.tenantRole!`.
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
      /**
       * The **account-level** role from the auth session. Valid only for
       * questions that sit outside any coaching (is this the platform
       * `super_admin`?). Never authorise a `/tenant/*` action on this — a user
       * can own one coaching and teach in another, so the account role and the
       * role they hold *here* routinely differ. Use `req.tenantRole`.
       */
      role: Role
    }
    tenant?: Tenant
    /**
     * The role the caller holds **in `req.tenant`**, read from `memberships` by
     * `requireTenantRole`. This is the authoritative role for every tenant-scoped
     * authorization decision.
     */
    tenantRole?: Role
    /**
     * When the current session was created (sign-in time), set by `authenticate`.
     *
     * Only `/internal/*` reads it, to enforce a session-age cap much shorter than
     * the global session lifetime — see `middleware/internal.ts`.
     */
    sessionCreatedAt?: Date
  }

  interface FastifyContextConfig {
    /**
     * Requests the unparsed request body, for signature verification.
     *
     * ⚠️ **Declared but NOT implemented.** Nothing acts on this flag: no
     * `fastify-raw-body` (or equivalent) plugin is registered in `app.ts`, so
     * `req.rawBody` is always `undefined` and the one route that sets this —
     * `POST /billing/webhook` — silently falls back to
     * `JSON.stringify(req.body)`. That re-serialisation will not reproduce
     * Razorpay's bytes (key order, spacing, unicode escaping), so the HMAC
     * comparison fails and every webhook is rejected with a 400.
     *
     * Harmless today: the route answers 404 while `billing_enabled` is off. It
     * becomes a launch-blocking bug the moment that switch is flipped, and it
     * will present as "Razorpay says delivery failed" rather than as anything
     * pointing at this line. Register a raw-body plugin before enabling billing.
     */
    rawBody?: boolean
  }
}
