import { eq, and, inArray, sql, desc, asc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import {
  exams, questions, examChapters, examClasses,
} from './exam.schema.js'
import { examPurchases } from '../payment/payment.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { reports } from '../report/report.schema.js'
import { classMembers } from '../class/class.schema.js'
import { assertWithinLimit, assertHasFeature } from '../billing/billing.service.js'
import { validateQuestionPayload } from './exam.validators.js'
import { dispatch } from '@modules/notification/index.js'

// ── Internal helpers ────────────────────────────────────────────────────────

export async function assertExamEditor(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (requesterRole !== 'coaching_owner' && exam.createdBy !== requesterId)
    throw new AppError('FORBIDDEN', 'You can only manage exams you created', 403)
  return exam
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recomputeTotalMarks(examId: string, tx: any = db) {
  const [{ total }] = await tx
    .select({ total: sql<number>`coalesce(sum(${questions.marks}), 0)` })
    .from(questions)
    .where(eq(questions.examId, examId))
  await tx.update(exams).set({ totalMarks: total }).where(eq(exams.id, examId))
}

// ── Exam authoring ─────────────────────────────────────────────────────────
//
// The subject/module/chapter/section/concept catalog now lives in the
// question-bank module. The exam module only references subjects (for
// `exam.subjectId`) and links chapters via `examChapters`.

export async function createExam(data: {
  tenantId: string
  createdBy: string
  title: string
  description?: string
  instructions?: string
  durationMins: number
  gradeLevel?: string
  subjectId?: string
  scopeType?: string
  visibility: 'private' | 'public_free' | 'public_paid'
  price?: string
  maxAttempts?: number
  scheduledAt?: Date
  endsAt?: Date
}) {
  await assertWithinLimit(data.tenantId, 'mocks_per_month')
  if (data.visibility !== 'private') await assertHasFeature(data.tenantId, 'public_mocks')

  const [exam] = await db
    .insert(exams)
    .values({
      tenantId: data.tenantId,
      createdBy: data.createdBy,
      title: data.title,
      description: data.description ?? null,
      instructions: data.instructions ?? null,
      durationMins: data.durationMins,
      gradeLevel: data.gradeLevel ?? null,
      subjectId: data.subjectId ?? null,
      scopeType: data.scopeType ?? 'custom',
      visibility: data.visibility,
      price: data.price ?? null,
      maxAttempts: data.maxAttempts ?? 1,
      scheduledAt: data.scheduledAt ?? null,
      endsAt: data.endsAt ?? null,
    })
    .returning()

  return exam
}

export async function updateExam(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  data: {
    title?: string
    description?: string | null
    instructions?: string | null
    durationMins?: number
    gradeLevel?: string | null
    subjectId?: string | null
    scopeType?: string
    visibility?: 'private' | 'public_free' | 'public_paid'
    price?: string | null
    maxAttempts?: number
    scheduledAt?: Date | null
    endsAt?: Date | null
  },
) {
  const exam = await assertExamEditor(id, tenantId, requesterId, requesterRole)
  if (exam.status === 'archived')
    throw new AppError('VALIDATION', 'Cannot edit an archived exam', 422)

  if (data.visibility && data.visibility !== 'private' && exam.visibility === 'private')
    await assertHasFeature(tenantId, 'public_mocks')

  const [updated] = await db
    .update(exams)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(exams.id, id))
    .returning()

  return updated
}

export async function publishExam(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const exam = await assertExamEditor(id, tenantId, requesterId, requesterRole)
  if (exam.status !== 'draft')
    throw new AppError('VALIDATION', `Cannot publish an exam that is already ${exam.status}`, 422)

  const [{ count: qCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(questions)
    .where(eq(questions.examId, id))
  if (Number(qCount) === 0)
    throw new AppError('VALIDATION', 'Add at least one question before publishing', 422)

  // A private exam reaches its students only through class assignment, so it
  // must be linked to at least one class before it can go live. Public exams
  // are discoverable in the marketplace independently of classes, so they are
  // exempt from this check.
  if (exam.visibility === 'private') {
    const [{ count: classCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(examClasses)
      .where(eq(examClasses.examId, id))
    if (Number(classCount) === 0)
      throw new AppError('VALIDATION', 'Assign at least one class before publishing', 422)
  }

  if (exam.visibility !== 'private') await assertHasFeature(tenantId, 'public_mocks')

  const [updated] = await db
    .update(exams)
    .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(exams.id, id))
    .returning()

  // Notify students in all classes already linked to this exam
  void db
    .select({ classId: examClasses.classId })
    .from(examClasses)
    .where(eq(examClasses.examId, id))
    .then((linked) => {
      for (const { classId } of linked) {
        void dispatch({
          type: 'exam_assigned',
          recipients: { classId },
          tenantId,
          data: {
            title: 'New exam assigned',
            body: `"${updated.title}" is now available. Start your attempt before the deadline.`,
            link: `/exams/${id}`,
          },
        })
      }
    })

  return updated
}

export async function archiveExam(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  await assertExamEditor(id, tenantId, requesterId, requesterRole)

  const [updated] = await db
    .update(exams)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(exams.id, id))
    .returning()

  return updated
}

// ── Scope / access linking ─────────────────────────────────────────────────

export async function setExamChapters(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  chapterIds: string[],
) {
  await assertExamEditor(examId, tenantId, requesterId, requesterRole)

  await db.transaction(async (tx) => {
    await tx.delete(examChapters).where(eq(examChapters.examId, examId))
    if (chapterIds.length > 0) {
      await tx.insert(examChapters).values(chapterIds.map((chapterId) => ({ examId, chapterId })))
    }
  })

  return db.select().from(examChapters).where(eq(examChapters.examId, examId))
}

export async function linkExamToClass(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  classId: string,
) {
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)

  const [existing] = await db
    .select({ id: examClasses.id })
    .from(examClasses)
    .where(and(eq(examClasses.examId, examId), eq(examClasses.classId, classId)))
    .limit(1)
  if (existing) throw Errors.CONFLICT('Class is already linked to this exam')

  const [row] = await db.insert(examClasses).values({ examId, classId }).returning()

  // If the exam is already published, notify students in the newly linked class
  if (exam.status === 'published') {
    void dispatch({
      type: 'exam_assigned',
      recipients: { classId },
      tenantId,
      data: {
        title: 'New exam assigned',
        body: `"${exam.title}" is now available. Start your attempt before the deadline.`,
        link: `/exams/${examId}`,
      },
    })
  }

  return row
}

export async function unlinkExamFromClass(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  classId: string,
) {
  await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  await db.delete(examClasses).where(and(eq(examClasses.examId, examId), eq(examClasses.classId, classId)))
  return { success: true }
}

export async function listExamClasses(examId: string, tenantId: string) {
  // just verify exam belongs to tenant
  const [exam] = await db
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')

  return db.select().from(examClasses).where(eq(examClasses.examId, examId))
}

// ── Question management ────────────────────────────────────────────────────

export async function addQuestion(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  data: {
    type: string
    body: string
    imageUrls?: string[]
    payload: unknown
    answerKey: unknown
    marks: number
    negativeMarks?: number
    explanation?: string
  },
) {
  await assertExamEditor(examId, tenantId, requesterId, requesterRole)

  const validated = validateQuestionPayload(data.type, data.payload, data.answerKey)
  if ('error' in validated) throw new AppError('VALIDATION_ERROR', validated.error, 422)

  // Place at end
  const [{ maxOrder }] = await db
    .select({ maxOrder: sql<number>`coalesce(max(${questions.order}), 0)` })
    .from(questions)
    .where(eq(questions.examId, examId))

  const [question] = await db.transaction(async (tx) => {
    const [q] = await tx
      .insert(questions)
      .values({
        examId,
        tenantId,
        order: maxOrder + 1,
        type: data.type,
        body: data.body,
        imageUrls: data.imageUrls ?? null,
        payload: validated.payload,
        answerKey: validated.answerKey,
        marks: data.marks,
        negativeMarks: data.negativeMarks ?? 0,
        explanation: data.explanation ?? null,
      })
      .returning()
    await recomputeTotalMarks(examId, tx)
    return [q]
  })

  return question
}

export async function updateQuestion(
  questionId: string,
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
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
  await assertExamEditor(examId, tenantId, requesterId, requesterRole)

  const [q] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.examId, examId)))
    .limit(1)
  if (!q) throw Errors.NOT_FOUND('Question')

  let validatedPayload: Record<string, unknown> | undefined
  let validatedAnswerKey: Record<string, unknown> | undefined

  if (data.payload !== undefined || data.answerKey !== undefined) {
    const result = validateQuestionPayload(
      q.type,
      data.payload ?? q.payload,
      data.answerKey ?? q.answerKey,
    )
    if ('error' in result) throw new AppError('VALIDATION_ERROR', result.error, 422)
    validatedPayload = result.payload
    validatedAnswerKey = result.answerKey
  }

  const updateData: Record<string, unknown> = {}
  if (data.body !== undefined) updateData.body = data.body
  if (data.imageUrls !== undefined) updateData.imageUrls = data.imageUrls
  if (validatedPayload !== undefined) updateData.payload = validatedPayload
  if (validatedAnswerKey !== undefined) updateData.answerKey = validatedAnswerKey
  if (data.marks !== undefined) updateData.marks = data.marks
  if (data.negativeMarks !== undefined) updateData.negativeMarks = data.negativeMarks
  if (data.explanation !== undefined) updateData.explanation = data.explanation

  const [updated] = await db.transaction(async (tx) => {
    const [upd] = await tx.update(questions).set(updateData).where(eq(questions.id, questionId)).returning()
    if (data.marks !== undefined) await recomputeTotalMarks(examId, tx)
    return [upd]
  })

  return updated
}

