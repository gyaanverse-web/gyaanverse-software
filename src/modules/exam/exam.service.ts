import { eq, ne, and, inArray, sql, desc, asc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import {
  exams, questions, examChapters, examClasses, examStatusHistory,
} from './exam.schema.js'
import { WIZARD_STEPS, STUDENT_VISIBLE_STATUSES } from './exam.types.js'
import type { ExamStatus, WizardState } from './exam.types.js'
import { examPurchases } from '../payment/payment.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { reports } from '../report/report.schema.js'
import { classes, classMembers } from '../class/class.schema.js'
import { assertWithinLimit, assertHasFeature } from '../billing/billing.service.js'
import { validateQuestionPayload } from './exam.validators.js'
import { memberships } from '../membership/membership.schema.js'
import { dispatch } from '@modules/notification/index.js'

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Load an exam the caller is allowed to AUTHOR.
 *
 * Authoring is a **teacher** capability. The coaching owner (the PRD "Admin")
 * reviews, approves, schedules and runs papers — they never write them. This is
 * the hard role split: an owner who also wants to teach needs a teacher account,
 * because "owner = teacher with extra buttons" is exactly the confusion this
 * separation exists to remove.
 *
 * Within the teacher role, authorship is per-person: a teacher may only touch
 * papers they created, never a colleague's.
 */
export async function assertExamAuthor(
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
  if (requesterRole !== 'teacher')
    throw new AppError(
      'FORBIDDEN',
      'Only a teacher can author exams. Coaching owners review and schedule them.',
      403,
    )
  if (exam.createdBy !== requesterId)
    throw new AppError('FORBIDDEN', 'You can only manage exams you created', 403)
  return exam
}

/**
 * Load an exam the caller is allowed to READ in the staff UI.
 *
 * Teachers see only their own papers. The owner sees every paper in the coaching
 * **except drafts** — an unsubmitted draft is the teacher's private workspace and
 * must never surface in an admin view. A hidden exam answers 404 rather than 403
 * so the owner cannot probe for the existence of a colleague's unfinished paper.
 */
export async function loadVisibleExam(
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

  if (requesterRole === 'coaching_owner') {
    if (exam.status === 'draft') throw Errors.NOT_FOUND('Exam')
    return exam
  }
  if (exam.createdBy !== requesterId) throw Errors.NOT_FOUND('Exam')
  return exam
}

/**
 * Resolve class ids to rows, asserting every one belongs to the tenant. Used by
 * every path that links an exam to a class (wizard generation, manual linking)
 * so a caller can never attach an exam to another tenant's class by id.
 */
export async function resolveTenantClasses(classIds: string[], tenantId: string) {
  if (classIds.length === 0) return []
  const rows = await db
    .select({ id: classes.id, name: classes.name, grade: classes.grade })
    .from(classes)
    .where(and(inArray(classes.id, classIds), eq(classes.tenantId, tenantId)))
  if (rows.length !== new Set(classIds).size) throw Errors.NOT_FOUND('Class')
  return rows
}

// ── Exam state machine ───────────────────────────────────────────────────────
//
// Every status change must go through `transitionExam` so that (a) only allowed
// transitions happen, (b) the acting role is authorised, and (c) a row is
// written to `exam_status_history` for the PRD timeline. Direct
// `db.update(exams).set({ status })` is disallowed outside this section.
//
// Actor kinds:
//   'author' — the teacher who created the exam. NOT the coaching owner: under
//              the hard role split the owner never authors or submits a paper.
//   'owner'  — a coaching_owner only (the PRD "Admin").
//   'system' — the time-triggered worker (no user), or a coaching_owner override.
//   'author_or_owner' — the authoring teacher in the normal flow, with the owner
//              permitted as an audited break-glass. Used only for publishing
//              results; see the note on that transition below.

type TransitionActorKind = 'author' | 'owner' | 'system' | 'author_or_owner'
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
  // NOTE: `rejected` is deliberately TERMINAL — there is no rejected→draft hop.
  // The admin has two distinct verdicts: `changes_requested` means "fix these
  // points and resubmit" (teacher regains edit rights and may re-enter review),
  // while `rejected` means the paper itself is not usable. A teacher who wants
  // to salvage a rejected exam duplicates it into a fresh draft instead.
  // Approve & Schedule: owner sets batch/date/time, then schedules
  'approved->scheduled': 'owner',
  // Time-triggered lifecycle (worker); a coaching_owner may override
  'scheduled->live': 'system',
  'live->under_evaluation': 'system',
  // Evaluation finished for every session — the exam surfaces in the teacher's
  // "Ready to Publish" bucket, where they review each student's report before
  // releasing anything. Driven by the worker, not by a human click.
  'under_evaluation->ready_to_publish': 'system',
  // The teacher publishes, which both reveals results to students AND finishes
  // the lifecycle — see the `completed` note in exam.types.ts.
  //
  // Normally author-only: the owner reviews and schedules papers, they do not
  // publish them. The owner is nevertheless allowed here as a BREAK-GLASS,
  // because 'author' means the one specific teacher who created the exam — if
  // that person leaves the coaching, is deactivated, or is simply away, an
  // author-only rule would strand the exam in `ready_to_publish` forever and
  // students would never receive marks that are already computed. The override
  // is recorded in `exam_status_history` with the owner's actorId, so "who
  // published this" is always answerable.
  'ready_to_publish->completed': 'author_or_owner',
  // Wrap up
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
      if (actor.role !== 'teacher')
        throw new AppError(
          'FORBIDDEN',
          'Only the authoring teacher can perform this action',
          403,
        )
      if (exam.createdBy !== actor.id)
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
    case 'author_or_owner':
      // Null actor = the worker (public-exam auto-publish); allowed.
      if (!actor) return
      if (actor.role === 'coaching_owner') return
      if (actor.role !== 'teacher')
        throw new AppError(
          'FORBIDDEN',
          'Only the authoring teacher or the coaching owner can perform this action',
          403,
        )
      if (exam.createdBy !== actor.id)
        throw new AppError('FORBIDDEN', 'You can only manage exams you created', 403)
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
              link: `/coaching/exams/${exam.id}`,
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
            link: `/coaching/exams/${exam.id}`,
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
            link: `/coaching/exams/${exam.id}`,
            metadata: { examId: exam.id, remarks: remarks ?? null },
          },
        })
        break
      // Approval and scheduling are separate admin decisions and can be days
      // apart, so each gets its own notification. Approval is the one the
      // teacher is waiting on; scheduling tells them when it will actually run.
      case 'approved':
        await dispatch({
          type: 'exam_approved',
          recipients: { userIds: [exam.createdBy] },
          tenantId: exam.tenantId,
          data: {
            title: 'Your exam was approved',
            body: `"${exam.title}" has been approved. It will run once your admin schedules it.`,
            link: `/coaching/exams/${exam.id}`,
            metadata: { examId: exam.id },
          },
        })
        break
      case 'scheduled':
        await dispatch({
          type: 'exam_scheduled',
          recipients: { userIds: [exam.createdBy] },
          tenantId: exam.tenantId,
          data: {
            title: 'Your exam was scheduled',
            body: `"${exam.title}" is scheduled${exam.scheduledAt ? ` for ${exam.scheduledAt.toISOString()}` : ''}.`,
            link: `/coaching/exams/${exam.id}`,
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
              // Students land on the instruction sheet, never straight in.
              link: `/student/exams/${exam.id}/intro`,
              metadata: { examId: exam.id },
            },
          })
        break
      }
      // `completed` IS the publish event (see exam.types.ts). The notification is
      // named for what it means to the student receiving it, not for the status.
      case 'completed': {
        const classIds = await getExamClassIds(exam.id)
        for (const classId of classIds)
          await dispatch({
            type: 'results_published',
            recipients: { classId },
            tenantId: exam.tenantId,
            data: {
              title: 'Results published',
              body: `Results for "${exam.title}" are now available.`,
              // No session id here (this fires per class, not per attempt), so
              // the honest destination is the student's own results list.
              link: `/student/results`,
              metadata: { examId: exam.id },
            },
          })
        break
      }
      // Evaluation finished — tell the teacher their review queue has an item.
      case 'ready_to_publish':
        await dispatch({
          type: 'exam_ready_to_publish',
          recipients: { userIds: [exam.createdBy] },
          tenantId: exam.tenantId,
          data: {
            title: 'Exam ready to publish',
            body: `All sessions for "${exam.title}" have been evaluated. Review the reports and publish results.`,
            link: `/coaching/exams/${exam.id}`,
            metadata: { examId: exam.id },
          },
        })
        break
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
 * live→under_evaluation, under_evaluation→ready_to_publish, and the public-exam
 * ready_to_publish→completed auto-publish).
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
    case 'completed':
      // Publishing and completing are the same moment now, so stamp both.
      // `resultsPublishedAt` is kept because report/marketplace reads key off it.
      patch.resultsPublishedAt = now
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
//
// `ready_to_publish` is deliberately NOT here. That state means "evaluated and
// waiting on the teacher's review" — the scores exist but nobody outside the
// coaching may see them yet. Adding it would leak marks before the teacher has
// looked at them, which is the entire point of the review step.
export const RESULTS_VISIBLE_STATUSES: ReadonlySet<ExamStatus> = new Set([
  'completed',
])

