import { eq, and, asc, inArray, isNull, isNotNull } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { exams, questions, examClasses } from './exam.schema.js'
import { assertExamAuthor, recomputeTotalMarks, resolveTenantClasses } from './exam.service.js'
import { validateQuestionPayload } from './exam.validators.js'
import {
  validateGenerationParams, buildBuckets, estimateDurationMins,
} from './exam.generation.js'
import { assertHasFeature } from '../billing/billing.service.js'
import {
  pickQuestionsForGeneration, incrementUsage, resolveHierarchyPath,
  type GenerationScope,
} from '../question-bank/index.js'
import type { GenerationParams, ExamVisibility } from './exam.types.js'

// One (type, difficulty) bucket that the bank could not fully satisfy.
export interface BucketShortage {
  type: string
  difficulty: string
  requested: number
  filled: number
}

function deriveScopeType(params: GenerationParams): string {
  if (params.conceptIds?.length || params.sectionIds?.length) return 'custom'
  if (params.chapterIds?.length === 1) return 'single_chapter'
  if (params.chapterIds && params.chapterIds.length > 1) return 'multi_chapter'
  if (params.moduleIds?.length) return 'custom'
  return 'full_subject'
}

// ─────────────────────────────────────────────────────────────────────────────
// Fill an existing draft from the question bank: pull matching questions (pure
// SQL, no LLM), copy them into the exam as `pending` draft questions, and compute
// the estimated duration from the time matrix. Returns any buckets the bank could
// not fully fill so the teacher can adjust.
//
// This generates INTO a draft the wizard already created rather than creating an
// exam of its own — the draft exists from the moment the teacher opens the
// generator, so their work survives a closed tab (see `startWizardDraft`).
//
// Re-running it is how the wizard's Back button works: stepping back to the
// distribution step, changing the mix and regenerating replaces the previously
// generated questions. Questions the teacher wrote BY HAND (draftStatus null)
// are preserved and renumbered after the fresh picks — those were authored, not
// generated, and silently discarding them would lose real work.
//
// `classIds` are linked inside the same transaction. The wizard asks for the
// class *before* the scope/distribution, so a generated draft is never left
// classless — a state `submitForReview` would reject anyway.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateIntoDraft(input: {
  examId: string
  tenantId: string
  requesterId: string
  requesterRole: string
  title?: string
  visibility?: ExamVisibility
  durationMins?: number
  classIds?: string[]
  params: GenerationParams
}) {
  const { examId, tenantId, params } = input

  // Authoring gate: teacher, and the creator of this draft.
  const draft = await assertExamAuthor(examId, tenantId, input.requesterId, input.requesterRole)
  if (draft.status !== 'draft')
    throw new AppError(
      'VALIDATION',
      `Questions can only be generated into a draft (this exam is ${draft.status})`,
      422,
    )

  // No monthly-quota check: the quota is charged at submit-for-review, so a
  // teacher may regenerate a draft as often as they like while tuning the mix.
  const visibility = input.visibility ?? (draft.visibility as ExamVisibility)
  if (visibility !== 'private') await assertHasFeature(tenantId, 'public_mocks')

  // Resolve + tenant-check the classes before doing any generation work, so a
  // bad class id fails fast instead of after a costly bank query.
  const classIds = [...new Set(input.classIds ?? [])]
  const classRows = classIds.length > 0 ? await resolveTenantClasses(classIds, tenantId) : []

  const paramError = validateGenerationParams(params)
  if (paramError) throw new AppError('VALIDATION', paramError, 422)

  if (!params.subjectId)
    throw new AppError('VALIDATION', 'generationParams.subjectId is required', 422)

  // Validate the subject is accessible (global or own). Lower-level ids are
  // trusted — the generation query is already scoped to readable content, so an
  // out-of-scope id simply yields no matches rather than leaking anything.
  await resolveHierarchyPath({ subjectId: params.subjectId }, tenantId)

  const scope: GenerationScope = {
    subjectId: params.subjectId,
    moduleIds: params.moduleIds,
    chapterIds: params.chapterIds,
    sectionIds: params.sectionIds,
    conceptIds: params.conceptIds,
  }

  const buckets = buildBuckets(params)
  const allowRepeat = params.allowRepeatFromBank ?? false

  // Fill each bucket from the bank. Track ids already used so a single exam
  // never repeats the same bank question (unless explicitly allowed).
  type BankRow = Awaited<ReturnType<typeof pickQuestionsForGeneration>>[number]
  const pickedRows: BankRow[] = []
  const usedIds: string[] = []
  const shortages: BucketShortage[] = []

  for (const bucket of buckets) {
    const rows = await pickQuestionsForGeneration({
      tenantId,
      scope,
      type: bucket.type,
      difficulty: bucket.difficulty,
      limit: bucket.count,
      excludeIds: allowRepeat ? undefined : usedIds,
      verifiedOnly: params.verifiedOnly,
      language: params.language,
      sourceType: params.sourceType,
      cognitiveLevels: params.cognitiveLevels,
    })

    pickedRows.push(...rows)
    if (!allowRepeat) usedIds.push(...rows.map((r) => r.id))

    if (rows.length < bucket.count) {
      shortages.push({
        type: bucket.type,
        difficulty: bucket.difficulty,
        requested: bucket.count,
        filled: rows.length,
      })
    }
  }

  const estimated = estimateDurationMins(
    pickedRows.map((r) => ({ type: r.type, difficulty: r.difficulty })),
  )

  // The class the paper is for carries the grade — inherit it rather than
  // asking the teacher for the same fact twice. Falls back to null when the
  // selected classes have no grade or disagree on it.
  const grades = [...new Set(classRows.map((c) => c.grade).filter((g): g is string => !!g))]
  const gradeLevel = grades.length === 1 ? grades[0] : null

  await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = {
      durationMins: input.durationMins ?? (estimated || draft.durationMins || 1),
      estimatedDurationMins: estimated,
      generationParams: params as unknown as Record<string, unknown>,
      subjectId: params.subjectId ?? null,
      gradeLevel,
      scopeType: deriveScopeType(params),
      visibility,
      updatedAt: new Date(),
    }
    if (input.title?.trim()) patch.title = input.title.trim()
    await tx.update(exams).set(patch).where(eq(exams.id, examId))

    // Class links are replaced wholesale — the wizard sends the full selection
    // from step 1 every time, so this keeps a re-run in sync with what the
    // teacher currently has ticked.
    await tx.delete(examClasses).where(eq(examClasses.examId, examId))
    if (classIds.length > 0) {
      await tx.insert(examClasses).values(classIds.map((classId) => ({ examId, classId })))
    }

    // Drop the previous generation run, keeping hand-written questions
    // (draftStatus null) — see the note above the function.
    await tx.delete(questions).where(
      and(eq(questions.examId, examId), isNotNull(questions.draftStatus)),
    )

    if (pickedRows.length > 0) {
      await tx.insert(questions).values(
        pickedRows.map((r, i) => ({
          examId,
          tenantId,
          bankQuestionId: r.id,
          order: i + 1,
          type: r.type,
          difficulty: r.difficulty,
          body: r.body,
          imageUrls: r.imageUrls,
          payload: r.payload,
          answerKey: r.answerKey,
          languageVariants: (r.metadata?.languageVariants as Record<string, string> | undefined) ?? null,
          marks: r.defaultMarks,
          negativeMarks: r.defaultNegativeMarks,
          explanation: r.explanation,
          draftStatus: 'pending' as const,
        })),
      )
    }

    // Renumber so the surviving manual questions sit after the fresh picks
    // instead of colliding with their order values.
    const manual = await tx.select({ id: questions.id }).from(questions)
      .where(and(eq(questions.examId, examId), isNull(questions.draftStatus)))
      .orderBy(asc(questions.order))
    for (let i = 0; i < manual.length; i++) {
      await tx.update(questions).set({ order: pickedRows.length + i + 1 })
        .where(eq(questions.id, manual[i].id))
    }

    await recomputeTotalMarks(examId, tx)
  })

  // Usage analytics — best effort, outside the exam transaction.
  void incrementUsage(pickedRows.map((r) => r.id))

  // Re-read the exam so totalMarks reflects the in-transaction recompute.
  const [fresh] = await db.select().from(exams).where(eq(exams.id, examId)).limit(1)
  const draftQuestions = await db.select().from(questions)
    .where(eq(questions.examId, examId)).orderBy(asc(questions.order))

  return { exam: fresh ?? draft, questions: draftQuestions, shortages }
}