export async function removeQuestion(
  questionId: string,
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  await assertExamEditor(examId, tenantId, requesterId, requesterRole)

  const [q] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.examId, examId)))
    .limit(1)
  if (!q) throw Errors.NOT_FOUND('Question')

  await db.transaction(async (tx) => {
    await tx.delete(questions).where(eq(questions.id, questionId))
    await recomputeTotalMarks(examId, tx)
  })

  return { success: true }
}

export async function reorderQuestions(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  orderedIds: string[],
) {
  await assertExamEditor(examId, tenantId, requesterId, requesterRole)

  const existing = await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.examId, examId))

  const existingSet = new Set(existing.map((q) => q.id))
  if (orderedIds.length !== existingSet.size || !orderedIds.every((id) => existingSet.has(id)))
    throw new AppError('VALIDATION_ERROR', 'orderedIds must contain exactly all question ids for this exam', 422)

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.update(questions).set({ order: i + 1 }).where(eq(questions.id, orderedIds[i]))
    }
  })

  return db.select().from(questions).where(eq(questions.examId, examId)).orderBy(asc(questions.order))
}

// ── Listing ─────────────────────────────────────────────────────────────────

export async function listExamsForTenant(
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const where =
    requesterRole === 'coaching_owner'
      ? eq(exams.tenantId, tenantId)
      : and(eq(exams.tenantId, tenantId), eq(exams.createdBy, requesterId))

  return db.select().from(exams).where(where).orderBy(desc(exams.createdAt))
}

