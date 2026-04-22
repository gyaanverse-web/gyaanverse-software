import { db } from '../../shared/db.js'
import { tenants, tenantSettings } from './tenant.schema.js'
import { eq } from 'drizzle-orm'
import { AppError } from '../../shared/errors.js'
import type { Tenant } from './tenant.types.js'

const RESERVED_SLUGS = ['www', 'api', 'admin', 'app', 'static']

function toTenant(row: {
  status: string
} & Omit<Tenant, 'status'>): Tenant {
  if (row.status !== 'active' && row.status !== 'suspended') {
    throw new AppError('INVALID_TENANT_STATUS', 'Invalid tenant status', 500)
  }

  return { ...row, status: row.status }
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1)
  return rows[0] ? toTenant(rows[0]) : null
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  return rows[0] ? toTenant(rows[0]) : null
}

export async function createTenant(data: {
  slug: string
  name: string
  ownerId: string
}): Promise<Tenant> {
  const slug = data.slug.toLowerCase()

  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new AppError('INVALID_SLUG', 'Slug must contain only lowercase letters, numbers, and hyphens', 422)
  }

  if (RESERVED_SLUGS.includes(slug)) {
    throw new AppError('RESERVED_SLUG', 'That slug is reserved', 409)
  }

  const [tenant] = await db.insert(tenants).values({
    slug,
    name: data.name,
    ownerId: data.ownerId,
  }).returning()

  await db.insert(tenantSettings).values({ tenantId: tenant.id })

  return toTenant(tenant)
}

export async function updateSettings(
  tenantId: string,
  data: { allowPublicMocks?: boolean; customDomain?: string | null },
): Promise<void> {
  await db
    .update(tenantSettings)
    .set(data)
    .where(eq(tenantSettings.tenantId, tenantId))
}
