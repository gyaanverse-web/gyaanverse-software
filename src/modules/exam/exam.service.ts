import { eq, and, inArray, sql, desc, asc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import {
  exams, questions, examChapters, examClasses, examStatusHistory,
} from './exam.schema.js'
import type { ExamStatus } from './exam.types.js'
import { examPurchases } from '../payment/payment.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { reports } from '../report/report.schema.js'
import { classMembers } from '../class/class.schema.js'
import { assertWithinLimit, assertHasFeature } from '../billing/billing.service.js'
import { validateQuestionPayload } from './exam.validators.js'
import { memberships } from '../membership/membership.schema.js'
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

// ── Exam state machine ───────────────────────────────────────────────────────
//
// Every status change must go through `transitionExam` so that (a) only allowed
// transitions happen, (b) the acting role is authorised, and (c) a row is
// written to `exam_status_history` for the PRD timeline. Direct
// `db.update(exams).set({ status })` is disallowed outside this section.
//
// Actor kinds:
//   'author' — the exam creator, or any coaching_owner.
//   'owner'  — a coaching_owner only (the PRD "Admin").
//   'system' — the time-triggered worker (no user), or a coaching_owner override.

type TransitionActorKind = 'author' | 'owner' | 'system'
export type TransitionActor = { id: string; role: string } | null

// Allowed transitions, keyed `${from}->${to}`. Anything absent is rejected.
const EXAM_TRANSITIONS: Record<string, TransitionActorKind> = {
  // Teacher submits / re-submits for admin review
  'draft->under_review': 'author',
  'changes_requested->under_review': 'author',
  // Admin (owner) review decisions
  'under_review->approved': 'owner',
  'under_review->changes_requested': 'owner',
  'under_review->rejected': 'owner',
  // Teacher reopens a rejected exam to rework it
  'rejected->draft': 'author',
  // Approve & Schedule: owner sets batch/date/time, then schedules
  'approved->scheduled': 'owner',
  // Time-triggered lifecycle (worker); a coaching_owner may override
  'scheduled->live': 'system',
  'live->under_evaluation': 'system',
  // Teacher publishes results (gates student visibility)
  'under_evaluation->results_published': 'author',
  // Wrap up
  'results_published->completed': 'system',
  'completed->archived': 'owner',
}

function assertTransitionAllowed(
  kind: TransitionActorKind,
  exam: { createdBy: string },
  actor: TransitionActor,
) {
  switch (kind) {
    case 'author':
      if (!actor) throw Errors.FORBIDDEN()
      if (actor.role !== 'coaching_owner' && exam.createdBy !== actor.id)
        throw new AppError('FORBIDDEN', 'You can only manage exams you created', 403)
      return
    case 'owner':
      if (!actor || actor.role !== 'coaching_owner')
        throw new AppError('FORBIDDEN', 'Only the coaching owner can perform this action', 403)
      return
    case 'system':
      // Worker calls pass a null actor; a human override must be the owner.
      if (actor && actor.role !== 'coaching_owner')
        throw new AppError('FORBIDDEN', 'Only the coaching owner can override this transition', 403)
      return
  }
}

async function getTenantOwnerIds(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'coaching_owner')))
  return rows.map((r) => r.userId)
}

async function getExamClassIds(examId: string): Promise<string[]> {
  const rows = await db.select({ classId: examClasses.classId }).from(examClasses).where(eq(examClasses.examId, examId))
  return rows.map((r) => r.classId)
}

/**
 * Fire the in-app / email notifications a status change implies. Best-effort:
 * wrapped in try/catch and called fire-and-forget from `transitionExam` so a
 * notification failure (e.g. Redis down) never rolls back the transition.
 * Centralised here so worker, admin, and teacher paths all notify identically.
 */
