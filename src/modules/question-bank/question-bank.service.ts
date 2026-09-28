import { eq, and, or, isNull, ilike, sql, asc, desc, inArray, notInArray, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { validateQuestionPayload } from '../exam/exam.validators.js'
import {
  subjects, modules, chapters, sections, concepts, questionBank,
} from './question-bank.schema.js'
// Schema-only imports (no service dependency) for the success-rate aggregation,
// which spans copied exam questions and their graded session answers.
import { questions } from '../exam/exam.schema.js'
import { sessionAnswers } from '../exam-session/exam-session.schema.js'
import type {
  HierarchyPath, HierarchyPathInput, BankQuestionFilters, Difficulty,
} from './question-bank.types.js'

const QUESTION_TYPES = [
  'mcq_single', 'mcq_multiple', 'integer', 'numerical',
  'subjective', 'match', 'assertion_reason', 'fill_blanks',
] as const
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const

// ── Scope helpers ─────────────────────────────────────────────────────────────
//
// `tenantId === null` means the caller is acting in the global (Gyaanverse) scope.
// A non-null UUID means they are acting inside one institute.

// Read access: a tenant sees global content plus its own; the global scope sees
// only global content.
function readScope(col: PgColumn, tenantId: string | null): SQL {
  return tenantId === null ? isNull(col) : or(isNull(col), eq(col, tenantId))!
}

// Mutation ownership: you may only change rows in the scope you are acting in.
function ownScope(col: PgColumn, tenantId: string | null): SQL {
  return tenantId === null ? isNull(col) : eq(col, tenantId)
}

// ── Hierarchy resolution ──────────────────────────────────────────────────────
//
// Given any single level (or several), walk up from the deepest provided id and
// fill every ancestor. Each lookup is scoped to readable content so an institute
// can tag questions against global hierarchy nodes but never against another
// institute's private nodes.

async function loadOrThrow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  idCol: PgColumn,
  tenantCol: PgColumn,
  id: string,
  tenantId: string | null,
  label: string,
) {
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(idCol, id), readScope(tenantCol, tenantId)))
    .limit(1)
  if (!row) throw Errors.NOT_FOUND(label)
  return row
}

export async function resolveHierarchyPath(
  input: HierarchyPathInput,
  tenantId: string | null,
): Promise<HierarchyPath> {
  let subjectId: string | null = null
  let moduleId: string | null = null
  let chapterId: string | null = null
  let sectionId: string | null = null
  let conceptId: string | null = null

  if (input.conceptId) {
    const c = await loadOrThrow(concepts, concepts.id, concepts.tenantId, input.conceptId, tenantId, 'Concept')
    conceptId = c.id
    sectionId = c.sectionId
  }

  const effSection = sectionId ?? input.sectionId
  if (effSection) {
    const s = await loadOrThrow(sections, sections.id, sections.tenantId, effSection, tenantId, 'Section')
    sectionId = s.id
    chapterId = s.chapterId
  }

  const effChapter = chapterId ?? input.chapterId
  if (effChapter) {
    const ch = await loadOrThrow(chapters, chapters.id, chapters.tenantId, effChapter, tenantId, 'Chapter')
    chapterId = ch.id
    moduleId = ch.moduleId
  }

  const effModule = moduleId ?? input.moduleId
  if (effModule) {
    const m = await loadOrThrow(modules, modules.id, modules.tenantId, effModule, tenantId, 'Module')
    moduleId = m.id
    subjectId = m.subjectId
  }

  const effSubject = subjectId ?? input.subjectId
  if (effSubject) {
    const subj = await loadOrThrow(subjects, subjects.id, subjects.tenantId, effSubject, tenantId, 'Subject')
    subjectId = subj.id
  }

  if (!subjectId)
    throw new AppError('VALIDATION', 'A subjectId (or a deeper hierarchy id) is required', 422)

  return { subjectId, moduleId, chapterId, sectionId, conceptId }
}

// ── Hierarchy CRUD ────────────────────────────────────────────────────────────

export async function createSubject(data: {
  tenantId: string | null
  createdBy: string
  name: string
  code?: string
  gradeLevel?: string
  language?: string
}) {
  const [row] = await db.insert(subjects).values({
    tenantId: data.tenantId,
    createdBy: data.createdBy,
    name: data.name,
    code: data.code ?? null,
    gradeLevel: data.gradeLevel ?? null,
    language: data.language ?? 'en',
  }).returning()
  return row
}

