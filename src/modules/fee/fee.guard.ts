import type { FastifyRequest, FastifyReply } from 'fastify'
import { Errors } from '../../shared/errors.js'
import { isFeesEnabled } from '../platform/platform.service.js'

/**
 * Make a route not exist while fees are off.
 *
 * Same reasoning as `requireBillingEnabled`: `fees_enabled` is a runtime
 * platform switch flipped from the ops panel, so this has to be a
 * `preHandler` re-checked per request rather than a conditional route
 * registration decided once at boot.
 *
 * 404, not 403 — the surface is not there, not "there but forbidden".
 */
export async function requireFeesEnabled(
  _req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!(await isFeesEnabled())) throw Errors.NOT_FOUND('Route')
}