async function notifyTransition(exam: typeof exams.$inferSelect, to: ExamStatus, remarks?: string) {
  try {
    switch (to) {
      case 'under_review': {
        const owners = await getTenantOwnerIds(exam.tenantId)
        if (owners.length > 0)
          await dispatch({
            type: 'exam_submitted',
            recipients: { userIds: owners },
            tenantId: exam.tenantId,
            data: {
              title: 'Exam submitted for review',
              body: `"${exam.title}" was submitted and is awaiting your review.`,
              link: `/exams/${exam.id}`,
              metadata: { examId: exam.id },
            },
          })
        break
      }
      case 'changes_requested':
        await dispatch({
          type: 'exam_changes_requested',
          recipients: { userIds: [exam.createdBy] },
          tenantId: exam.tenantId,
          data: {
            title: 'Changes requested on your exam',
            body: `Changes were requested on "${exam.title}".${remarks ? ` Remarks: ${remarks}` : ''}`,
            link: `/exams/${exam.id}`,
            metadata: { examId: exam.id, remarks: remarks ?? null },
          },
        })
        break
      case 'rejected':
        await dispatch({
          type: 'exam_rejected',
          recipients: { userIds: [exam.createdBy] },
          tenantId: exam.tenantId,
          data: {
            title: 'Your exam was rejected',
            body: `"${exam.title}" was rejected.${remarks ? ` Remarks: ${remarks}` : ''}`,
            link: `/exams/${exam.id}`,
            metadata: { examId: exam.id, remarks: remarks ?? null },
          },
        })
        break
      case 'scheduled':
        await dispatch({
          type: 'exam_scheduled',
          recipients: { userIds: [exam.createdBy] },
          tenantId: exam.tenantId,
          data: {
            title: 'Your exam was approved & scheduled',
            body: `"${exam.title}" has been approved${exam.scheduledAt ? ` and is scheduled for ${exam.scheduledAt.toISOString()}` : ''}.`,
            link: `/exams/${exam.id}`,
            metadata: { examId: exam.id },
          },
        })
        break
      case 'live': {
        const classIds = await getExamClassIds(exam.id)
        for (const classId of classIds)
          await dispatch({
            type: 'exam_assigned',
            recipients: { classId },
            tenantId: exam.tenantId,
            data: {
              title: 'New exam available',
              body: `"${exam.title}" is now live. Start your attempt before it ends.`,
              link: `/exams/${exam.id}`,
              metadata: { examId: exam.id },
            },
          })
        break
      }
      case 'results_published': {
        const classIds = await getExamClassIds(exam.id)
        for (const classId of classIds)
          await dispatch({
            type: 'results_published',
            recipients: { classId },
            tenantId: exam.tenantId,
            data: {
              title: 'Results published',
              body: `Results for "${exam.title}" are now available.`,
              link: `/exams/${exam.id}`,
              metadata: { examId: exam.id },
            },
          })
        break
      }
    }
  } catch (err) {
    console.error(`[exam] transition notification failed (${to}) for ${exam.id}:`, err)
  }
}

/**
 * Move an exam to a new lifecycle status, enforcing the allowed-transition map
 * and the acting role, and recording the change in `exam_status_history`.
 * Also stamps the relevant lifecycle timestamp columns as a side effect.
 *
 * `actor` is null for system/worker-driven transitions (scheduled→live,
 * live→under_evaluation, results_published→completed).
 */
export async function transitionExam(params: {
  examId: string
  tenantId: string
  to: ExamStatus
  actor: TransitionActor
  remarks?: string
}) {
  const { examId, tenantId, to, actor, remarks } = params

  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')

  const from = exam.status as ExamStatus
  if (from === to) throw Errors.VALIDATION(`Exam is already ${to}`)

  const kind = EXAM_TRANSITIONS[`${from}->${to}`]
  if (!kind) throw Errors.VALIDATION(`Cannot move an exam from ${from} to ${to}`)

  assertTransitionAllowed(kind, exam, actor)

  const now = new Date()
  const patch: Record<string, unknown> = { status: to, updatedAt: now }
  switch (to) {
    case 'under_review':
      patch.submittedAt = now
      break
    case 'approved':
      patch.reviewedBy = actor?.id ?? null
      patch.reviewedAt = now
      break
    case 'changes_requested':
    case 'rejected':
      patch.reviewedBy = actor?.id ?? null
      patch.reviewedAt = now
      patch.reviewRemarks = remarks ?? null
      break
    case 'live':
      // First moment the exam becomes student-visible — mirror the old
      // publishedAt semantics so marketplace ordering keeps working.
      if (!exam.publishedAt) patch.publishedAt = now
      break
    case 'results_published':
      patch.resultsPublishedAt = now
      break
    case 'completed':
      patch.completedAt = now
      break
  }

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx.update(exams).set(patch).where(eq(exams.id, examId)).returning()
    await tx.insert(examStatusHistory).values({
      examId,
      fromStatus: from,
      toStatus: to,
      actorId: actor?.id ?? null,
      remarks: remarks ?? null,
    })
    return [row]
  })

  // Fire-and-forget lifecycle notifications (best-effort; never blocks/rolls back).
  void notifyTransition(updated, to, remarks)

  return updated
}