/**
 * Aggregate KPIs for the exams hub. Owners see stats across the whole tenant;
 * teachers see stats scoped to exams they created (matching listExamsForTenant).
 */
export async function getExamStatsForTenant(
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const scope =
    requesterRole === 'coaching_owner'
      ? eq(exams.tenantId, tenantId)
      : and(eq(exams.tenantId, tenantId), eq(exams.createdBy, requesterId))

  const [counts] = await db
    .select({
      totalExams: sql<number>`count(*)::int`,
      published: sql<number>`count(*) filter (where ${exams.status} = 'published')::int`,
      draft: sql<number>`count(*) filter (where ${exams.status} = 'draft')::int`,
      archived: sql<number>`count(*) filter (where ${exams.status} = 'archived')::int`,
      publicExams: sql<number>`count(*) filter (where ${exams.visibility} in ('public_free', 'public_paid'))::int`,
      totalMarks: sql<number>`coalesce(sum(${exams.totalMarks}), 0)::int`,
    })
    .from(exams)
    .where(scope)

  const [attempts] = await db
    .select({
      totalAttempts: sql<number>`count(*)::int`,
      submittedAttempts: sql<number>`count(*) filter (where ${examSessions.status} in ('submitted', 'evaluated'))::int`,
    })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .where(scope)

  const [scoreRow] = await db
    .select({
      avgScorePct: sql<number | null>`round(avg(${reports.totalScore}::numeric / nullif(${reports.maxScore}, 0)) * 100)`,
    })
    .from(reports)
    .innerJoin(exams, eq(exams.id, reports.examId))
    .where(and(scope, eq(reports.status, 'ready')))

  return {
    totalExams: counts.totalExams,
    published: counts.published,
    draft: counts.draft,
    archived: counts.archived,
    publicExams: counts.publicExams,
    totalMarks: counts.totalMarks,
    totalAttempts: attempts.totalAttempts,
    submittedAttempts: attempts.submittedAttempts,
    avgScorePct: scoreRow.avgScorePct == null ? null : Number(scoreRow.avgScorePct),
  }
}

