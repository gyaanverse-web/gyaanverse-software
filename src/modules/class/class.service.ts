import { eq, and, sql, desc, inArray } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { classes, classMembers, classTeachers, joinCodes, CLASS_CODE_CHARS } from './class.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'
import { exams, examClasses } from '../exam/exam.schema.js'
import { STUDENT_VISIBLE_STATUSES } from '../exam/exam.types.js'
import { assertWithinLimit } from '../billing/billing.service.js'
import { dispatch } from '@modules/notification/index.js'
import type { ClassTeacherRef } from './class.types.js'

// ── Access model ────────────────────────────────────────────────────────────
//
// The coaching owner runs every class: creates, edits, deletes, assigns
// teachers, issues join codes, approves students. Every write route is gated to
// `coaching_owner`, so the service functions for those writes do no role
// checks of their own.
//
// A teacher is assigned to batches through `class_teachers` (many-to-many, all
// equal) and gets read-only access to exactly those batches — the class, its
// roster, and the right to target them with an exam. An unassigned teacher is
// told the class does not exist.

type Viewer = { role: string; id: string }

// ── Teacher assignment ──────────────────────────────────────────────────────

export async function isTeacherAssigned(classId: string, teacherId: string) {
  const [row] = await db
    .select({ id: classTeachers.id })
    .from(classTeachers)
    .where(and(eq(classTeachers.classId, classId), eq(classTeachers.teacherId, teacherId)))
    .limit(1)
  return !!row
}

export async function getAssignedClassIds(teacherId: string, tenantId: string) {
  const rows = await db
    .select({ classId: classTeachers.classId })
    .from(classTeachers)
    .where(and(eq(classTeachers.teacherId, teacherId), eq(classTeachers.tenantId, tenantId)))
  return rows.map((r) => r.classId)
}

/**
 * Every id must be a `teacher` membership of this tenant. The coaching owner is
 * deliberately not assignable — under the hard role split the owner never
 * teaches a batch, and they already see every class anyway.
 */
async function assertTeachersInTenant(teacherIds: string[], tenantId: string) {
  if (teacherIds.length === 0) return
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.role, 'teacher'),
        inArray(memberships.userId, teacherIds),
      ),
    )
  if (rows.length !== teacherIds.length) {
    throw new AppError('INVALID_TEACHER', 'Every selected user must be a teacher in this coaching', 400)
  }
}

function notifyAssigned(teacherIds: string[], tenantId: string, cls: { id: string; name: string }) {
  if (teacherIds.length === 0) return
  void dispatch({
    type: 'class_update',
    recipients: { userIds: teacherIds },
    tenantId,
    data: {
      title: 'You were assigned to a batch',
      body: `You are now a teacher for "${cls.name}".`,
      link: `/coaching/batches/${cls.id}`,
    },
  })
}

/**
 * Replace the batch's teacher list with `teacherIds`. Diffed rather than
 * wiped, so an unchanged teacher keeps their original `assignedAt`, and only
 * newly added teachers are notified.
 */
export async function setClassTeachers(
  classId: string,
  tenantId: string,
  assignedBy: string,
  teacherIds: string[],
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const wanted = [...new Set(teacherIds)]
  await assertTeachersInTenant(wanted, tenantId)

  const current = await db
    .select({ teacherId: classTeachers.teacherId })
    .from(classTeachers)
    .where(eq(classTeachers.classId, classId))
  const currentIds = new Set(current.map((r) => r.teacherId))
  const added = wanted.filter((id) => !currentIds.has(id))
  const removed = [...currentIds].filter((id) => !wanted.includes(id))

  await db.transaction(async (tx) => {
    if (removed.length > 0) {
      await tx
        .delete(classTeachers)
        .where(and(eq(classTeachers.classId, classId), inArray(classTeachers.teacherId, removed)))
    }
    if (added.length > 0) {
      await tx
        .insert(classTeachers)
        .values(added.map((teacherId) => ({ classId, teacherId, tenantId, assignedBy })))
    }
  })

  notifyAssigned(added, tenantId, cls)

  const [withTeachers] = await attachTeachers([cls])
  return withTeachers
}

