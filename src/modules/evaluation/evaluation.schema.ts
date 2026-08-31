import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { questions } from '../exam/exam.schema.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE DATABASE TABLES THIS MODULE OWNS.
//
//   evaluation_jobs   one row per submitted paper — "grade this student's paper"
//   question_results  one row per question inside that paper — the actual marks
//   ocr_cache         handwriting we have already read, so we never pay twice
//
// This file only DESCRIBES the tables to the code. Editing it does not change
// the real database — a migration has to be generated and run for that.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE ROW PER SUBMITTED PAPER. Created the moment a student submits an exam that
 * has subjective (handwritten) questions.
 *
 * The whole retry, repair and backstop machinery is really just these columns
 * being read and written by different files.
 */
export const evaluationJobs = pgTable('evaluation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => examSessions.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // The raw error message, for a human to read. Free text — never group or
  // count on this.
  error: text('error'),
  // The fixed error code behind that message: ENGINE_TIMEOUT, OCR_EMPTY,
  // NOT_FOUND, and so on. Because these values never change wording, this is the
  // only one of the two that is safe to count and group by — which is exactly
  // what the ops screens and the daily digest do.
  lastErrorCode: varchar('last_error_code', { length: 50 }),
  // 'transient' | 'permanent' | 'needs_human' — see evaluation.types.ts.
  // Overwritten on EVERY failure, so it always describes the most recent try,
  // not a final verdict.
  failureClass: varchar('failure_class', { length: 20 }),
  // The earliest time anything should touch this job again.
  // Empty (NULL) on a `failed` row is meaningful: it marks the job as finished
  // failing, so the reconciler leaves it alone. See findDrift in
  // evaluation.reconciler.ts, which depends on this.
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  // A worker's "I am still alive" stamp, pushed forward after every question.
  // If this time has passed while `status` is still `processing`, that worker
  // died and the job is safe for the reconciler to take back.
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  // Filled in when the backstop stopped waiting and closed the session out so
  // the rest of the class could get their results.
  //
  // Its presence is the difference between "this job failed" (still the retry
  // system's problem) and "this job failed AND we already wrote a placeholder
  // for it" (now a person's problem). Cleared again if a later try actually
  // succeeds.
  settledAt: timestamp('settled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('evaluation_jobs_tenant_id_idx').on(t.tenantId),
  // Makes the reconciler's question fast: "which jobs are due another look?"
  index('evaluation_jobs_sweep_idx').on(t.status, t.nextRetryAt),
  // Makes the "which workers died mid-job?" sweep fast.
  index('evaluation_jobs_lease_idx').on(t.leaseExpiresAt),
])

/**
 * HANDWRITING WE HAVE ALREADY READ, saved so we never pay to read it twice.
 * Looked up by the exact image address that was handed to the AI engine.
 *
 * WHY IT EXISTS: reading the same photo always produces the same text, so it
 * should be paid for once. Without this table, every retry re-read a page that
 * had already been read perfectly. With up to 50 tries, one answer whose GRADING
 * step kept failing billed 50 separate reads of the same legible page (observed
 * live, 2026-08-12).
 *
 * NOT SPLIT PER COACHING, on purpose. The lookup key is the storage address of
 * one specific upload — nobody can produce that address without already having
 * access to the file — and a match returns only that image's own text. So there
 * is nothing here one coaching could learn about another. Sharing the row is the
 * whole point: it is what makes re-uploading the same file free.
 */
export const ocrCache = pgTable('ocr_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  // A sha256 fingerprint of `source`. We look up by the fingerprint rather than
  // by the address itself because the address can be a very long URL, and
  // database indexes have a size limit. A fingerprint is always 64 characters.
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  source: text('source').notNull(),
  // The read itself, stored as JSON text. Only ever saved when the read produced
  // real text — see evaluation.ocr.ts for why a blank read is never saved.
  ocrData: text('ocr_data').notNull(),
  // Purely for checking that things work: a rising `hits` count is how you
  // confirm a retry reused a saved read instead of paying to read again.
  hits: integer('hits').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ocr_cache_source_hash_idx').on(t.sourceHash),
])

/**
 * ONE ROW PER QUESTION, PER JOB. This is where the actual marks live.
 *
 * It is also what makes a retry cheap: a re-run skips every question that
 * already has a row here, so a job that died on question 8 of 10 only pays for
 * the last two.
 */
export const questionResults = pgTable('question_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => evaluationJobs.id),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  // ALWAYS the real, effective mark — what the student is actually scored.
  //
  // When a Gyaanverse operator corrects an answer, their number is written here
  // and the AI's original is moved to `ai_score`. That way everything downstream
  // (reports, totals, analytics) keeps reading this one column and never has to
  // know that manual corrections exist at all.
  score: integer('score').notNull(),
  maxScore: integer('max_score').notNull(),
  aiFeedback: text('ai_feedback'),
  imageUrl: text('image_url').notNull(),

  // ── Human review columns ────────────────────────────────────────────────
  //
  //   ai           the AI graded it and nobody has needed to get involved
  //   needs_human  the backstop wrote a placeholder 0 here so the class could
  //                move on; a Gyaanverse operator still has to grade it by hand
  //   resolved     an operator has. `score` is their number, `ai_score` is the
  //                AI's original
  //
  // NEVER SHOWN TO THE COACHING. `needs_human` is a Gyaanverse internal state,
  // not a task for the teacher. See
  // docs/decisions/2026-08-12-evaluation-backstop.md
  reviewStatus: varchar('review_status', { length: 20 }).notNull().default('ai'),
  // The AI's own score, saved at the moment a person overrode it. Empty while
  // nobody has. Kept so that "what did the AI actually say?" survives the
  // correction — without it, every correction would silently destroy the
  // evidence of the mistake and we could never measure how often the AI is wrong.
  aiScore: integer('ai_score'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),

  // Set only when the pixel-only blank-page detector auto-scored this answer 0
  // (see evaluation.blank-page.ts). NULL for every normal AI-graded or
  // human-reviewed row. This is an AUDIT marker, not a review gate — unlike
  // `needs_human`, a row with this set has already completed and its exam is
  // free to publish; `reviewedBy` on this row means a Gyaanverse operator has
  // since spot-checked it (`reviewStatus` staying `ai` = confirmed blank,
  // becoming `resolved` = the detector was wrong and a human corrected the
  // score). See evaluation.blank-page-audit.ts.
  autoZeroReason: varchar('auto_zero_reason', { length: 30 }),
}, (t) => [
  // Enforces one row per question per job. The database itself refuses a second
  // row, which is what lets a re-run safely say "already done, skip it" instead
  // of re-reading the whole paper.
  uniqueIndex('question_results_job_id_question_id_idx').on(t.jobId, t.questionId),
  // Makes both the internal review queue and the publish gate fast. They ask the
  // same question: "is anything here still waiting on a person?"
  index('question_results_review_status_idx').on(t.reviewStatus),
  // Makes the blank-page audit list/summary fast — "which rows did the
  // detector auto-zero?"
  index('question_results_auto_zero_reason_idx').on(t.autoZeroReason),
])
