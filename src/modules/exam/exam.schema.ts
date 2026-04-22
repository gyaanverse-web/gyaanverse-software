import { pgTable, uuid, varchar, text, timestamp, boolean, integer, numeric, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { classes } from '../class/class.schema.js'

export const exams = pgTable('exams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  teacherId: uuid('teacher_id').notNull().references(() => users.id),
  title: varchar('title', { length: 255 }).notNull(),
  durationMins: integer('duration_mins').notNull(),
  visibility: varchar('visibility', { length: 20 }).notNull().default('private'),
  isPaid: boolean('is_paid').notNull().default(false),
  price: numeric('price', { precision: 10, scale: 2 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('exams_tenant_id_idx').on(t.tenantId)])

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  body: text('body').notNull(),
  marks: integer('marks').notNull(),
  order: integer('order').notNull(),
}, (t) => [index('questions_tenant_id_idx').on(t.tenantId)])

export const examAccess = pgTable('exam_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  classId: uuid('class_id').notNull().references(() => classes.id),
})