/** Attach `teachers: {id, name}[]` to class rows — one query for the whole page. */
async function attachTeachers<T extends { id: string }>(
  rows: T[],
): Promise<(T & { teachers: ClassTeacherRef[] })[]> {
  if (rows.length === 0) return []
  const assigned = await db
    .select({ classId: classTeachers.classId, id: users.id, name: users.name })
    .from(classTeachers)
    .innerJoin(users, eq(users.id, classTeachers.teacherId))
    .where(inArray(classTeachers.classId, rows.map((r) => r.id)))
    .orderBy(classTeachers.assignedAt)

  const byClass = new Map<string, ClassTeacherRef[]>()
  for (const a of assigned) {
    const list = byClass.get(a.classId) ?? []
    list.push({ id: a.id, name: a.name })
    byClass.set(a.classId, list)
  }
  return rows.map((r) => ({ ...r, teachers: byClass.get(r.id) ?? [] }))
}

// ── Class CRUD (owner) ──────────────────────────────────────────────────────

export async function createClass(data: {
  tenantId: string
  createdBy: string
  name: string
  grade?: string
  description?: string
  autoApprove?: boolean
  teacherIds?: string[]
}) {
  await assertWithinLimit(data.tenantId, 'classes')

  const teacherIds = [...new Set(data.teacherIds ?? [])]
  await assertTeachersInTenant(teacherIds, data.tenantId)

  const cls = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(classes)
      .values({
        tenantId: data.tenantId,
        name: data.name,
        grade: data.grade ?? null,
        description: data.description ?? null,
        autoApprove: data.autoApprove ?? true,
      })
      .returning()

    if (teacherIds.length > 0) {
      await tx.insert(classTeachers).values(
        teacherIds.map((teacherId) => ({
          classId: row.id,
          teacherId,
          tenantId: data.tenantId,
          assignedBy: data.createdBy,
        })),
      )
    }
    return row
  })

  notifyAssigned(teacherIds, data.tenantId, cls)

  const [withTeachers] = await attachTeachers([cls])
  return withTeachers
}

export async function getClass(id: string, tenantId: string) {
  const [cls] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.id, id), eq(classes.tenantId, tenantId)))
    .limit(1)
  return cls ?? null
}

/**
 * A single batch as `viewer` may see it. A teacher who isn't assigned gets a
 * 404 — the batch's existence is not theirs to learn.
 */
