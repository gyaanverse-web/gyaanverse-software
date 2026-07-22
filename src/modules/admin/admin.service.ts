import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { exams, examClasses } from '../exam/exam.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { transitionExam } from '../exam/exam.service.js'
import { forceSubmitActiveSessions } from '../exam-session/exam-session.service.js'

// The PRD "Admin" is the coaching_owner. These are owner-only exam-lifecycle
// controls that sit on top of the exam state machine (`transitionExam`), which
// enforces the allowed transitions, the acting role, and the audit trail.

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
 * Approve a submitted exam and schedule it. Sets the run window / class-batch
 * assignment, then walks `under_review → approved → scheduled` (two audited
 * hops). Owner-only (enforced by `transitionExam`).
 */
export async function approveAndScheduleExam(
  examId: string,
  tenantId: string,
  actor: Actor,
  input: {
    classIds?: string[]
    scheduledAt?: Date | null
    endsAt?: Date | null
    durationMins?: number
  },
) {
  const exam = await loadTenantExam(examId, tenantId)
  if (exam.status !== 'under_review')
    throw Errors.VALIDATION(`Only exams under review can be approved (currently ${exam.status})`)

  if (input.scheduledAt && input.endsAt && input.endsAt <= input.scheduledAt)
    throw Errors.VALIDATION('endsAt must be after scheduledAt')

  // A private exam must reach at least one class. The submit gate already
  // guaranteed this; only block the admin from clearing it to empty here.
  if (exam.visibility === 'private' && input.classIds && input.classIds.length === 0)
    throw Errors.VALIDATION('A private exam needs at least one class to be scheduled')

  await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (input.scheduledAt !== undefined) patch.scheduledAt = input.scheduledAt
    if (input.endsAt !== undefined) patch.endsAt = input.endsAt
    if (input.durationMins !== undefined) patch.durationMins = input.durationMins
    await tx.update(exams).set(patch).where(eq(exams.id, examId))

    if (input.classIds) {
      await tx.delete(examClasses).where(eq(examClasses.examId, examId))
      if (input.classIds.length > 0)
        await tx.insert(examClasses).values(input.classIds.map((classId) => ({ examId, classId })))
    }
  })

  await transitionExam({ examId, tenantId, to: 'approved', actor })
  return transitionExam({ examId, tenantId, to: 'scheduled', actor })
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
