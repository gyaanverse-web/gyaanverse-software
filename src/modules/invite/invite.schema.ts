import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by').notNull().references(() => users.id),
  contact: varchar('contact', { length: 255 }).notNull(),
  contactType: varchar('contact_type', { length: 10 }).notNull(), // 'email' | 'phone'
  role: varchar('role', { length: 50 }).notNull().default('teacher'),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'accepted' | 'revoked'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('invites_tenant_id_idx').on(t.tenantId),
  index('invites_token_idx').on(t.token),
])