export async function getClassForViewer(id: string, tenantId: string, viewer: Viewer) {
  const cls = await getClass(id, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')
  if (viewer.role === 'teacher' && !(await isTeacherAssigned(id, viewer.id))) {
    throw Errors.NOT_FOUND('Class')
  }
  const [withTeachers] = await attachTeachers([cls])
  return withTeachers
}

export async function updateClass(
  id: string,
  tenantId: string,
  data: { name?: string; grade?: string | null; description?: string | null; autoApprove?: boolean },
) {
  const cls = await getClass(id, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const [updated] = await db
    .update(classes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(classes.id, id))
    .returning()

  const [withTeachers] = await attachTeachers([updated])
  return withTeachers
}

export async function deleteClass(id: string, tenantId: string) {
  const cls = await getClass(id, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  // class_teachers rows go with the class (on delete cascade).
  await db.transaction(async (tx) => {
    await tx.delete(classMembers).where(eq(classMembers.classId, id))
    await tx.delete(joinCodes).where(eq(joinCodes.classId, id))
    await tx.delete(classes).where(eq(classes.id, id))
  })

  return { success: true }
}

/**
 * Enrich class rows with `studentCount` (approved enrollments) and
 * `pendingCount` (enrollments awaiting approval). One grouped query for the
 * whole page — no per-class round-trips.
 */
async function attachEnrollmentCounts<T extends { id: string }>(
  rows: T[],
): Promise<(T & { studentCount: number; pendingCount: number })[]> {
  if (rows.length === 0) return []
  const counts = await db
    .select({
      classId: classMembers.classId,
      studentCount: sql<number>`count(*) filter (where ${classMembers.status} = 'approved')`.mapWith(Number),
      pendingCount: sql<number>`count(*) filter (where ${classMembers.status} = 'pending')`.mapWith(Number),
    })
    .from(classMembers)
    .where(inArray(classMembers.classId, rows.map((r) => r.id)))
    .groupBy(classMembers.classId)

  const byId = new Map(counts.map((c) => [c.classId, c]))
  return rows.map((r) => ({
    ...r,
    studentCount: byId.get(r.id)?.studentCount ?? 0,
    pendingCount: byId.get(r.id)?.pendingCount ?? 0,
  }))
}

export async function getAllClasses(tenantId: string) {
  const rows = await db
    .select()
    .from(classes)
    .where(eq(classes.tenantId, tenantId))
    .orderBy(classes.createdAt)
  return attachTeachers(await attachEnrollmentCounts(rows))
}

/** "My Classes" for a teacher: only the batches the owner assigned them to. */
export async function getClassesForTeacher(teacherId: string, tenantId: string) {
  const rows = await db
    .select({
      id: classes.id,
      tenantId: classes.tenantId,
      name: classes.name,
      grade: classes.grade,
      description: classes.description,
      autoApprove: classes.autoApprove,
      createdAt: classes.createdAt,
      updatedAt: classes.updatedAt,
    })
    .from(classes)
    .innerJoin(classTeachers, eq(classTeachers.classId, classes.id))
    .where(and(eq(classTeachers.teacherId, teacherId), eq(classes.tenantId, tenantId)))
    .orderBy(classes.createdAt)
  return attachTeachers(await attachEnrollmentCounts(rows))
}

/**
 * Batches this student is in — approved *and* pending.
 *
 * Pending rows are included deliberately: a class with `autoApprove: false`
 * leaves the student waiting on approval, and filtering those out made their
 * "My classes" screen look identical to never having joined at all. The caller
 * distinguishes the two with `enrollmentStatus`. Rejected rows stay hidden —
 * the decision is not something to keep showing the student.
 */
export async function getClassesForStudent(studentId: string, tenantId: string) {
  const rows = await db
    .select({
      id: classes.id,
      tenantId: classes.tenantId,
      name: classes.name,
      grade: classes.grade,
      description: classes.description,
      autoApprove: classes.autoApprove,
      createdAt: classes.createdAt,
      updatedAt: classes.updatedAt,
      // Student-only fields: their own row in the batch.
      enrollmentStatus: classMembers.status,
      enrolledAt: classMembers.enrolledAt,
    })
    .from(classes)
    .innerJoin(classMembers, eq(classMembers.classId, classes.id))
    .where(
      and(
        eq(classMembers.studentId, studentId),
        eq(classes.tenantId, tenantId),
        inArray(classMembers.status, ['approved', 'pending']),
      ),
    )
    .orderBy(classes.createdAt)

  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)

  // Classmates: approved only. A student shouldn't learn how many requests are
  // sitting in the approval queue — that's the staff-side `pendingCount`.
  const memberCounts = await db
    .select({
      classId: classMembers.classId,
      studentCount: sql<number>`count(*) filter (where ${classMembers.status} = 'approved')`.mapWith(Number),
    })
    .from(classMembers)
    .where(inArray(classMembers.classId, ids))
    .groupBy(classMembers.classId)

  // Exams the batch has been assigned, in the same lifecycle states the student
  // can actually see on their exams screen — so this count matches that list.
  const examCounts = await db
    .select({
      classId: examClasses.classId,
      examCount: sql<number>`count(distinct ${examClasses.examId})`.mapWith(Number),
    })
    .from(examClasses)
    .innerJoin(exams, eq(exams.id, examClasses.examId))
    .where(
      and(
        inArray(examClasses.classId, ids),
        inArray(exams.status, [...STUDENT_VISIBLE_STATUSES] as string[]),
      ),
    )
    .groupBy(examClasses.classId)

  const members = new Map(memberCounts.map((c) => [c.classId, c.studentCount]))
  const examsByClass = new Map(examCounts.map((c) => [c.classId, c.examCount]))
  return attachTeachers(
    rows.map((r) => ({
      ...r,
      studentCount: members.get(r.id) ?? 0,
      examCount: examsByClass.get(r.id) ?? 0,
    })),
  )
}

// ── Class join codes (owner) ────────────────────────────────────────────────

async function generateUniqueClassCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = Array.from(
      { length: 8 },
      () => CLASS_CODE_CHARS[Math.floor(Math.random() * CLASS_CODE_CHARS.length)],
    ).join('')
    const [existing] = await db
      .select({ id: joinCodes.id })
      .from(joinCodes)
      .where(eq(joinCodes.code, code))
      .limit(1)
    if (!existing) return code
  }
  throw new AppError('INTERNAL_ERROR', 'Failed to generate a unique join code, try again', 500)
}

