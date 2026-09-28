import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
// auth.schema imports tenants; we import users via lazy ref callback to complete the
// circular FK (tenants.ownerId → users.id) without a hard circular import at load time.
import { users } from '../auth/auth.schema.js'

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  logoUrl: text('logo_url'),
  ownerId: uuid('owner_id').notNull().references((): AnyPgColumn => users.id),
  plan: varchar('plan', { length: 50 }).notNull().default('free'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// NOTE: `tenant_settings` was dropped in migration 0022. It held exactly two
// columns — `allow_public_mocks` and `custom_domain` — that were written by an
// owner-facing form and read by nothing. What actually gates public exams is the
// plan feature `public_mocks`; what actually resolves a tenant is the slug
// wildcard. Do not reintroduce a per-tenant mirror of either.
