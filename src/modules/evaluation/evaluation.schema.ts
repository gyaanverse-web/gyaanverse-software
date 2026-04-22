import { pgTable, uuid, varchar, text, timestamp, integer, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { questions } from '../exam/exam.schema.js'

export const evaluationJobs = pgTable('evaluation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => examSessions.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('evaluation_jobs_tenant_id_idx').on(t.tenantId)])

export const questionResults = pgTable('question_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => evaluationJobs.id),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  score: integer('score').notNull(),
  maxScore: integer('max_score').notNull(),
  aiFeedback: text('ai_feedback'),
  imageUrl: text('image_url').notNull(),
})