export async function generateClassJoinCode(
  classId: string,
  tenantId: string,
  createdBy: string,
  options?: { expiresAt?: Date; maxUses?: number },
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const code = await generateUniqueClassCode()
  const [record] = await db
    .insert(joinCodes)
    .values({
      code,
      classId,
      tenantId,
      createdBy,
      expiresAt: options?.expiresAt ?? null,
      maxUses: options?.maxUses ?? 9999,
    })
    .returning()
  return record
}

export async function listClassJoinCodes(classId: string, tenantId: string) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  return db
    .select()
    .from(joinCodes)
    .where(and(eq(joinCodes.classId, classId), eq(joinCodes.revoked, false)))
    .orderBy(desc(joinCodes.createdAt))
}

export async function revokeClassJoinCode(classId: string, tenantId: string, codeId: string) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const [record] = await db
    .select({ id: joinCodes.id })
    .from(joinCodes)
    .where(and(eq(joinCodes.id, codeId), eq(joinCodes.classId, classId)))
    .limit(1)
  if (!record) throw Errors.NOT_FOUND('Join code')

  await db.update(joinCodes).set({ revoked: true }).where(eq(joinCodes.id, codeId))
  return { success: true }
}

// ── Student self-enrollment via join code ───────────────────────────────────

export async function previewClassJoinCode(code: string) {
  const [record] = await db
    .select()
    .from(joinCodes)
    .where(eq(joinCodes.code, code.toUpperCase()))
    .limit(1)
  if (!record) throw Errors.NOT_FOUND('Join code')
  if (record.revoked) throw new AppError('JOIN_CODE_REVOKED', 'This join code has been revoked', 400)
  if (record.expiresAt && new Date() > record.expiresAt)
    throw new AppError('JOIN_CODE_EXPIRED', 'This join code has expired', 400)
  if (record.usedCount >= record.maxUses)
    throw new AppError('JOIN_CODE_EXHAUSTED', 'This join code has reached its usage limit', 400)

  const [cls] = await db
    .select({ id: classes.id, name: classes.name, grade: classes.grade, autoApprove: classes.autoApprove })
    .from(classes)
    .where(eq(classes.id, record.classId))
    .limit(1)
  if (!cls) throw Errors.NOT_FOUND('Class')

  return { class: cls }
}

export async function useClassJoinCode(userId: string, code: string) {
  const [record] = await db
    .select()
    .from(joinCodes)
    .where(eq(joinCodes.code, code.toUpperCase()))
    .limit(1)
  if (!record) throw Errors.NOT_FOUND('Join code')
  if (record.revoked) throw new AppError('JOIN_CODE_REVOKED', 'This join code has been revoked', 400)
  if (record.expiresAt && new Date() > record.expiresAt)
    throw new AppError('JOIN_CODE_EXPIRED', 'This join code has expired', 400)
  if (record.usedCount >= record.maxUses)
    throw new AppError('JOIN_CODE_EXHAUSTED', 'This join code has reached its usage limit', 400)

  // Must already be a student member of this coaching institute
  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.tenantId, record.tenantId),
        eq(memberships.role, 'student'),
      ),
    )
    .limit(1)
  if (!membership)
    throw new AppError('NOT_A_MEMBER', 'You must join the coaching institute before enrolling in a class', 403)

  // Check existing enrollment
  const [existing] = await db
    .select({ id: classMembers.id, status: classMembers.status })
    .from(classMembers)
    .where(and(eq(classMembers.classId, record.classId), eq(classMembers.studentId, userId)))
    .limit(1)

  if (existing) {
    if (existing.status === 'approved')
      throw new AppError('ALREADY_ENROLLED', 'You are already enrolled in this class', 409)
    if (existing.status === 'pending')
      throw new AppError('ENROLLMENT_PENDING', 'Your enrollment request is already pending approval', 409)
    // rejected — remove old row and let them re-request
    await db.delete(classMembers).where(eq(classMembers.id, existing.id))
  }

  const [cls] = await db
    .select({ id: classes.id, autoApprove: classes.autoApprove, name: classes.name, ownerId: tenants.ownerId })
    .from(classes)
    .innerJoin(tenants, eq(tenants.id, classes.tenantId))
    .where(eq(classes.id, record.classId))
    .limit(1)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const status = cls.autoApprove ? 'approved' : 'pending'

  await db.transaction(async (tx) => {
    await tx.insert(classMembers).values({ classId: record.classId, studentId: userId, status })
    await tx
      .update(joinCodes)
      .set({ usedCount: sql`${joinCodes.usedCount} + 1` })
      .where(eq(joinCodes.id, record.id))
  })

  // The owner approves enrollments, so the owner is the one told. Assigned
  // teachers are read-only on the batch and have nothing to act on.
  void dispatch({
    type: 'class_update',
    recipients: { userIds: [cls.ownerId] },
    tenantId: record.tenantId,
    data: {
      title: status === 'approved' ? 'New student enrolled' : 'New enrollment request',
      body: status === 'approved'
        ? `A student has enrolled in ${cls.name}.`
        : `A student has requested to join ${cls.name} and is awaiting approval.`,
      link: `/coaching/batches/${cls.id}`,
    },
  })

  return {
    success: true,
    status,
    message:
      status === 'approved'
        ? 'You have been enrolled in the class'
        : 'Your enrollment request is pending approval',
  }
}