// Defined in exam.types so class.service can share it; re-exported here because
// callers have always imported it from this module.
export { STUDENT_VISIBLE_STATUSES }

function assertExamEditable(exam: { status: string }) {
  if (!EDITABLE_STATUSES.has(exam.status as ExamStatus))
    throw Errors.VALIDATION(
      `This exam can only be edited while in draft or changes_requested (currently ${exam.status})`,
    )
}

/**
 * Guard for student-facing results / report / evaluation reads. Private
 * (coaching) exams hide scores until the teacher publishes results — status
 * must be `completed`. Public marketplace exams are self-paced and show results
 * as soon as they are evaluated, so they are exempt.
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
  // No monthly-quota check here: creating a draft is free. The `mocks_per_month`
  // limit is charged when the paper is submitted for review (see submitForReview),
  // so abandoned drafts never cost the coaching anything.
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

// ── Resumable authoring wizard ───────────────────────────────────────────────
//
// The teacher clicks "Generate a paper" and a draft exists from that instant —
// before a single question has been picked. Every step of the wizard writes its
// form state back to that row, so closing the tab, navigating away, or coming
// back tomorrow all resume at the same place. Drafts are private to their author
// (see `staffExamScope` / `loadVisibleExam`): the admin panel never shows them.

/** Placeholder title for a draft the teacher has not named yet. */
export const UNTITLED_DRAFT_TITLE = 'Untitled paper'

