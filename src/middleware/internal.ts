import type { FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from '../shared/errors.js'
import { db } from '../shared/db.js'
import { auditLogs } from '../shared/audit.schema.js'
import { env } from '../config/env.js'
import { authenticate, requireRole } from './auth.middleware.js'

// ─────────────────────────────────────────────────────────────────────────────
// The `/internal/*` seam — everything the Gyaanverse operator panel talks to.
//
// Phase 6 inlined this guard inside `evaluation.internal.routes.ts`. It lives
// here now because Phase 7 adds a second internal route file and then a third,
// and a guard that is copy-pasted per module is a guard that is *tightened* per
// module — the next hardening (IP allowlist, step-up auth, 2FA) would have to
// find every copy and would silently miss the one added last week.
//
// Three properties define an internal route, and `internalAuth` is all three:
//
//   1. Authenticated.
//   2. `super_admin` on the **global account role**. Never `requireTenantRole` —
//      a coaching owner holds `coaching_owner` inside their own tenant and must
//      never reach a cross-tenant surface through it.
//   3. Signed in recently (see below).
//
// Auth is by Bearer token in practice: the panel is deployed separately, so once
// it moves off admin.<APP_DOMAIN> to its own domain the session cookie stops
// being sent at all (third-party, and blocked outright by Safari/Firefox). The
// `bearer()` plugin in config/auth.ts is what makes that a non-event, and it is
// why the panel must send `Authorization: Bearer` and never rely on the cookie
// even today, while it happens to be on a subdomain where the cookie still flows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject an otherwise-valid session that is older than `OPS_SESSION_MAX_AGE_MS`.
 *
 * The global session lifetime is tuned for students and teachers, who are the
 * whole reason it is long. An internal session is a different object: it reads
 * across every tenant and it writes scores, so the cost of one left open on an
 * unattended laptop is not one coaching's data but all of them.
 *
 * **Fails open if the timestamp is missing**, deliberately. This is
 * defence-in-depth stacked on top of the `super_admin` check, which is the real
 * gate; if a Better Auth upgrade ever changes the session shape, the correct
 * failure is a logged warning, not an ops panel that cannot log in during the
 * incident it exists to resolve.
 */
export async function requireFreshSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const createdAt = req.sessionCreatedAt
  if (!createdAt) {
    console.warn(
      '[internal] session age unavailable — the freshness cap is not being enforced. ' +
        'Check that authenticate() still publishes req.sessionCreatedAt.',
    )
    return
  }

  const age = Date.now() - createdAt.getTime()
  if (age > env.OPS_SESSION_MAX_AGE_MS) {
    throw new AppError(
      'SESSION_STALE',
      'Your operator session has expired. Please sign in again.',
      401,
    )
  }
}

/**
 * The preHandler chain for every `/internal/*` route. Spread it, never rebuild it.
 */
export const internalAuth = [authenticate, requireRole('super_admin'), requireFreshSession]

/**
 * Record an operator action in `audit_logs`.
 *
 * This is the first writer that table has ever had. It matters more here than
 * anywhere else in the product: internal routes are the only place where one
 * person acts across tenant boundaries, on data belonging to coachings who
 * cannot see that it happened. `question_results.reviewed_by` covers the
 * override specifically; this covers everything that is not a score write, and
 * keeps the shape uniform as more internal endpoints land.
 *
 * `tenantId` is nullable on the table, which is what makes it usable here — a
 * platform-level action genuinely has no tenant, and recording a fake one would
 * be worse than recording none.
 *
 * **Never throws.** It is called after the action it describes has already been
 * committed, so raising here would report failure for work that succeeded — and
 * the operator's retry would then hit a 409 from the conflict guard and read as
 * data corruption. A failed insert is loud in the logs instead, which is itself
 * a durable trail on Railway.
 */
export async function logInternalAction(params: {
  actorId: string
  /** Dot-namespaced, e.g. `evaluation.override`, `evaluation.force_retry`. */
  action: string
  targetId?: string | null
  tenantId?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  const { actorId, action, targetId, tenantId, metadata } = params
  try {
    await db.insert(auditLogs).values({
      actorId,
      action,
      targetId: targetId ?? null,
      tenantId: tenantId ?? null,
      metadata: metadata ?? null,
    })
  } catch (err) {
    console.error(
      `[internal-audit] FAILED to record action=${action} actor=${actorId} ` +
        `target=${targetId ?? '-'} tenant=${tenantId ?? '-'} ` +
        `metadata=${JSON.stringify(metadata ?? {})}`,
      err,
    )
  }
}
