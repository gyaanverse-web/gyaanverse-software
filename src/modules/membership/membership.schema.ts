import { pgTable, uuid, varchar, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

export const coachingJoinCodes = pgTable('coaching_join_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  code: varchar('code', { length: 10 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses').notNull().default(9999),
  usedCount: integer('used_count').notNull().default(0),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('coaching_join_codes_tenant_id_idx').on(t.tenantId)])

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  role: varchar('role', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('memberships_tenant_id_idx').on(t.tenantId),
  uniqueIndex('memberships_user_tenant_uniq').on(t.userId, t.tenantId),
])