// ── Draft review ──────────────────────────────────────────────────────────────

async function loadDraftQuestion(examId: string, questionId: string) {
  const [q] = await db.select().from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.examId, examId)))
    .limit(1)
  if (!q) throw Errors.NOT_FOUND('Question')
  return q
}

function assertDraft(examStatus: string) {
  if (examStatus !== 'draft')
    throw new AppError('VALIDATION', 'Draft review is only allowed while the exam is a draft', 422)
}

export async function keepDraftQuestion(
  examId: string, questionId: string, tenantId: string, requesterId: string, requesterRole: string,
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertDraft(exam.status)
  await loadDraftQuestion(examId, questionId)
  const [q] = await db.update(questions)
    .set({ draftStatus: 'kept', updatedAt: new Date() })
    .where(eq(questions.id, questionId)).returning()
  return q
}

export async function discardDraftQuestion(
  examId: string, questionId: string, tenantId: string, requesterId: string, requesterRole: string,
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertDraft(exam.status)
  await loadDraftQuestion(examId, questionId)
  const [q] = await db.update(questions)
    .set({ draftStatus: 'discarded', updatedAt: new Date() })
    .where(eq(questions.id, questionId)).returning()
  return q
}

// Bulk "Keep All" — flip every still-`pending` draft question to `kept` in one
// query. `discarded` questions are left untouched (an explicit discard is not
// undone by Keep All). Returns the number of questions kept.
export async function keepAllDraftQuestions(
  examId: string, tenantId: string, requesterId: string, requesterRole: string,
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertDraft(exam.status)
  const updated = await db.update(questions)
    .set({ draftStatus: 'kept', updatedAt: new Date() })
    .where(and(eq(questions.examId, examId), eq(questions.draftStatus, 'pending')))
    .returning({ id: questions.id })
  return { kept: updated.length }
}

