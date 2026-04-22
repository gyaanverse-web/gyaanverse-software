import type { FastifyRequest, FastifyReply } from 'fastify'
import { getTenantBySlug } from '../modules/tenant/index.js'
import { AppError } from '../shared/errors.js'

export async function tenantMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const host = req.headers.host ?? ''
  const appDomain = process.env.APP_DOMAIN ?? 'yourapp.com'

  let slug: string | undefined

  // Extract slug from subdomain (e.g. sharma.yourapp.com -> sharma)
  if (host.endsWith(`.${appDomain}`)) {
    slug = host.replace(`.${appDomain}`, '').split('.')[0]
  }

  // Fallback: ?tenant=sharma query param for local dev
  if (!slug && req.query && typeof req.query === 'object') {
    const query = req.query as Record<string, string>
    slug = query['tenant']
  }

  if (!slug) {
    throw new AppError('TENANT_REQUIRED', 'Could not resolve tenant from request', 400)
  }

  const tenant = await getTenantBySlug(slug)
  if (!tenant) {
    throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
  }

  ;(req as any).tenant = tenant
}