export async function listAvailableExamsForStudent(studentId: string, tenantId: string) {
  // Private exams in classes the student belongs to
  const rows = await db
    .selectDistinct({
      id: exams.id,
      tenantId: exams.tenantId,
      createdBy: exams.createdBy,
      title: exams.title,
      description: exams.description,
      durationMins: exams.durationMins,
      gradeLevel: exams.gradeLevel,
      subjectId: exams.subjectId,
      scopeType: exams.scopeType,
      visibility: exams.visibility,
      price: exams.price,
      maxAttempts: exams.maxAttempts,
      status: exams.status,
      totalMarks: exams.totalMarks,
      publishedAt: exams.publishedAt,
      scheduledAt: exams.scheduledAt,
      endsAt: exams.endsAt,
      createdAt: exams.createdAt,
      updatedAt: exams.updatedAt,
    })
    .from(exams)
    .innerJoin(examClasses, eq(examClasses.examId, exams.id))
    .innerJoin(classMembers, eq(classMembers.classId, examClasses.classId))
    .where(
      and(
        eq(exams.tenantId, tenantId),
        eq(exams.status, 'published'),
        eq(exams.visibility, 'private'),
        eq(classMembers.studentId, studentId),
        eq(classMembers.status, 'approved'),
      ),
    )
    .orderBy(desc(exams.createdAt))

  return rows
}

export async function listPublicExams(filters?: { gradeLevel?: string; subjectId?: string }) {
  const conditions = [
    eq(exams.status, 'published'),
    inArray(exams.visibility, ['public_free', 'public_paid']),
  ]
  if (filters?.gradeLevel) conditions.push(eq(exams.gradeLevel, filters.gradeLevel))
  if (filters?.subjectId) conditions.push(eq(exams.subjectId, filters.subjectId))

  return db
    .select()
    .from(exams)
    .where(and(...conditions))
    .orderBy(desc(exams.publishedAt))
}

export async function getExamFull(id: string, tenantId: string) {
  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, id), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')

  const qs = await db
    .select()
    .from(questions)
    .where(eq(questions.examId, id))
    .orderBy(asc(questions.order))

  return { ...exam, questions: qs }
}

