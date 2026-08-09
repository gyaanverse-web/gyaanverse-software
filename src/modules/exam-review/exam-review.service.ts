import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { exams, examClasses } from '../exam/exam.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { transitionExam, resolveTenantClasses } from '../exam/exam.service.js'
import { forceSubmitActiveSessions } from '../exam-session/exam-session.service.js'

// The PRD "Admin" is the coaching_owner — a TENANT role, not the platform
// `super_admin`. These are owner-only exam-lifecycle controls that sit on top of
// the exam state machine (`transitionExam`), which enforces the allowed
// transitions, the acting role, and the audit trail.

type Actor = { id: string; role: string }

async function loadTenantExam(examId: string, tenantId: string) {
  const [exam] = await db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.tenantId, tenantId)))
    .limit(1)
  if (!exam) throw Errors.NOT_FOUND('Exam')
  return exam
}

// ── Review decisions ─────────────────────────────────────────────────────────

/**
 * Approve a submitted exam (`under_review → approved`). Owner-only (enforced by
 * `transitionExam`).
 *
 * Approval is a VERDICT ONLY — it deliberately does not schedule. The admin is
 * saying "this paper is good"; picking a date is a separate decision they make
 * whenever a slot is free, possibly days later. Fusing the two used to force a
 * date at approval time and, when none was given, parked the exam in `scheduled`
 * with a null `scheduledAt` — a state the lifecycle worker skips
 * (`isNotNull(scheduledAt)`), so the exam could never go live. See
 * `scheduleExam` for the second half.
 */
export async function approveExam(examId: string, tenantId: string, actor: Actor) {
  const exam = await loadTenantExam(examId, tenantId)
  if (exam.status !== 'under_review')
    throw Errors.VALIDATION(`Only exams under review can be approved (currently ${exam.status})`)

  return transitionExam({ examId, tenantId, to: 'approved', actor })
}

/**
 * Set (or change) an approved exam's run window and class assignment.
 *
 * Accepts two states on purpose:
 *   `approved`  → first scheduling, transitions to `scheduled`.
 *   `scheduled` → re-scheduling before the exam starts; the window moves but the
 *                 status does not change (there is no `scheduled → scheduled`
 *                 hop, and none is needed — nothing about the paper's approval
 *                 has changed). Without this an admin who mistyped a date would
 *                 have no way to fix it.
 *
 * Owner-only. A `live` or later exam is not re-schedulable — use the live
 * controls (`extendExamTime` / `endExam`) instead.
 */
export async function scheduleExam(
  examId: string,
  tenantId: string,
  actor: Actor,
  input: {
    classIds?: string[]
    scheduledAt: Date
    endsAt?: Date | null
    durationMins?: number
  },
) {
  if (actor.role !== 'coaching_owner') throw Errors.FORBIDDEN()

  const exam = await loadTenantExam(examId, tenantId)
  if (exam.status !== 'approved' && exam.status !== 'scheduled')
    throw Errors.VALIDATION(
      `Only an approved exam can be scheduled (currently ${exam.status})`,
    )

  // A start time already in the past would be picked up by the very next
  // lifecycle tick and go live immediately — almost always a typo rather than an
  // intent. "Start it right now" has its own explicit control (`goLiveExam`).
  if (input.scheduledAt.getTime() <= Date.now())
    throw Errors.VALIDATION('scheduledAt must be in the future')

  if (input.endsAt && input.endsAt <= input.scheduledAt)
    throw Errors.VALIDATION('endsAt must be after scheduledAt')

  if (input.classIds) await resolveTenantClasses(input.classIds, tenantId)

  await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { scheduledAt: input.scheduledAt, updatedAt: new Date() }
    if (input.endsAt !== undefined) patch.endsAt = input.endsAt
    if (input.durationMins !== undefined) patch.durationMins = input.durationMins
    await tx.update(exams).set(patch).where(eq(exams.id, examId))

    if (input.classIds) {
      await tx.delete(examClasses).where(eq(examClasses.examId, examId))
      if (input.classIds.length > 0)
        await tx.insert(examClasses).values(input.classIds.map((classId) => ({ examId, classId })))
    }

    // A private exam reaches students only through class assignment, so it must
    // still have at least one class once any replacement above is applied.
    // Checked inside the transaction so a rejection rolls the window and the
    // class links back rather than leaving the exam half-updated.
    if (exam.visibility === 'private') {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(examClasses)
        .where(eq(examClasses.examId, examId))
      if (count === 0)
        throw Errors.VALIDATION('A private exam needs at least one class to be scheduled')
    }
  })

  if (exam.status === 'approved') return transitionExam({ examId, tenantId, to: 'scheduled', actor })
  return loadTenantExam(examId, tenantId)
}

/** Bounce a submitted exam back to the teacher with remarks (under_review → changes_requested). */
export async function requestChanges(examId: string, tenantId: string, actor: Actor, remarks: string) {
  return transitionExam({ examId, tenantId, to: 'changes_requested', actor, remarks })
}

/** Reject a submitted exam with remarks (under_review → rejected). */
export async function rejectExam(examId: string, tenantId: string, actor: Actor, remarks: string) {
  return transitionExam({ examId, tenantId, to: 'rejected', actor, remarks })
}

// ── Live controls ────────────────────────────────────────────────────────────

/** Start a scheduled exam early (scheduled → live). Normally the worker does this at scheduledAt. */
export async function goLiveExam(examId: string, tenantId: string, actor: Actor) {
  return transitionExam({ examId, tenantId, to: 'live', actor })
}

/**
 * End a live exam early: force-submit every active session (so nothing is left
 * ungraded), then transition live → under_evaluation.
 */
export async function endExam(examId: string, tenantId: string, actor: Actor) {
  const updated = await transitionExam({ examId, tenantId, to: 'under_evaluation', actor })
  await forceSubmitActiveSessions(examId)
  return updated
}

/**
 * Extend a live exam's window by `addMinutes`, bumping both the exam `endsAt`
 * and every in-progress session's `expiresAt` so students actually get the time.
 * Owner-only; live-only.
 */
export async function extendExamTime(examId: string, tenantId: string, actor: Actor, addMinutes: number) {
  if (actor.role !== 'coaching_owner') throw Errors.FORBIDDEN()
  const exam = await loadTenantExam(examId, tenantId)
  if (exam.status !== 'live')
    throw Errors.VALIDATION(`Time can only be extended while the exam is live (currently ${exam.status})`)

  await db.transaction(async (tx) => {
    if (exam.endsAt)
      await tx
        .update(exams)
        .set({ endsAt: new Date(exam.endsAt.getTime() + addMinutes * 60_000), updatedAt: new Date() })
        .where(eq(exams.id, examId))

    await tx
      .update(examSessions)
      .set({ expiresAt: sql`${examSessions.expiresAt} + make_interval(mins => ${addMinutes})` })
      .where(and(eq(examSessions.examId, examId), eq(examSessions.status, 'in_progress')))
  })

  return loadTenantExam(examId, tenantId)
}

/** Force-submit all active sessions for a live exam without ending it. */
export async function forceSubmitExam(examId: string, tenantId: string, actor: Actor) {
  if (actor.role !== 'coaching_owner') throw Errors.FORBIDDEN()
  const exam = await loadTenantExam(examId, tenantId)
  if (exam.status !== 'live')
    throw Errors.VALIDATION(`Sessions can only be force-submitted while the exam is live (currently ${exam.status})`)
  return forceSubmitActiveSessions(examId)
}
