import {
  pgTable, uuid, varchar, text, timestamp, integer, numeric,
  index, uniqueIndex, jsonb,
} from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { classes } from '../class/class.schema.js'
// The academic hierarchy and the central question bank live in the
// question-bank module. The exam module depends on them one-directionally:
// exams reference subjects, and generated questions keep a lineage pointer
// (`bankQuestionId`) back to the bank row they were copied from.
import { subjects, chapters, questionBank } from '../question-bank/question-bank.schema.js'

// ── Exams ──────────────────────────────────────────────────────────────────

export const exams = pgTable('exams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  instructions: text('instructions'),
  // Teacher-facing duration. May be overridden after generation; defaults from
  // `estimatedDurationMins` computed off the time matrix.
  durationMins: integer('duration_mins').notNull(),
  // Computed by the generator from the time-estimation matrix. Null for exams
  // authored manually (no generation run).
  estimatedDurationMins: integer('estimated_duration_mins'),
  // The generation config this exam was produced from (subject/chapters, total
  // questions, type & difficulty distributions). Null for manually authored exams.
  generationParams: jsonb('generation_params').$type<Record<string, unknown>>(),
  gradeLevel: varchar('grade_level', { length: 50 }),
  subjectId: uuid('subject_id').references(() => subjects.id),
  // 'single_chapter' | 'multi_chapter' | 'full_subject' | 'full_syllabus' | 'custom'
  scopeType: varchar('scope_type', { length: 30 }).notNull().default('custom'),
  // 'private' | 'public_free' | 'public_paid'
  visibility: varchar('visibility', { length: 20 }).notNull().default('private'),
  price: numeric('price', { precision: 10, scale: 2 }),
  maxAttempts: integer('max_attempts').notNull().default(1),
  // Teacher→admin approval / scheduling / live / evaluation lifecycle (PRD v1).
  // 'draft' | 'under_review' | 'changes_requested' | 'rejected' | 'approved'
  // | 'scheduled' | 'live' | 'under_evaluation' | 'ready_to_publish'
  // | 'completed' | 'archived'  (see ExamStatus in exam.types.ts)
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  totalMarks: integer('total_marks').notNull().default(0),
  // ── Resumable authoring wizard (test engine) ─────────────────────────────
  // The teacher's draft is created the moment they open the generator, and the
  // wizard writes its progress back here on every step. Closing the tab and
  // returning tomorrow resumes exactly where they left off.
  //   wizardStep  — 1-based step last reached (1 Class & Subject … 4 Review).
  //                 Null for exams never authored through the wizard.
  //   wizardState — the raw form state for those steps (see WizardState in
  //                 exam.types.ts). Deliberately a loose jsonb blob: it is UI
  //                 scratch state, and `generationParams` remains the canonical
  //                 record of what the paper was actually generated from.
  wizardStep: integer('wizard_step'),
  wizardState: jsonb('wizard_state').$type<Record<string, unknown>>(),
  // Optional quality/coverage score for the Test Overview. Null until computed.
  qualityScore: integer('quality_score'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  // ── Approval-lifecycle timestamps & audit ────────────────────────────────
  // Teacher submitted for review (draft/changes_requested → under_review).
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  // Admin (coaching_owner) who last approved/rejected/requested changes.
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  // Remarks attached to the last review decision (changes_requested / rejected).
  reviewRemarks: text('review_remarks'),
  // Both stamped together at the publish click (ready_to_publish → completed),
  // since publishing is what finishes the lifecycle.
  resultsPublishedAt: timestamp('results_published_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('exams_tenant_id_idx').on(t.tenantId)])

// ── Exam status history ─────────────────────────────────────────────────────
// One row per status change — powers the PRD "timeline" and approval remarks.
// `fromStatus` is null for the initial creation; `actorId` is null for
// system/worker-driven transitions (scheduled→live, live→under_evaluation).
export const examStatusHistory = pgTable('exam_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  fromStatus: varchar('from_status', { length: 20 }),
  toStatus: varchar('to_status', { length: 20 }).notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  remarks: text('remarks'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('exam_status_history_exam_id_idx').on(t.examId)])

// ── Exam scope linkages ────────────────────────────────────────────────────

export const examSubjects = pgTable('exam_subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id),
}, (t) => [uniqueIndex('exam_subjects_uniq').on(t.examId, t.subjectId)])

export const examChapters = pgTable('exam_chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id),
}, (t) => [uniqueIndex('exam_chapters_uniq').on(t.examId, t.chapterId)])

// ── Exam access control ────────────────────────────────────────────────────

export const examClasses = pgTable('exam_classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  classId: uuid('class_id').notNull().references(() => classes.id),
}, (t) => [uniqueIndex('exam_classes_uniq').on(t.examId, t.classId)])

// ── Questions ─────────────────────────────────────────────────────────────

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  examId: uuid('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  // Lineage to the bank row this question was copied from. Null = written
  // manually by the teacher. Editing the bank row later has no effect here —
  // questions are copied, not referenced, so a live exam never changes.
  bankQuestionId: uuid('bank_question_id').references(() => questionBank.id, { onDelete: 'set null' }),
  order: integer('order').notNull(),
  // 'mcq_single' | 'mcq_multiple' | 'integer' | 'numerical' | 'subjective'
  // | 'match' | 'assertion_reason' | 'fill_blanks'
  type: varchar('type', { length: 30 }).notNull(),
  // 'easy' | 'medium' | 'hard' — carried over for time estimation and analytics
  difficulty: varchar('difficulty', { length: 10 }),
  body: text('body').notNull(),
  imageUrls: text('image_urls').array(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  answerKey: jsonb('answer_key').$type<Record<string, unknown>>().notNull(),
  // Copied from the bank question's metadata.languageVariants at generation time
  // (questions are copied, not referenced — so the variant travels with the exam).
  // Shape: { hi: "…", bn: "…" }. The student view substitutes body by language.
  languageVariants: jsonb('language_variants').$type<Record<string, string>>(),
  marks: integer('marks').notNull(),
  negativeMarks: integer('negative_marks').notNull().default(0),
  explanation: text('explanation'),
  // Per-question review state during the draft phase:
  // 'pending' (just generated) | 'kept' (teacher approved) | 'discarded'.
  // Null = manually authored question (never part of a draft review).
  draftStatus: varchar('draft_status', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('questions_exam_id_idx').on(t.examId)])
