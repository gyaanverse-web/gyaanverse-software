import type { FastifyRequest, FastifyReply } from 'fastify'
import { getTenantBySlug } from '../modules/tenant/index.js'
import { AppError } from '../shared/errors.js'

// Subdomains that must never be treated as tenant slugs.
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'app', 'admin', 'auth', 'static', 'cdn'])

function extractSubdomainSlug(host: string, suffix: string): string | undefined {
  if (!host.endsWith(suffix)) return undefined
  const prefix = host.slice(0, -suffix.length)
  if (!prefix) return undefined
  // For multi-label prefixes (e.g. sharma.api.yourapp.com) take the leftmost label.
  return prefix.split('.')[0] || undefined
}

export async function tenantMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Strip port so sharma.gyanverse.com:3000 resolves the same as sharma.gyanverse.com
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  const appDomain = process.env.APP_DOMAIN ?? 'gyanverse.com'

  let slug: string | undefined

  // 1. Subdomain — works for *.gyanverse.com (prod) and *.lvh.me (dev).
  slug =
    extractSubdomainSlug(host, `.${appDomain}`) ??
    extractSubdomainSlug(host, '.lvh.me')

  if (slug && RESERVED_SUBDOMAINS.has(slug)) slug = undefined

  // 2. X-Tenant-Slug header — used when the API host differs from the frontend host
  //    (e.g. frontend at niazi.localhost:3000 calling API at localhost:8000)
  if (!slug) {
    const headerSlug = req.headers['x-tenant-slug']
    if (typeof headerSlug === 'string' && headerSlug.length > 0) slug = headerSlug
  }

  // 3. ?tenant=sharma query param — last-ditch fallback (kept for tooling/curl)
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

  req.tenant = tenant
}