// Replace a draft question with a fresh bank pick of the same type & difficulty
// that is not already in the exam. Keeps the slot's order position.
export async function regenerateDraftQuestion(
  examId: string, questionId: string, tenantId: string, requesterId: string, requesterRole: string,
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertDraft(exam.status)
  const old = await loadDraftQuestion(examId, questionId)
  if (!old.difficulty)
    throw new AppError('VALIDATION', 'Cannot regenerate a question with no difficulty', 422)

  const params = (exam.generationParams ?? {}) as unknown as GenerationParams
  if (!params.subjectId)
    throw new AppError('VALIDATION', 'This exam was not produced by the generator', 422)

  const scope: GenerationScope = {
    subjectId: params.subjectId,
    moduleIds: params.moduleIds,
    chapterIds: params.chapterIds,
    sectionIds: params.sectionIds,
    conceptIds: params.conceptIds,
  }

  // Exclude every bank question already copied into this exam.
  const existing = await db
    .select({ bankQuestionId: questions.bankQuestionId })
    .from(questions).where(eq(questions.examId, examId))
  const excludeIds = existing
    .map((e) => e.bankQuestionId)
    .filter((id): id is string => id !== null)

  const [replacement] = await pickQuestionsForGeneration({
    tenantId,
    scope,
    type: old.type,
    difficulty: old.difficulty as 'easy' | 'medium' | 'hard',
    limit: 1,
    excludeIds,
    verifiedOnly: params.verifiedOnly,
    language: params.language,
    sourceType: params.sourceType,
    cognitiveLevels: params.cognitiveLevels,
  })

  if (!replacement)
    throw new AppError('GENERATION_EXHAUSTED', 'No other bank question is available for this type and difficulty', 409)

  const updated = await db.transaction(async (tx) => {
    const [q] = await tx.update(questions).set({
      bankQuestionId: replacement.id,
      type: replacement.type,
      difficulty: replacement.difficulty,
      body: replacement.body,
      imageUrls: replacement.imageUrls,
      payload: replacement.payload,
      answerKey: replacement.answerKey,
      marks: replacement.defaultMarks,
      negativeMarks: replacement.defaultNegativeMarks,
      explanation: replacement.explanation,
      draftStatus: 'pending',
      updatedAt: new Date(),
    }).where(eq(questions.id, questionId)).returning()
    await recomputeTotalMarks(examId, tx)
    return q
  })

  void incrementUsage([replacement.id])
  return updated
}

