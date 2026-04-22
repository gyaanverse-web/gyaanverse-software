import { pgTable, uuid, varchar, text, timestamp, boolean } from 'drizzle-orm/pg-core'

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  logoUrl: text('logo_url'),
  ownerId: uuid('owner_id').notNull(),
  plan: varchar('plan', { length: 50 }).notNull().default('free'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  allowPublicMocks: boolean('allow_public_mocks').notNull().default(false),
  customDomain: text('custom_domain'),
})