// Statuses in which the teacher may still edit exam content (metadata, questions,
// chapters, class links). Everything past submission is locked.
const EDITABLE_STATUSES: ReadonlySet<ExamStatus> = new Set(['draft', 'changes_requested'])

// Statuses in which a private exam's results are visible to students. Public
// exams are self-paced and show results as soon as they are evaluated (see
// assertResultsVisible in the read paths).
export const RESULTS_VISIBLE_STATUSES: ReadonlySet<ExamStatus> = new Set([
  'results_published', 'completed',
])

// Lifecycle statuses a student may see at all: an upcoming scheduled exam
// (metadata only — questions stay hidden until it goes live), the live exam
// itself, and every post-live state (so attempted exams remain reachable for
// "results pending" / "result ready"). Attempting is still live-only —
// startSession asserts `live` + the schedule window separately.
export const STUDENT_VISIBLE_STATUSES: ReadonlySet<ExamStatus> = new Set([
  'scheduled', 'live', 'under_evaluation', 'results_published', 'completed',
])

function assertExamEditable(exam: { status: string }) {
  if (!EDITABLE_STATUSES.has(exam.status as ExamStatus))
    throw Errors.VALIDATION(
      `This exam can only be edited while in draft or changes_requested (currently ${exam.status})`,
    )
}

/**
 * Guard for student-facing results / report / evaluation reads. Private
 * (coaching) exams hide scores until the teacher publishes results — status
 * must be `results_published` or `completed`. Public marketplace exams are
 * self-paced and show results as soon as they are evaluated, so they are exempt.
 */
export async function assertResultsVisible(examId: string) {
  const [exam] = await db
    .select({ visibility: exams.visibility, status: exams.status })
    .from(exams)
    .where(eq(exams.id, examId))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (exam.visibility === 'private' && !RESULTS_VISIBLE_STATUSES.has(exam.status as ExamStatus))
    throw new AppError('VALIDATION', 'Results for this exam have not been published yet', 422)
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
  assertExamEditable(exam)

  if (data.visibility && data.visibility !== 'private' && exam.visibility === 'private')
    await assertHasFeature(tenantId, 'public_mocks')

  const [updated] = await db
    .update(exams)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(exams.id, id))
    .returning()

  return updated
}

/**
 * Teacher submits a draft (or a `changes_requested` exam) for admin review.
 * Replaces the old direct self-publish: the same guards (≥1 question, ≥1 class
 * for private exams, public-mock feature gate) now gate entry into the review
 * pipeline instead of gating going live. The actual status change goes through
 * `transitionExam` (draft|changes_requested → under_review).
 */
