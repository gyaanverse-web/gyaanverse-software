import { pgTable, uuid, varchar, timestamp, integer, boolean, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  role: varchar('role', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('memberships_tenant_id_idx').on(t.tenantId)])

export const joinCodes = pgTable('join_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 10 }).notNull().unique(),
  classId: uuid('class_id').notNull(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxUses: integer('max_uses').notNull().default(9999),
  usedCount: integer('used_count').notNull().default(0),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('join_codes_tenant_id_idx').on(t.tenantId)])

export const enrollments = pgTable('enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => users.id),
  classId: uuid('class_id').notNull(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('enrollments_tenant_id_idx').on(t.tenantId)])
