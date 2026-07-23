import {
  pgTable, uuid, varchar, text, integer, numeric, boolean,
  timestamp, jsonb, index,
} from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

// ─────────────────────────────────────────────────────────────────────────────
// 5-level academic hierarchy: subject → module → chapter → section → concept
//
// `tenantId` is nullable on every level:
//   NULL = Gyanverse global content (visible to all institutes)
//   UUID = content owned by a single coaching institute
//
// Generation and listing always read both pools:
//   WHERE (tenant_id IS NULL OR tenant_id = $tenant)
//
// `createdBy` is nullable so global content can be seeded without a user row.
// ─────────────────────────────────────────────────────────────────────────────

export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  gradeLevel: varchar('grade_level', { length: 50 }),
  language: varchar('language', { length: 10 }).notNull().default('en'),
  // 'active' | 'archived'
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('subjects_tenant_id_idx').on(t.tenantId)])

export const modules = pgTable('modules', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectId: uuid('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  order: integer('order').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('modules_subject_id_idx').on(t.subjectId),
  index('modules_tenant_id_idx').on(t.tenantId),
])

export const chapters = pgTable('chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  moduleId: uuid('module_id').notNull().references(() => modules.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  order: integer('order').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('chapters_module_id_idx').on(t.moduleId),
  index('chapters_tenant_id_idx').on(t.tenantId),
])

export const sections = pgTable('sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  order: integer('order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('sections_chapter_id_idx').on(t.chapterId),
  index('sections_tenant_id_idx').on(t.tenantId),
])

export const concepts = pgTable('concepts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sectionId: uuid('section_id').notNull().references(() => sections.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('concepts_section_id_idx').on(t.sectionId),
  index('concepts_tenant_id_idx').on(t.tenantId),
])

// ─────────────────────────────────────────────────────────────────────────────
// Central question bank — the pool every generated test draws from.
//
// The full hierarchy path is denormalized onto every row (all 5 ancestor IDs)
// so generation filters at any level with a single indexed scan and zero joins.
// `subjectId` is always present; lower levels are nullable so a question can be
// tagged at any grain (a chapter-level question may have no section/concept).
//
// Marks are integers to stay consistent with the grader, which floors partial
// awards. Fractional *awarded* marks happen at grade time, not on the question.
// ─────────────────────────────────────────────────────────────────────────────

export const questionBank = pgTable('question_bank', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),

  // Denormalized hierarchy path
  subjectId: uuid('subject_id').notNull().references(() => subjects.id),
  moduleId: uuid('module_id').references(() => modules.id),
  chapterId: uuid('chapter_id').references(() => chapters.id),
  sectionId: uuid('section_id').references(() => sections.id),
  conceptId: uuid('concept_id').references(() => concepts.id),

  // Content
  // 'mcq_single' | 'mcq_multiple' | 'integer' | 'numerical' | 'subjective'
  // | 'match' | 'assertion_reason' | 'fill_blanks'
  type: varchar('type', { length: 30 }).notNull(),
  // 'easy' | 'medium' | 'hard'
  difficulty: varchar('difficulty', { length: 10 }).notNull(),
  body: text('body').notNull(),
  imageUrls: text('image_urls').array(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  answerKey: jsonb('answer_key').$type<Record<string, unknown>>().notNull(),

  // Marking scheme (copied to the exam question on generation; teacher may override)
  defaultMarks: integer('default_marks').notNull().default(1),
  defaultNegativeMarks: integer('default_negative_marks').notNull().default(0),

  // Solution
  explanation: text('explanation'),
  explanationImageUrls: text('explanation_image_urls').array(),
  solutionVideoUrl: text('solution_video_url'),

  // Search & classification
  tags: text('tags').array(),
  language: varchar('language', { length: 10 }).notNull().default('en'),
  // { type: 'original' | 'textbook' | 'pyq', ... }
  source: jsonb('source').$type<Record<string, unknown>>(),

  // Analytics
  usageCount: integer('usage_count').notNull().default(0),
  avgSuccessRate: numeric('avg_success_rate', { precision: 5, scale: 4 }),

  // Quality control
  isVerified: boolean('is_verified').notNull().default(false),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  // 'draft' | 'active' | 'flagged' | 'archived' — only 'active' enters generation
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  flagReason: text('flag_reason'),

  // Escape hatch for future fields without a migration
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('question_bank_tenant_id_idx').on(t.tenantId),
  index('question_bank_subject_id_idx').on(t.subjectId),
  index('question_bank_module_id_idx').on(t.moduleId),
  index('question_bank_chapter_id_idx').on(t.chapterId),
  index('question_bank_section_id_idx').on(t.sectionId),
  index('question_bank_concept_id_idx').on(t.conceptId),
  // Generation filters by status + type + difficulty within a hierarchy scope
  index('question_bank_gen_idx').on(t.status, t.type, t.difficulty),
])