export async function listSubjects(tenantId: string | null) {
  return db.select().from(subjects)
    .where(and(readScope(subjects.tenantId, tenantId), eq(subjects.status, 'active')))
    .orderBy(asc(subjects.name))
}

export async function createModule(data: {
  tenantId: string | null
  createdBy: string
  subjectId: string
  name: string
  order?: number
}) {
  await loadOrThrow(subjects, subjects.id, subjects.tenantId, data.subjectId, data.tenantId, 'Subject')
  const [row] = await db.insert(modules).values({
    tenantId: data.tenantId,
    createdBy: data.createdBy,
    subjectId: data.subjectId,
    name: data.name,
    order: data.order ?? 0,
  }).returning()
  return row
}

export async function listModules(subjectId: string, tenantId: string | null) {
  return db.select().from(modules)
    .where(and(eq(modules.subjectId, subjectId), readScope(modules.tenantId, tenantId), eq(modules.status, 'active')))
    .orderBy(asc(modules.order), asc(modules.name))
}

export async function createChapter(data: {
  tenantId: string | null
  createdBy: string
  moduleId: string
  name: string
  order?: number
}) {
  await loadOrThrow(modules, modules.id, modules.tenantId, data.moduleId, data.tenantId, 'Module')
  const [row] = await db.insert(chapters).values({
    tenantId: data.tenantId,
    createdBy: data.createdBy,
    moduleId: data.moduleId,
    name: data.name,
    order: data.order ?? 0,
  }).returning()
  return row
}

export async function listChapters(moduleId: string, tenantId: string | null) {
  return db.select().from(chapters)
    .where(and(eq(chapters.moduleId, moduleId), readScope(chapters.tenantId, tenantId), eq(chapters.status, 'active')))
    .orderBy(asc(chapters.order), asc(chapters.name))
}

export async function createSection(data: {
  tenantId: string | null
  createdBy: string
  chapterId: string
  name: string
  order?: number
}) {
  await loadOrThrow(chapters, chapters.id, chapters.tenantId, data.chapterId, data.tenantId, 'Chapter')
  const [row] = await db.insert(sections).values({
    tenantId: data.tenantId,
    createdBy: data.createdBy,
    chapterId: data.chapterId,
    name: data.name,
    order: data.order ?? 0,
  }).returning()
  return row
}

export async function listSections(chapterId: string, tenantId: string | null) {
  return db.select().from(sections)
    .where(and(eq(sections.chapterId, chapterId), readScope(sections.tenantId, tenantId)))
    .orderBy(asc(sections.order), asc(sections.name))
}

export async function createConcept(data: {
  tenantId: string | null
  createdBy: string
  sectionId: string
  name: string
  description?: string
}) {
  await loadOrThrow(sections, sections.id, sections.tenantId, data.sectionId, data.tenantId, 'Section')
  const [row] = await db.insert(concepts).values({
    tenantId: data.tenantId,
    createdBy: data.createdBy,
    sectionId: data.sectionId,
    name: data.name,
    description: data.description ?? null,
  }).returning()
  return row
}

export async function listConcepts(sectionId: string, tenantId: string | null) {
  return db.select().from(concepts)
    .where(and(eq(concepts.sectionId, sectionId), readScope(concepts.tenantId, tenantId)))
    .orderBy(asc(concepts.name))
}

// ── Hierarchy edit / delete ───────────────────────────────────────────────────
//
// Mutations are scoped to the acting tenant (a tenant can only change its own
// nodes; the global scope only global ones). Deleting a node cascades to its
// descendants (FK onDelete: cascade), but is blocked when any bank question is
// tagged within the subtree — the question_bank FKs would otherwise be violated.

async function loadOwnedNode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any, idCol: PgColumn, tenantCol: PgColumn, id: string, tenantId: string | null, label: string,
) {
  const [row] = await db.select().from(table).where(and(eq(idCol, id), ownScope(tenantCol, tenantId))).limit(1)
  if (!row) throw Errors.NOT_FOUND(label)
  return row
}

async function assertNoBankQuestions(col: PgColumn, id: string, label: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(questionBank)
    .where(eq(col, id))
  if (Number(r.n) > 0)
    throw new AppError('CONFLICT', `Cannot delete this ${label} — ${r.n} question(s) are tagged within it. Reassign or archive them first.`, 409)
}

