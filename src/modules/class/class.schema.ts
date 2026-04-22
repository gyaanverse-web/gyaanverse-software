import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

export const classes = pgTable('classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  teacherId: uuid('teacher_id').notNull().references(() => users.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('classes_tenant_id_idx').on(t.tenantId)])

export const classMembers = pgTable('class_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  classId: uuid('class_id').notNull().references(() => classes.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
})
