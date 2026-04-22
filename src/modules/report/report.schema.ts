import { pgTable, uuid, varchar, text, timestamp, integer, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { exams, questions } from '../exam/exam.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => examSessions.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  totalScore: integer('total_score').notNull(),
  maxScore: integer('max_score').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('ready'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('reports_tenant_id_idx').on(t.tenantId)])

export const reportItems = pgTable('report_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => reports.id),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  score: integer('score').notNull(),
  maxScore: integer('max_score').notNull(),
  feedback: text('feedback'),
  imageUrl: text('image_url').notNull(),
})