export async function submitForReview(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const exam = await assertExamEditor(id, tenantId, requesterId, requesterRole)
  if (exam.status !== 'draft' && exam.status !== 'changes_requested')
    throw Errors.VALIDATION(`Cannot submit an exam that is ${exam.status}`)

  const [{ count: qCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(questions)
    .where(eq(questions.examId, id))
  if (Number(qCount) === 0)
    throw Errors.VALIDATION('Add at least one question before submitting for review')

  // A private exam reaches its students only through class assignment, so it
  // must be linked to at least one class before it enters review. Public exams
  // are discoverable in the marketplace independently of classes, so they are
  // exempt from this check but require the public-mock feature.
  if (exam.visibility === 'private') {
    const [{ count: classCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(examClasses)
      .where(eq(examClasses.examId, id))
    if (Number(classCount) === 0)
      throw Errors.VALIDATION('Assign at least one class before submitting for review')
  } else {
    await assertHasFeature(tenantId, 'public_mocks')
  }

  return transitionExam({
    examId: id,
    tenantId,
    to: 'under_review',
    actor: { id: requesterId, role: requesterRole },
  })
}

/**
 * Retire a finished exam. Per the PRD this is now a `completed → archived`
 * transition restricted to the coaching owner (enforced by `transitionExam`),
 * not the old any-state teacher/owner archive.
 */
export async function archiveExam(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  return transitionExam({
    examId: id,
    tenantId,
    to: 'archived',
    actor: { id: requesterId, role: requesterRole },
  })
}

/**
 * Teacher publishes results (under_evaluation → results_published), making
 * scores/reports visible to students. The evaluation worker leaves a finished
 * exam in `under_evaluation`; this is the explicit teacher gate that reveals them.
 */
export async function publishResults(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const exam = await assertExamEditor(id, tenantId, requesterId, requesterRole)
  if (exam.status !== 'under_evaluation')
    throw Errors.VALIDATION(
      `Results can only be published from under_evaluation (currently ${exam.status})`,
    )
  return transitionExam({
    examId: id,
    tenantId,
    to: 'results_published',
    actor: { id: requesterId, role: requesterRole },
  })
}

/**
 * Clone an exam (metadata + questions + chapter coverage + class links) into a
 * fresh DRAFT owned by the requester. All lifecycle/audit fields reset. Allowed
 * from any state (e.g. duplicate a completed exam to run it again).
 */
export async function duplicateExam(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const source = await assertExamEditor(id, tenantId, requesterId, requesterRole)

  return db.transaction(async (tx) => {
    const [copy] = await tx
      .insert(exams)
      .values({
        tenantId,
        createdBy: requesterId,
        title: `${source.title} (Copy)`,
        description: source.description,
        instructions: source.instructions,
        durationMins: source.durationMins,
        estimatedDurationMins: source.estimatedDurationMins,
        generationParams: source.generationParams,
        gradeLevel: source.gradeLevel,
        subjectId: source.subjectId,
        scopeType: source.scopeType,
        visibility: source.visibility,
        price: source.price,
        maxAttempts: source.maxAttempts,
        // status defaults to 'draft'; lifecycle/audit columns start clean.
      })
      .returning()

    const sourceQuestions = await tx
      .select()
      .from(questions)
      .where(eq(questions.examId, id))
      .orderBy(asc(questions.order))
    if (sourceQuestions.length > 0) {
      await tx.insert(questions).values(
        sourceQuestions.map((q) => ({
          examId: copy.id,
          tenantId,
          bankQuestionId: q.bankQuestionId,
          order: q.order,
          type: q.type,
          difficulty: q.difficulty,
          body: q.body,
          imageUrls: q.imageUrls,
          payload: q.payload,
          answerKey: q.answerKey,
          languageVariants: q.languageVariants,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
          explanation: q.explanation,
          draftStatus: q.draftStatus,
        })),
      )
    }

    const srcChapters = await tx.select().from(examChapters).where(eq(examChapters.examId, id))
    if (srcChapters.length > 0)
      await tx.insert(examChapters).values(srcChapters.map((c) => ({ examId: copy.id, chapterId: c.chapterId })))

    const srcClasses = await tx.select().from(examClasses).where(eq(examClasses.examId, id))
    if (srcClasses.length > 0)
      await tx.insert(examClasses).values(srcClasses.map((c) => ({ examId: copy.id, classId: c.classId })))

    await recomputeTotalMarks(copy.id, tx)

    const [fresh] = await tx.select().from(exams).where(eq(exams.id, copy.id)).limit(1)
    return fresh ?? copy
  })
}

// ── Scope / access linking ─────────────────────────────────────────────────

export async function setExamChapters(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  chapterIds: string[],
) {
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)

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
  assertExamEditable(exam)

  const [existing] = await db
    .select({ id: examClasses.id })
    .from(examClasses)
    .where(and(eq(examClasses.examId, examId), eq(examClasses.classId, classId)))
    .limit(1)
  if (existing) throw Errors.CONFLICT('Class is already linked to this exam')

  const [row] = await db.insert(examClasses).values({ examId, classId }).returning()

  // Class links are only mutable while the exam is still editable (draft /
  // changes_requested), so there are never live students to notify here. The
  // go-live transition (admin/worker) is responsible for the "exam available"
  // notification — see Phase 4.
  return row
}

export async function unlinkExamFromClass(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  classId: string,
) {
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)
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
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)

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
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)

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
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)

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
  const exam = await assertExamEditor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)

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
  statuses?: ExamStatus[],
) {
  const scope =
    requesterRole === 'coaching_owner'
      ? eq(exams.tenantId, tenantId)
      : and(eq(exams.tenantId, tenantId), eq(exams.createdBy, requesterId))

  // Optional lifecycle filter powers the teacher/admin dashboard buckets
  // (e.g. Approval Queue = under_review, Live, Evaluation, …).
  const where =
    statuses && statuses.length > 0
      ? and(scope, inArray(exams.status, statuses))
      : scope

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
      // Per-status lifecycle buckets (PRD teacher/admin dashboards).
      draft: sql<number>`count(*) filter (where ${exams.status} = 'draft')::int`,
      underReview: sql<number>`count(*) filter (where ${exams.status} = 'under_review')::int`,
      changesRequested: sql<number>`count(*) filter (where ${exams.status} = 'changes_requested')::int`,
      rejected: sql<number>`count(*) filter (where ${exams.status} = 'rejected')::int`,
      approved: sql<number>`count(*) filter (where ${exams.status} = 'approved')::int`,
      scheduled: sql<number>`count(*) filter (where ${exams.status} = 'scheduled')::int`,
      live: sql<number>`count(*) filter (where ${exams.status} = 'live')::int`,
      underEvaluation: sql<number>`count(*) filter (where ${exams.status} = 'under_evaluation')::int`,
      resultsPublished: sql<number>`count(*) filter (where ${exams.status} = 'results_published')::int`,
      completed: sql<number>`count(*) filter (where ${exams.status} = 'completed')::int`,
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
    // Full lifecycle breakdown — dashboards derive their buckets from this.
    byStatus: {
      draft: counts.draft,
      under_review: counts.underReview,
      changes_requested: counts.changesRequested,
      rejected: counts.rejected,
      approved: counts.approved,
      scheduled: counts.scheduled,
      live: counts.live,
      under_evaluation: counts.underEvaluation,
      results_published: counts.resultsPublished,
      completed: counts.completed,
      archived: counts.archived,
    },
    // Convenience aggregates for the admin hub headline tiles.
    approvalQueue: counts.underReview,
    live: counts.live,
    scheduled: counts.scheduled,
    underEvaluation: counts.underEvaluation,
    publicExams: counts.publicExams,
    totalMarks: counts.totalMarks,
    totalAttempts: attempts.totalAttempts,
    submittedAttempts: attempts.submittedAttempts,
    avgScorePct: scoreRow.avgScorePct == null ? null : Number(scoreRow.avgScorePct),
  }
}

