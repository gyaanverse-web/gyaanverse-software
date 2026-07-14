import { pgTable, uuid, varchar, text, timestamp, boolean, integer, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { exams } from '../exam/exam.schema.js'
import { questions } from '../exam/exam.schema.js'

export const examSessions = pgTable('exam_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id),
  studentId: uuid('student_id').notNull().references(() => users.id),
  // null for public-exam students not affiliated with any tenant
  tenantId: uuid('tenant_id').references(() => tenants.id),
  attemptNumber: integer('attempt_number').notNull().default(1),
  // 'in_progress' | 'submitted' | 'evaluated' | 'abandoned'
  status: varchar('status', { length: 20 }).notNull().default('in_progress'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  autoScore: integer('auto_score'),
  manualScore: integer('manual_score'),
  totalMarks: integer('total_marks').notNull(),
}, (t) => [
  index('exam_sessions_exam_id_idx').on(t.examId),
  index('exam_sessions_student_id_idx').on(t.studentId),
  uniqueIndex('exam_sessions_attempt_uniq').on(t.examId, t.studentId, t.attemptNumber),
])

export const sessionAnswers = pgTable('session_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => examSessions.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  answer: jsonb('answer').$type<Record<string, unknown>>(),
  imageUrl: text('image_url'),
  isCorrect: boolean('is_correct'),
  awardedMarks: integer('awarded_marks'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('session_answers_uniq').on(t.sessionId, t.questionId)])