// ── Enrollment management ───────────────────────────────────────────────────

/**
 * The batch roster.
 *
 * The owner and the batch's assigned teachers get the full record — name,
 * email, phone. An unassigned teacher is told the batch does not exist. A
 * **student** may also read the roster of a batch they're approved in
 * (classmates are not a secret from each other), but under two restrictions
 * enforced here rather than at the route:
 *
 *   - approved rows only — pending and rejected requests are between the
 *     applicant and the owner, not public to the batch;
 *   - names only — contact details are staff-only, so a shared join code can
 *     never turn into a scrape of every classmate's email and phone number.
 */
export async function listClassStudents(
  classId: string,
  tenantId: string,
  status: string | undefined,
  viewer: Viewer,
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  if (viewer.role === 'teacher' && !(await isTeacherAssigned(classId, viewer.id))) {
    throw Errors.NOT_FOUND('Class')
  }

  const asStudent = viewer.role === 'student'
  if (asStudent) {
    const [own] = await db
      .select({ status: classMembers.status })
      .from(classMembers)
      .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, viewer.id)))
      .limit(1)
    if (!own || own.status !== 'approved') {
      throw new AppError(
        'FORBIDDEN',
        'You can only view the roster of a batch you are enrolled in',
        403,
      )
    }
  }

  const effectiveStatus = asStudent ? 'approved' : status
  const conditions = effectiveStatus
    ? and(eq(classMembers.classId, classId), eq(classMembers.status, effectiveStatus))
    : eq(classMembers.classId, classId)

  const rows = await db
    .select({
      id: classMembers.id,
      studentId: classMembers.studentId,
      status: classMembers.status,
      enrolledAt: classMembers.enrolledAt,
      name: users.name,
      email: users.email,
      phoneNumber: users.phoneNumber,
    })
    .from(classMembers)
    .innerJoin(users, eq(users.id, classMembers.studentId))
    .where(conditions)
    .orderBy(classMembers.enrolledAt)

  if (!asStudent) return rows
  return rows.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    status: r.status,
    enrolledAt: r.enrolledAt,
    name: r.name,
  }))
}

export async function updateEnrollmentStatus(
  classId: string,
  tenantId: string,
  studentId: string,
  action: 'approve' | 'reject',
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const [member] = await db
    .select({ id: classMembers.id, status: classMembers.status })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentId)))
    .limit(1)
  if (!member) throw Errors.NOT_FOUND('Enrollment request')
  if (member.status !== 'pending')
    throw new AppError('VALIDATION', `Cannot ${action} an enrollment that is already ${member.status}`, 422)

  const newStatus = action === 'approve' ? 'approved' : 'rejected'
  await db.update(classMembers).set({ status: newStatus }).where(eq(classMembers.id, member.id))

  void dispatch({
    type: 'class_update',
    recipients: { userIds: [studentId] },
    tenantId,
    data: {
      title: action === 'approve' ? 'Enrollment approved' : 'Enrollment rejected',
      body: action === 'approve'
        ? `Your enrollment in ${cls.name} has been approved.`
        : `Your enrollment request for ${cls.name} was not approved.`,
    },
  })

  return { success: true, status: newStatus }
}

export async function removeStudentFromClass(classId: string, tenantId: string, studentId: string) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const [member] = await db
    .select({ id: classMembers.id })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentId)))
    .limit(1)
  if (!member) throw Errors.NOT_FOUND('Student enrollment')

  await db.delete(classMembers).where(eq(classMembers.id, member.id))
  return { success: true }
}