/**
 * Open a brand-new wizard draft. Deliberately takes no content: the paper is
 * still empty and gets its title, subject, classes and questions as the teacher
 * walks the steps. Teacher-only — the owner does not author.
 */
export async function startWizardDraft(params: {
  tenantId: string
  createdBy: string
  requesterRole: string
  title?: string
}) {
  if (params.requesterRole !== 'teacher')
    throw new AppError(
      'FORBIDDEN',
      'Only a teacher can author exams. Coaching owners review and schedule them.',
      403,
    )

  const [exam] = await db
    .insert(exams)
    .values({
      tenantId: params.tenantId,
      createdBy: params.createdBy,
      title: params.title?.trim() || UNTITLED_DRAFT_TITLE,
      // Placeholder until the generator computes an estimate from the picked
      // questions; the teacher can override it on the review step.
      durationMins: 60,
      visibility: 'private',
      status: 'draft',
      wizardStep: 1,
      wizardState: {},
    })
    .returning()

  return exam
}

/**
 * Autosave one step of the wizard. Called on every step change and on tab close,
 * so it must be cheap and idempotent.
 *
 * `state` REPLACES the stored blob rather than merging: the client owns the
 * whole form, and a merge would strip nothing when the teacher clears a
 * selection (deselecting every chapter has to persist as "no chapters", not as
 * "keep yesterday's chapters").
 *
 * Only allowed while the exam is still editable — once it is submitted for
 * review the paper is frozen, and a stray autosave from a stale tab must not
 * mutate it.
 */
export async function saveWizardState(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  data: { step: number; state: WizardState; title?: string },
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)

  if (!Number.isInteger(data.step) || data.step < 1 || data.step > WIZARD_STEPS)
    throw Errors.VALIDATION(`step must be an integer between 1 and ${WIZARD_STEPS}`)

  const patch: Record<string, unknown> = {
    wizardStep: data.step,
    wizardState: data.state,
    updatedAt: new Date(),
  }
  // The title lives on the exam itself (it is real exam metadata, not wizard
  // scratch state), so the wizard's title field writes through to it.
  const title = data.title?.trim()
  if (title) patch.title = title

  const [updated] = await db.update(exams).set(patch).where(eq(exams.id, examId)).returning()
  return updated
}

/**
 * The teacher's own drafts — the "resume where you left off" list on the test
 * engine landing page. Newest activity first, so the paper they were last
 * working on is at the top.
 */