export async function updateSubject(id: string, tenantId: string | null, data: { name?: string; code?: string | null; gradeLevel?: string | null; language?: string; status?: string }) {
  await loadOwnedNode(subjects, subjects.id, subjects.tenantId, id, tenantId, 'Subject')
  const [row] = await db.update(subjects).set({ ...data, updatedAt: new Date() }).where(eq(subjects.id, id)).returning()
  return row
}
export async function deleteSubject(id: string, tenantId: string | null) {
  await loadOwnedNode(subjects, subjects.id, subjects.tenantId, id, tenantId, 'Subject')
  await assertNoBankQuestions(questionBank.subjectId, id, 'subject')
  await db.delete(subjects).where(eq(subjects.id, id))
  return { success: true }
}

export async function updateModule(id: string, tenantId: string | null, data: { name?: string; order?: number; status?: string }) {
  await loadOwnedNode(modules, modules.id, modules.tenantId, id, tenantId, 'Module')
  const [row] = await db.update(modules).set({ ...data, updatedAt: new Date() }).where(eq(modules.id, id)).returning()
  return row
}
export async function deleteModule(id: string, tenantId: string | null) {
  await loadOwnedNode(modules, modules.id, modules.tenantId, id, tenantId, 'Module')
  await assertNoBankQuestions(questionBank.moduleId, id, 'module')
  await db.delete(modules).where(eq(modules.id, id))
  return { success: true }
}

export async function updateChapter(id: string, tenantId: string | null, data: { name?: string; order?: number; status?: string }) {
  await loadOwnedNode(chapters, chapters.id, chapters.tenantId, id, tenantId, 'Chapter')
  const [row] = await db.update(chapters).set({ ...data, updatedAt: new Date() }).where(eq(chapters.id, id)).returning()
  return row
}
export async function deleteChapter(id: string, tenantId: string | null) {
  await loadOwnedNode(chapters, chapters.id, chapters.tenantId, id, tenantId, 'Chapter')
  await assertNoBankQuestions(questionBank.chapterId, id, 'chapter')
  await db.delete(chapters).where(eq(chapters.id, id))
  return { success: true }
}

export async function updateSection(id: string, tenantId: string | null, data: { name?: string; order?: number }) {
  await loadOwnedNode(sections, sections.id, sections.tenantId, id, tenantId, 'Section')
  const [row] = await db.update(sections).set({ ...data, updatedAt: new Date() }).where(eq(sections.id, id)).returning()
  return row
}
export async function deleteSection(id: string, tenantId: string | null) {
  await loadOwnedNode(sections, sections.id, sections.tenantId, id, tenantId, 'Section')
  await assertNoBankQuestions(questionBank.sectionId, id, 'section')
  await db.delete(sections).where(eq(sections.id, id))
  return { success: true }
}

export async function updateConcept(id: string, tenantId: string | null, data: { name?: string; description?: string | null }) {
  await loadOwnedNode(concepts, concepts.id, concepts.tenantId, id, tenantId, 'Concept')
  const [row] = await db.update(concepts).set({ ...data, updatedAt: new Date() }).where(eq(concepts.id, id)).returning()
  return row
}
export async function deleteConcept(id: string, tenantId: string | null) {
  await loadOwnedNode(concepts, concepts.id, concepts.tenantId, id, tenantId, 'Concept')
  await assertNoBankQuestions(questionBank.conceptId, id, 'concept')
  await db.delete(concepts).where(eq(concepts.id, id))
  return { success: true }
}

// ── Bank question CRUD ────────────────────────────────────────────────────────

function assertTypeAndDifficulty(type: string, difficulty: string) {
  if (!(QUESTION_TYPES as readonly string[]).includes(type))
    throw new AppError('VALIDATION', `Unknown question type: ${type}`, 422)
  if (!(DIFFICULTIES as readonly string[]).includes(difficulty))
    throw new AppError('VALIDATION', `Unknown difficulty: ${difficulty}`, 422)
}

