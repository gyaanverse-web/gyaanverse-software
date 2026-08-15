import type { FastifyRequest, FastifyReply } from 'fastify'
import { Errors } from '../../shared/errors.js'
import { isBillingEnabled } from '../platform/platform.service.js'

/**
 * Make a route not exist while billing is off.
 *
 * A `preHandler` rather than a conditional `app.register(billingRoutes)`,
 * because the switch is flipped at runtime from the ops panel: registration
 * happens once at boot, so a conditional register would need a process restart
 * to take effect and would silently disagree with the panel until it got one.
 *
 * **404, not 403.** 403 says "this exists and you may not use it", which invites
 * a client to show an upgrade prompt for a product that has not launched. 404
 * says the surface is not there, which is the truth.
 *
 * The endpoint this matters most for is `POST /billing/webhook`. It is
 * unauthenticated by necessity (Razorpay calls it) and it WRITES `tenants.plan`
 * on a valid signature. Leaving a live plan-mutating endpoint exposed on a
 * product with no billing is a standing risk for no benefit, and the signature
 * check is only as good as the secret — which, on a pre-launch product, is the
 * credential least likely to have been rotated or even deliberately set.
 */
export async function requireBillingEnabled(
  _req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!(await isBillingEnabled())) throw Errors.NOT_FOUND('Route')
}
