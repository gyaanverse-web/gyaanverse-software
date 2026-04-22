import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { exams, questions } from '../exam/exam.schema.js'

export const examSessions = pgTable('exam_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  status: varchar('status', { length: 20 }).notNull().default('in_progress'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
}, (t) => [index('exam_sessions_tenant_id_idx').on(t.tenantId)])

export const sessionAnswers = pgTable('session_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => examSessions.id),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  imageUrl: text('image_url').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
})