// Edit a draft question's content in place; editing implicitly keeps it.
// Lineage (bankQuestionId) is preserved.
export async function editDraftQuestion(
  examId: string, questionId: string, tenantId: string, requesterId: string, requesterRole: string,
  data: {
    body?: string
    imageUrls?: string[] | null
    payload?: unknown
    answerKey?: unknown
    marks?: number
    negativeMarks?: number
    explanation?: string | null
  },
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertDraft(exam.status)
  const old = await loadDraftQuestion(examId, questionId)

  let payload: Record<string, unknown> | undefined
  let answerKey: Record<string, unknown> | undefined
  if (data.payload !== undefined || data.answerKey !== undefined) {
    const result = validateQuestionPayload(old.type, data.payload ?? old.payload, data.answerKey ?? old.answerKey)
    if ('error' in result) throw new AppError('VALIDATION', result.error, 422)
    payload = result.payload
    answerKey = result.answerKey
  }

  const update: Record<string, unknown> = { draftStatus: 'kept', updatedAt: new Date() }
  if (data.body !== undefined) update.body = data.body
  if (data.imageUrls !== undefined) update.imageUrls = data.imageUrls
  if (payload !== undefined) update.payload = payload
  if (answerKey !== undefined) update.answerKey = answerKey
  if (data.marks !== undefined) update.marks = data.marks
  if (data.negativeMarks !== undefined) update.negativeMarks = data.negativeMarks
  if (data.explanation !== undefined) update.explanation = data.explanation

  const updated = await db.transaction(async (tx) => {
    const [q] = await tx.update(questions).set(update).where(eq(questions.id, questionId)).returning()
    if (data.marks !== undefined) await recomputeTotalMarks(examId, tx)
    return q
  })
  return updated
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize: drop everything the teacher did not keep (still `pending`, or
// `discarded`), renumber the survivors, and recompute marks + estimated time.
// Manually added questions (draftStatus = null) are always retained. The exam
// stays a draft — publishing remains a separate explicit step.
// ─────────────────────────────────────────────────────────────────────────────

export async function finalizeGeneration(
  examId: string, tenantId: string, requesterId: string, requesterRole: string,
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertDraft(exam.status)

  const finalized = await db.transaction(async (tx) => {
    await tx.delete(questions).where(
      and(eq(questions.examId, examId), inArray(questions.draftStatus, ['pending', 'discarded'])),
    )

    const remaining = await tx.select({ id: questions.id }).from(questions)
      .where(eq(questions.examId, examId)).orderBy(asc(questions.order))

    if (remaining.length === 0)
      throw new AppError('VALIDATION', 'Cannot finalize — every question was discarded', 422)

    for (let i = 0; i < remaining.length; i++) {
      await tx.update(questions).set({ order: i + 1 }).where(eq(questions.id, remaining[i].id))
    }

    await recomputeTotalMarks(examId, tx)

    const [updated] = await tx.update(exams)
      .set({ updatedAt: new Date() }).where(eq(exams.id, examId)).returning()
    return updated
  })

  return finalized
}