// Substitutes each question's body with its language variant when one exists for
// the requested language. `en` (or unset) keeps the original body.
function localizeQuestions<T extends { body: string; languageVariants?: Record<string, string> | null }>(
  qs: T[], lang?: string,
): T[] {
  if (!lang || lang === 'en') return qs
  return qs.map((q) => {
    const v = q.languageVariants?.[lang]
    return v ? { ...q, body: v } : q
  })
}

export async function getExamForStudent(id: string, studentId: string, lang?: string) {
  const [exam] = await db.select().from(exams).where(eq(exams.id, id)).limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (exam.status !== 'published')
    throw new AppError('VALIDATION', 'This exam is not available', 422)

  const hasAccess = await canStudentAccess(studentId, id)
  if (!hasAccess) throw new AppError('FORBIDDEN', 'You do not have access to this exam', 403)

  const qs = await db
    .select({
      id: questions.id,
      examId: questions.examId,
      tenantId: questions.tenantId,
      order: questions.order,
      type: questions.type,
      body: questions.body,
      imageUrls: questions.imageUrls,
      payload: questions.payload,
      marks: questions.marks,
      negativeMarks: questions.negativeMarks,
      explanation: questions.explanation,
      languageVariants: questions.languageVariants,
      createdAt: questions.createdAt,
    })
    .from(questions)
    .where(eq(questions.examId, id))
    .orderBy(asc(questions.order))

  return { ...exam, questions: localizeQuestions(qs, lang) }
}

// ── Access control ─────────────────────────────────────────────────────────

export async function canStudentAccess(studentId: string, examId: string): Promise<boolean> {
  const [exam] = await db
    .select({ status: exams.status, visibility: exams.visibility })
    .from(exams)
    .where(eq(exams.id, examId))
    .limit(1)

  if (!exam || exam.status !== 'published') return false

  switch (exam.visibility) {
    case 'public_free':
      return true

    case 'public_paid': {
      const [purchase] = await db
        .select({ id: examPurchases.id })
        .from(examPurchases)
        .where(and(eq(examPurchases.examId, examId), eq(examPurchases.studentId, studentId)))
        .limit(1)
      return !!purchase
    }

    case 'private': {
      const [access] = await db
        .select({ id: examClasses.id })
        .from(examClasses)
        .innerJoin(classMembers, eq(classMembers.classId, examClasses.classId))
        .where(
          and(
            eq(examClasses.examId, examId),
            eq(classMembers.studentId, studentId),
            eq(classMembers.status, 'approved'),
          ),
        )
        .limit(1)
      return !!access
    }

    default:
      return false
  }
}

// purchase recording belongs to the payment module;
// canStudentAccess checks examPurchases for gate enforcement only

export async function getPublicExamPreview(id: string) {
  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, id), inArray(exams.visibility, ['public_free', 'public_paid'])))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (exam.status !== 'published') throw Errors.NOT_FOUND('Exam')
  return exam
}

export async function getPublicExamForStudent(id: string, studentId: string, lang?: string) {
  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, id), inArray(exams.visibility, ['public_free', 'public_paid'])))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (exam.status !== 'published')
    throw new AppError('VALIDATION', 'This exam is not available', 422)

  const hasAccess = await canStudentAccess(studentId, id)
  if (!hasAccess) throw new AppError('FORBIDDEN', 'You do not have access to this exam', 403)

  const qs = await db
    .select({
      id: questions.id,
      examId: questions.examId,
      tenantId: questions.tenantId,
      order: questions.order,
      type: questions.type,
      body: questions.body,
      imageUrls: questions.imageUrls,
      payload: questions.payload,
      marks: questions.marks,
      negativeMarks: questions.negativeMarks,
      explanation: questions.explanation,
      languageVariants: questions.languageVariants,
      createdAt: questions.createdAt,
    })
    .from(questions)
    .where(eq(questions.examId, id))
    .orderBy(asc(questions.order))

  return { ...exam, questions: localizeQuestions(qs, lang) }
}