export async function listMyDrafts(tenantId: string, requesterId: string) {
  // `questionCount` drives the "3 of 20 questions" progress line on the resume
  // card, so it comes back with the list rather than costing a request per row.
  return db
    .select({
      id: exams.id,
      title: exams.title,
      status: exams.status,
      subjectId: exams.subjectId,
      totalMarks: exams.totalMarks,
      durationMins: exams.durationMins,
      wizardStep: exams.wizardStep,
      wizardState: exams.wizardState,
      questionCount: sql<number>`count(${questions.id})::int`,
      createdAt: exams.createdAt,
      updatedAt: exams.updatedAt,
    })
    .from(exams)
    .leftJoin(questions, eq(questions.examId, exams.id))
    .where(
      and(
        eq(exams.tenantId, tenantId),
        eq(exams.createdBy, requesterId),
        eq(exams.status, 'draft'),
      ),
    )
    .groupBy(exams.id)
    .orderBy(desc(exams.updatedAt))
}

/**
 * Abandon a draft. Only a draft may be deleted — anything that has entered the
 * review pipeline is part of the coaching's record and is archived, not removed.
 */
export async function discardDraft(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  if (exam.status !== 'draft')
    throw Errors.VALIDATION(`Only a draft can be discarded (this exam is ${exam.status})`)

  // Questions, class links and chapter links all cascade from the exam row.
  await db.delete(exams).where(eq(exams.id, examId))
  return { success: true }
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
  const exam = await assertExamAuthor(id, tenantId, requesterId, requesterRole)
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
  const exam = await assertExamAuthor(id, tenantId, requesterId, requesterRole)
  if (exam.status !== 'draft' && exam.status !== 'changes_requested')
    throw Errors.VALIDATION(`Cannot submit an exam that is ${exam.status}`)

  // The monthly mock quota is charged here rather than at draft creation, so a
  // teacher can start and abandon as many drafts as they like. A re-submission
  // after `changes_requested` is not a second mock — `submittedAt` is already
  // stamped inside this month, so it is still counted once.
  if (exam.status === 'draft') await assertWithinLimit(tenantId, 'mocks_per_month')

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
 * Publish results (`ready_to_publish → completed`), making scores/reports
 * visible to students and finishing the lifecycle.
 *
 * The exam only reaches `ready_to_publish` once the worker has confirmed every
 * session is evaluated, so by the time this is callable the teacher has already
 * been able to review each student's report. That ordering is the whole point:
 * publishing is a confirmation of reviewed numbers, not a trigger for grading.
 *
 * Normally the authoring teacher; a coaching owner is accepted as an audited
 * break-glass (see the `ready_to_publish->completed` note in EXAM_TRANSITIONS).
 * `transitionExam` enforces both and writes the actor to exam_status_history.
 */
export async function publishResults(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const [exam] = await db
    .select({ id: exams.id, status: exams.status })
    .from(exams)
    .where(and(eq(exams.id, id), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')

  if (exam.status === 'under_evaluation')
    throw Errors.VALIDATION(
      'This exam is still being evaluated. Results can be published once every session has been evaluated.',
    )
  if (exam.status !== 'ready_to_publish')
    throw Errors.VALIDATION(
      `Results can only be published from ready_to_publish (currently ${exam.status})`,
    )

  return transitionExam({
    examId: id,
    tenantId,
    to: 'completed',
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
  const source = await assertExamAuthor(id, tenantId, requesterId, requesterRole)

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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)
  await resolveTenantClasses([classId], tenantId)

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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
  assertExamEditable(exam)
  await db.delete(examClasses).where(and(eq(examClasses.examId, examId), eq(examClasses.classId, classId)))
  return { success: true }
}

export async function listExamClasses(
  examId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  // Same visibility rule as the detail view — the owner must not be able to read
  // a draft's class assignment either.
  await loadVisibleExam(examId, tenantId, requesterId, requesterRole)
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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
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
  const exam = await assertExamAuthor(examId, tenantId, requesterId, requesterRole)
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

/**
 * The row scope a staff member may list.
 *
 * Teacher → only the papers they created, in every lifecycle state.
 * Owner   → every paper in the coaching **except drafts**. A draft is the
 *           authoring teacher's private workspace: it is invisible in the admin
 *           panel until they submit it for review. The owner's involvement in an
 *           exam begins at `under_review`.
 */
function staffExamScope(tenantId: string, requesterId: string, requesterRole: string) {
  if (requesterRole === 'coaching_owner')
    return and(eq(exams.tenantId, tenantId), ne(exams.status, 'draft'))
  return and(eq(exams.tenantId, tenantId), eq(exams.createdBy, requesterId))
}

export async function listExamsForTenant(
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  statuses?: ExamStatus[],
) {
  const scope = staffExamScope(tenantId, requesterId, requesterRole)

  // Optional lifecycle filter powers the teacher/admin dashboard buckets
  // (e.g. Approval Queue = under_review, Live, Evaluation, …). An owner asking
  // for `?status=draft` still gets nothing — the scope above wins.
  const where =
    statuses && statuses.length > 0
      ? and(scope, inArray(exams.status, statuses))
      : scope

  return db.select().from(exams).where(where).orderBy(desc(exams.createdAt))
}

/**
 * Aggregate KPIs for the exams hub. Owners see stats across the whole coaching
 * minus drafts; teachers see stats scoped to exams they created. Same scope as
 * `listExamsForTenant`, so the tiles always agree with the list beneath them —
 * in particular an owner's `byStatus.draft` is always 0.
 */
export async function getExamStatsForTenant(
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const scope = staffExamScope(tenantId, requesterId, requesterRole)

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
      readyToPublish: sql<number>`count(*) filter (where ${exams.status} = 'ready_to_publish')::int`,
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
      ready_to_publish: counts.readyToPublish,
      completed: counts.completed,
      archived: counts.archived,
    },
    // Convenience aggregates for the admin hub headline tiles.
    approvalQueue: counts.underReview,
    live: counts.live,
    scheduled: counts.scheduled,
    underEvaluation: counts.underEvaluation,
    readyToPublish: counts.readyToPublish,
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

  // Which of the student's batches each exam was assigned to. `selectDistinct`
  // above collapses the join, so the linkage has to be re-attached here — it's
  // what lets a single batch's screen filter this list without its own endpoint.
  const links = await db
    .select({ examId: examClasses.examId, classId: examClasses.classId })
    .from(examClasses)
    .innerJoin(classMembers, eq(classMembers.classId, examClasses.classId))
    .where(
      and(
        inArray(examClasses.examId, rows.map((r) => r.id)),
        eq(classMembers.studentId, studentId),
        eq(classMembers.status, 'approved'),
      ),
    )

  const classesByExam = new Map<string, string[]>()
  for (const l of links) {
    const list = classesByExam.get(l.examId)
    if (list) list.push(l.classId)
    else classesByExam.set(l.examId, [l.classId])
  }

  return rows.map((r) => ({
    ...r,
    mySessions: byExam.get(r.id) ?? [],
    classIds: classesByExam.get(r.id) ?? [],
  }))
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

/**
 * Full staff view of one exam. Scoped by `loadVisibleExam`, so a teacher can
 * only open their own papers and the owner gets a 404 on anyone's draft.
 */
export async function getExamFull(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const exam = await loadVisibleExam(id, tenantId, requesterId, requesterRole)

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

/**
 * The front-page facts of a paper — how many questions of each type, for how
 * many marks — with no question content whatsoever.
 *
 * Exists so a candidate waiting for a `scheduled` exam (or deciding whether to
 * buy a paid mock) can be shown the paper's structure without any of it being
 * readable ahead of time. Everything here is printed on the cover of a physical
 * question paper, so none of it is secret; bodies, payloads and answer keys
 * never leave this function.
 */
export async function getExamStructure(
  examId: string,
): Promise<{ type: string; count: number; marks: number; negativeMarks: number }[]> {
  return db
    .select({
      type: questions.type,
      count: sql<number>`count(*)::int`,
      marks: sql<number>`max(${questions.marks})::float8`,
      negativeMarks: sql<number>`max(${questions.negativeMarks})::float8`,
    })
    .from(questions)
    .where(eq(questions.examId, examId))
    .groupBy(questions.type)
    .orderBy(sql`min(${questions.order})`)
}

export async function getExamForStudent(id: string, studentId: string, lang?: string) {
  const [exam] = await db.select().from(exams).where(eq(exams.id, id)).limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  if (!STUDENT_VISIBLE_STATUSES.has(exam.status as ExamStatus))
    throw new AppError('VALIDATION', 'This exam is not available', 422)

  const hasAccess = await canStudentAccess(studentId, id)
  if (!hasAccess) throw new AppError('FORBIDDEN', 'You do not have access to this exam', 403)

  // Upcoming exam: questions stay hidden until it goes live, but the candidate
  // waiting on the instruction sheet still gets the paper's shape (counts and
  // marks per type) so they can read the structure before the paper opens.
  if (exam.status === 'scheduled')
    return { ...exam, questions: [], structure: await getExamStructure(id) }

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
  // Shape of the paper only — what a buyer is entitled to see before paying.
  return { ...exam, structure: await getExamStructure(id) }
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

