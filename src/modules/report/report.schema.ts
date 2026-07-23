import { pgTable, uuid, varchar, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { exams, questions } from '../exam/exam.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => examSessions.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  // Resolved from exams.tenantId (creator tenant). Public-exam students whose
  // own membership is null still produce a report owned by the exam's tenant.
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  totalScore: integer('total_score').notNull(),
  maxScore: integer('max_score').notNull(),
  autoScore: integer('auto_score').notNull().default(0),
  aiScore: integer('ai_score').notNull().default(0),
  // 'pending' | 'ready' | 'archived'
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('reports_tenant_id_idx').on(t.tenantId),
  index('reports_exam_id_idx').on(t.examId),
  index('reports_student_id_idx').on(t.studentId),
  uniqueIndex('reports_session_uniq').on(t.sessionId),
])

export const reportItems = pgTable('report_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => reports.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  score: integer('score').notNull(),
  maxScore: integer('max_score').notNull(),
  feedback: text('feedback'),
  // Null for objective questions (no image), set for subjective answers
  imageUrl: text('image_url'),
}, (t) => [
  uniqueIndex('report_items_report_question_uniq').on(t.reportId, t.questionId),
])