export async function listAvailableExamsForStudent(studentId: string, tenantId: string) {
  // Private exams in classes the student belongs to, across every
  // student-visible lifecycle state: `scheduled` (upcoming, locked),
  // `live` (attemptable), and post-live states (results pending/ready).
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
        inArray(exams.status, [...STUDENT_VISIBLE_STATUSES] as string[]),
        eq(exams.visibility, 'private'),
        eq(classMembers.studentId, studentId),
        eq(classMembers.status, 'approved'),
      ),
    )
    .orderBy(desc(exams.createdAt))

  if (rows.length === 0) return rows

  // Attach the student's own attempt state so the UI can tell
  // "not started / in progress / submitted / result ready" apart per exam.
  const sessions = await db
    .select({
      id: examSessions.id,
      examId: examSessions.examId,
      status: examSessions.status,
      attemptNumber: examSessions.attemptNumber,
      startedAt: examSessions.startedAt,
      submittedAt: examSessions.submittedAt,
    })
    .from(examSessions)
    .where(
      and(
        eq(examSessions.studentId, studentId),
        inArray(examSessions.examId, rows.map((r) => r.id)),
      ),
    )
    .orderBy(desc(examSessions.startedAt))

  const byExam = new Map<string, typeof sessions>()
  for (const s of sessions) {
    const list = byExam.get(s.examId)
    if (list) list.push(s)
    else byExam.set(s.examId, [s])
  }

  return rows.map((r) => ({ ...r, mySessions: byExam.get(r.id) ?? [] }))
}

export async function listPublicExams(filters?: { gradeLevel?: string; subjectId?: string }) {
  const conditions = [
    eq(exams.status, 'live'),
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

  // Approval/lifecycle timeline for the Test Overview (PRD).
  const statusHistory = await db
    .select()
    .from(examStatusHistory)
    .where(eq(examStatusHistory.examId, id))
    .orderBy(asc(examStatusHistory.createdAt))

  return { ...exam, questions: qs, statusHistory }
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
  if (!STUDENT_VISIBLE_STATUSES.has(exam.status as ExamStatus))
    throw new AppError('VALIDATION', 'This exam is not available', 422)

  const hasAccess = await canStudentAccess(studentId, id)
  if (!hasAccess) throw new AppError('FORBIDDEN', 'You do not have access to this exam', 403)

  // Upcoming exam: metadata only — questions stay hidden until it goes live.
  if (exam.status === 'scheduled') return { ...exam, questions: [] }

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

  if (!exam || !STUDENT_VISIBLE_STATUSES.has(exam.status as ExamStatus)) return false

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
  if (exam.status !== 'live') throw Errors.NOT_FOUND('Exam')
  return exam
}

export async function getPublicExamForStudent(id: string, studentId: string, lang?: string) {
  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, id), inArray(exams.visibility, ['public_free', 'public_paid'])))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (exam.status !== 'live')
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

