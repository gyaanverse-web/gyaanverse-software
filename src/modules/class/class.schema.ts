import { pgTable, uuid, varchar, text, timestamp, index, boolean, integer, uniqueIndex } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

export const classes = pgTable('classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  teacherId: uuid('teacher_id').notNull().references(() => users.id),
  name: varchar('name', { length: 255 }).notNull(),
  grade: varchar('grade', { length: 50 }),
  description: text('description'),
  autoApprove: boolean('auto_approve').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('classes_tenant_id_idx').on(t.tenantId)])

export const classMembers = pgTable('class_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  // pending → teacher reviews; approved → enrolled; rejected → denied
  status: varchar('status', { length: 20 }).notNull().default('approved'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('class_members_class_student_uniq').on(t.classId, t.studentId),
])

export const CLASS_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous 0/O, 1/I

export const joinCodes = pgTable('join_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 10 }).notNull().unique(),
  classId: uuid('class_id').notNull().references(() => classes.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses').notNull().default(9999),
  usedCount: integer('used_count').notNull().default(0),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('join_codes_class_id_idx').on(t.classId)])