export async function createBankQuestion(data: {
  tenantId: string | null
  createdBy: string
  hierarchy: HierarchyPathInput
  type: string
  difficulty: string
  body: string
  imageUrls?: string[]
  payload: unknown
  answerKey: unknown
  defaultMarks?: number
  defaultNegativeMarks?: number
  explanation?: string
  explanationImageUrls?: string[]
  solutionVideoUrl?: string
  tags?: string[]
  language?: string
  source?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  assertTypeAndDifficulty(data.type, data.difficulty)

  const validated = validateQuestionPayload(data.type, data.payload, data.answerKey)
  if ('error' in validated) throw new AppError('VALIDATION', validated.error, 422)

  const path = await resolveHierarchyPath(data.hierarchy, data.tenantId)

  const [row] = await db.insert(questionBank).values({
    tenantId: data.tenantId,
    createdBy: data.createdBy,
    ...path,
    type: data.type,
    difficulty: data.difficulty,
    body: data.body,
    imageUrls: data.imageUrls ?? null,
    payload: validated.payload,
    answerKey: validated.answerKey,
    defaultMarks: data.defaultMarks ?? 1,
    defaultNegativeMarks: data.defaultNegativeMarks ?? 0,
    explanation: data.explanation ?? null,
    explanationImageUrls: data.explanationImageUrls ?? null,
    solutionVideoUrl: data.solutionVideoUrl ?? null,
    tags: data.tags ?? null,
    language: data.language ?? 'en',
    source: data.source ?? null,
    metadata: data.metadata ?? null,
    status: 'draft',
  }).returning()
  return row
}

export async function listBankQuestions(tenantId: string | null, filters: BankQuestionFilters = {}) {
  const conditions: SQL[] = [readScope(questionBank.tenantId, tenantId)]

  if (filters.subjectId) conditions.push(eq(questionBank.subjectId, filters.subjectId))
  if (filters.moduleId) conditions.push(eq(questionBank.moduleId, filters.moduleId))
  if (filters.chapterId) conditions.push(eq(questionBank.chapterId, filters.chapterId))
  if (filters.sectionId) conditions.push(eq(questionBank.sectionId, filters.sectionId))
  if (filters.conceptId) conditions.push(eq(questionBank.conceptId, filters.conceptId))
  if (filters.type) conditions.push(eq(questionBank.type, filters.type))
  if (filters.difficulty) conditions.push(eq(questionBank.difficulty, filters.difficulty))
  if (filters.status) conditions.push(eq(questionBank.status, filters.status))
  if (filters.isVerified !== undefined) conditions.push(eq(questionBank.isVerified, filters.isVerified))
  if (filters.language) conditions.push(eq(questionBank.language, filters.language))
  if (filters.tags && filters.tags.length > 0)
    conditions.push(sql`${questionBank.tags} && ${filters.tags}`)
  if (filters.search) conditions.push(ilike(questionBank.body, `%${filters.search}%`))

  return db.select().from(questionBank)
    .where(and(...conditions))
    .orderBy(desc(questionBank.createdAt))
    .limit(200)
}

// Per-subject totals for the readable pool (global + own). Unfiltered by
// type/difficulty/status so the sidebar count is a stable "how many questions
// exist under this subject", independent of the active list filters.
export async function countBankQuestionsBySubject(tenantId: string | null) {
  return db
    .select({ subjectId: questionBank.subjectId, count: sql<number>`count(*)::int` })
    .from(questionBank)
    .where(readScope(questionBank.tenantId, tenantId))
    .groupBy(questionBank.subjectId)
}

/**
 * Availability preview for the test-engine wizard. Returns the counts that
 * generation would actually be able to draw from — same filters as
 * `pickQuestionsForGeneration` (status = 'active', optional verifiedOnly,
 * reading global + tenant pools).
 *
 * - `chapterCounts` — per-chapter totals across the whole subject, for the
 *   "~52 qs" badges and per-module tallies (independent of what's selected).
 * - `byTypeDifficulty` — counts within the *selected* scope (chosen chapters,
 *   or the whole subject when none are checked), for the availability panel.
 * - `total` — sum of `byTypeDifficulty`.
 */
export async function getBankAvailability(params: {
  tenantId: string | null
  subjectId: string
  chapterIds?: string[]
  verifiedOnly?: boolean
}) {
  const { tenantId, subjectId, chapterIds, verifiedOnly } = params
  const verified = verifiedOnly ? [eq(questionBank.isVerified, true)] : []

  const chapterRows = await db
    .select({ chapterId: questionBank.chapterId, count: sql<number>`count(*)::int` })
    .from(questionBank)
    .where(and(
      readScope(questionBank.tenantId, tenantId),
      eq(questionBank.status, 'active'),
      eq(questionBank.subjectId, subjectId),
      ...verified,
    ))
    .groupBy(questionBank.chapterId)

  const scope: GenerationScope =
    chapterIds && chapterIds.length ? { subjectId, chapterIds } : { subjectId }

  const typeRows = await db
    .select({
      type: questionBank.type,
      difficulty: questionBank.difficulty,
      count: sql<number>`count(*)::int`,
    })
    .from(questionBank)
    .where(and(
      readScope(questionBank.tenantId, tenantId),
      eq(questionBank.status, 'active'),
      scopeCondition(scope),
      ...verified,
    ))
    .groupBy(questionBank.type, questionBank.difficulty)

  const total = typeRows.reduce((s, r) => s + r.count, 0)

  return {
    chapterCounts: chapterRows
      .filter((r) => r.chapterId)
      .map((r) => ({ chapterId: r.chapterId as string, count: r.count })),
    byTypeDifficulty: typeRows.map((r) => ({ type: r.type, difficulty: r.difficulty, count: r.count })),
    total,
  }
}

export async function getBankQuestion(id: string, tenantId: string | null) {
  const [row] = await db.select().from(questionBank)
    .where(and(eq(questionBank.id, id), readScope(questionBank.tenantId, tenantId)))
    .limit(1)
  if (!row) throw Errors.NOT_FOUND('Question')
  return row
}

async function loadOwnedBankQuestion(id: string, tenantId: string | null) {
  const [row] = await db.select().from(questionBank)
    .where(and(eq(questionBank.id, id), ownScope(questionBank.tenantId, tenantId)))
    .limit(1)
  if (!row) throw Errors.NOT_FOUND('Question')
  return row
}

export async function updateBankQuestion(
  id: string,
  tenantId: string | null,
  data: {
    hierarchy?: HierarchyPathInput
    difficulty?: string
    body?: string
    imageUrls?: string[] | null
    payload?: unknown
    answerKey?: unknown
    defaultMarks?: number
    defaultNegativeMarks?: number
    explanation?: string | null
    explanationImageUrls?: string[] | null
    solutionVideoUrl?: string | null
    tags?: string[] | null
    language?: string
    source?: Record<string, unknown> | null
    metadata?: Record<string, unknown> | null
  },
) {
  const existing = await loadOwnedBankQuestion(id, tenantId)

  const update: Record<string, unknown> = { updatedAt: new Date() }

  if (data.difficulty !== undefined) {
    assertTypeAndDifficulty(existing.type, data.difficulty)
    update.difficulty = data.difficulty
  }

  if (data.payload !== undefined || data.answerKey !== undefined) {
    const validated = validateQuestionPayload(
      existing.type,
      data.payload ?? existing.payload,
      data.answerKey ?? existing.answerKey,
    )
    if ('error' in validated) throw new AppError('VALIDATION', validated.error, 422)
    update.payload = validated.payload
    update.answerKey = validated.answerKey
    // Content changed — it must be re-verified before re-entering generation.
    update.isVerified = false
    update.verifiedBy = null
    update.verifiedAt = null
  }

  if (data.hierarchy !== undefined) {
    const path = await resolveHierarchyPath(data.hierarchy, tenantId)
    Object.assign(update, path)
  }

  if (data.body !== undefined) update.body = data.body
  if (data.imageUrls !== undefined) update.imageUrls = data.imageUrls
  if (data.defaultMarks !== undefined) update.defaultMarks = data.defaultMarks
  if (data.defaultNegativeMarks !== undefined) update.defaultNegativeMarks = data.defaultNegativeMarks
  if (data.explanation !== undefined) update.explanation = data.explanation
  if (data.explanationImageUrls !== undefined) update.explanationImageUrls = data.explanationImageUrls
  if (data.solutionVideoUrl !== undefined) update.solutionVideoUrl = data.solutionVideoUrl
  if (data.tags !== undefined) update.tags = data.tags
  if (data.language !== undefined) update.language = data.language
  if (data.source !== undefined) update.source = data.source
  if (data.metadata !== undefined) update.metadata = data.metadata

  const [row] = await db.update(questionBank).set(update).where(eq(questionBank.id, id)).returning()
  return row
}

export async function verifyBankQuestion(id: string, tenantId: string | null, verifiedBy: string) {
  await loadOwnedBankQuestion(id, tenantId)
  const [row] = await db.update(questionBank).set({
    isVerified: true,
    verifiedBy,
    verifiedAt: new Date(),
    status: 'active',
    updatedAt: new Date(),
  }).where(eq(questionBank.id, id)).returning()
  return row
}

export async function flagBankQuestion(id: string, tenantId: string | null, reason: string) {
  await loadOwnedBankQuestion(id, tenantId)
  const [row] = await db.update(questionBank).set({
    status: 'flagged',
    flagReason: reason,
    updatedAt: new Date(),
  }).where(eq(questionBank.id, id)).returning()
  return row
}

export async function archiveBankQuestion(id: string, tenantId: string | null) {
  await loadOwnedBankQuestion(id, tenantId)
  const [row] = await db.update(questionBank).set({
    status: 'archived',
    updatedAt: new Date(),
  }).where(eq(questionBank.id, id)).returning()
  return row
}

// ── Generation support (called by the exam module's generator) ─────────────────
//
// Picks random `active` questions for one (type, difficulty) bucket within a
// hierarchy scope, reading both the global pool and the tenant's own pool. The
// scope may span several nodes at one level (e.g. a multi-chapter test); the
// query filters at the finest level the caller populated.

export interface GenerationScope {
  subjectId: string
  moduleIds?: string[]
  chapterIds?: string[]
  sectionIds?: string[]
  conceptIds?: string[]
}

function scopeCondition(scope: GenerationScope): SQL {
  if (scope.conceptIds?.length) return inArray(questionBank.conceptId, scope.conceptIds)
  if (scope.sectionIds?.length) return inArray(questionBank.sectionId, scope.sectionIds)
  if (scope.chapterIds?.length) return inArray(questionBank.chapterId, scope.chapterIds)
  if (scope.moduleIds?.length) return inArray(questionBank.moduleId, scope.moduleIds)
  return eq(questionBank.subjectId, scope.subjectId)
}

export async function pickQuestionsForGeneration(params: {
  tenantId: string
  scope: GenerationScope
  type: string
  difficulty: Difficulty
  limit: number
  excludeIds?: string[]
  verifiedOnly?: boolean
  language?: string
  sourceType?: string
  cognitiveLevels?: string[]
}) {
  if (params.limit <= 0) return []

  const conditions: SQL[] = [
    readScope(questionBank.tenantId, params.tenantId),
    eq(questionBank.status, 'active'),
    eq(questionBank.type, params.type),
    eq(questionBank.difficulty, params.difficulty),
    scopeCondition(params.scope),
  ]

  if (params.verifiedOnly) conditions.push(eq(questionBank.isVerified, true))
  if (params.language) conditions.push(eq(questionBank.language, params.language))
  // Restrict by question origin, e.g. PYQ-only or NCERT/textbook-only tests.
  if (params.sourceType)
    conditions.push(sql`${questionBank.source} ->> 'type' = ${params.sourceType}`)
  // Restrict by Bloom's cognitive level (stored in metadata).
  if (params.cognitiveLevels && params.cognitiveLevels.length > 0)
    conditions.push(or(...params.cognitiveLevels.map((l) => sql`${questionBank.metadata} ->> 'cognitiveLevel' = ${l}`))!)
  if (params.excludeIds && params.excludeIds.length > 0)
    conditions.push(notInArray(questionBank.id, params.excludeIds))

  return db.select().from(questionBank)
    .where(and(...conditions))
    .orderBy(sql`random()`)
    .limit(params.limit)
}

// Bumps usageCount for the bank rows a generated exam drew from.
export async function incrementUsage(bankQuestionIds: string[]) {
  if (bankQuestionIds.length === 0) return
  await db.update(questionBank)
    .set({ usageCount: sql`${questionBank.usageCount} + 1` })
    .where(inArray(questionBank.id, bankQuestionIds))
}

// Recomputes avgSuccessRate for the given bank questions from graded session
// answers across every exam that copied them (lineage via questions.bankQuestionId).
// Only graded answers (isCorrect not null) count. Best-effort — call after grading.
export async function refreshSuccessRates(bankQuestionIds: string[]) {
  const ids = bankQuestionIds.filter(Boolean)
  if (ids.length === 0) return

  const rows = await db
    .select({
      bankQuestionId: questions.bankQuestionId,
      total: sql<number>`count(*) filter (where ${sessionAnswers.isCorrect} is not null)`,
      correct: sql<number>`count(*) filter (where ${sessionAnswers.isCorrect} = true)`,
    })
    .from(sessionAnswers)
    .innerJoin(questions, eq(sessionAnswers.questionId, questions.id))
    .where(inArray(questions.bankQuestionId, ids))
    .groupBy(questions.bankQuestionId)

  for (const r of rows) {
    if (!r.bankQuestionId || Number(r.total) === 0) continue
    const rate = (Number(r.correct) / Number(r.total)).toFixed(4)
    await db.update(questionBank)
      .set({ avgSuccessRate: rate, updatedAt: new Date() })
      .where(eq(questionBank.id, r.bankQuestionId))
  }
}
