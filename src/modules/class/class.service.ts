import { eq, and, sql, desc, inArray } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { classes, classMembers, joinCodes, CLASS_CODE_CHARS } from './class.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { users } from '../auth/auth.schema.js'
import { assertWithinLimit } from '../billing/billing.service.js'
import { dispatch } from '@modules/notification/index.js'

// ── Class CRUD ──────────────────────────────────────────────────────────────

export async function createClass(data: {
  tenantId: string
  teacherId: string
  name: string
  grade?: string
  description?: string
  autoApprove?: boolean
}) {
  await assertWithinLimit(data.tenantId, 'classes')

  const [cls] = await db
    .insert(classes)
    .values({
      tenantId: data.tenantId,
      teacherId: data.teacherId,
      name: data.name,
      grade: data.grade ?? null,
      description: data.description ?? null,
      autoApprove: data.autoApprove ?? true,
    })
    .returning()

  return cls
}

/**
 * Owner-only: move a batch to a different teacher. The new owner must be a
 * teacher (or the coaching owner) who belongs to THIS tenant. Kept separate
 * from `updateClass` so a teacher can never reassign a class away from
 * themselves — this path is gated to `coaching_owner` at the route level.
 */
export async function reassignClassTeacher(
  classId: string,
  tenantId: string,
  newTeacherId: string,
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, newTeacherId), eq(memberships.tenantId, tenantId)))
    .limit(1)
  if (!member || (member.role !== 'teacher' && member.role !== 'coaching_owner')) {
    throw new AppError('INVALID_TEACHER', 'The selected user is not a teacher in this coaching', 400)
  }

  if (cls.teacherId === newTeacherId) return cls

  const [updated] = await db
    .update(classes)
    .set({ teacherId: newTeacherId, updatedAt: new Date() })
    .where(eq(classes.id, classId))
    .returning()

  // Let the new teacher know the batch is now theirs. Fire-and-forget.
  void dispatch({
    type: 'class_update',
    recipients: { userIds: [newTeacherId] },
    tenantId,
    data: {
      title: 'A batch was assigned to you',
      body: `You are now the teacher for "${updated.name}".`,
      link: `/classes/${updated.id}`,
    },
  })

  return updated
}

export async function getClass(id: string, tenantId: string) {
  const [cls] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.id, id), eq(classes.tenantId, tenantId)))
    .limit(1)
  return cls ?? null
}

export async function updateClass(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  data: { name?: string; grade?: string | null; description?: string | null; autoApprove?: boolean },
) {
  const cls = await getClass(id, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only edit classes you created', 403)
  }

  const [updated] = await db
    .update(classes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(classes.id, id))
    .returning()

  return updated
}

export async function deleteClass(
  id: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const cls = await getClass(id, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only delete classes you created', 403)
  }

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
    .select({
      id: classes.id,
      tenantId: classes.tenantId,
      teacherId: classes.teacherId,
      name: classes.name,
      grade: classes.grade,
      description: classes.description,
      autoApprove: classes.autoApprove,
      createdAt: classes.createdAt,
      updatedAt: classes.updatedAt,
      // Owner-only listing shows which teacher owns each batch.
      teacherName: users.name,
    })
    .from(classes)
    .leftJoin(users, eq(users.id, classes.teacherId))
    .where(eq(classes.tenantId, tenantId))
    .orderBy(classes.createdAt)
  return attachEnrollmentCounts(rows)
}

export async function getClassesForTeacher(teacherId: string, tenantId: string) {
  const rows = await db
    .select()
    .from(classes)
    .where(and(eq(classes.teacherId, teacherId), eq(classes.tenantId, tenantId)))
    .orderBy(classes.createdAt)
  return attachEnrollmentCounts(rows)
}

export async function getClassesForStudent(studentId: string, tenantId: string) {
  return db
    .select({
      id: classes.id,
      tenantId: classes.tenantId,
      teacherId: classes.teacherId,
      name: classes.name,
      grade: classes.grade,
      description: classes.description,
      autoApprove: classes.autoApprove,
      createdAt: classes.createdAt,
      updatedAt: classes.updatedAt,
    })
    .from(classes)
    .innerJoin(classMembers, eq(classMembers.classId, classes.id))
    .where(
      and(
        eq(classMembers.studentId, studentId),
        eq(classes.tenantId, tenantId),
        eq(classMembers.status, 'approved'),
      ),
    )
    .orderBy(classes.createdAt)
}

// ── Class join codes ────────────────────────────────────────────────────────

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
  requesterId: string,
  requesterRole: string,
  options?: { expiresAt?: Date; maxUses?: number },
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')
  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only manage join codes for your own classes', 403)
  }

  const code = await generateUniqueClassCode()
  const [record] = await db
    .insert(joinCodes)
    .values({
      code,
      classId,
      tenantId,
      createdBy: requesterId,
      expiresAt: options?.expiresAt ?? null,
      maxUses: options?.maxUses ?? 9999,
    })
    .returning()
  return record
}

export async function listClassJoinCodes(
  classId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')
  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only view join codes for your own classes', 403)
  }

  return db
    .select()
    .from(joinCodes)
    .where(and(eq(joinCodes.classId, classId), eq(joinCodes.revoked, false)))
    .orderBy(desc(joinCodes.createdAt))
}

export async function revokeClassJoinCode(
  classId: string,
  tenantId: string,
  requesterId: string,
  requesterRole: string,
  codeId: string,
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')
  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only manage join codes for your own classes', 403)
  }

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
    .select({ autoApprove: classes.autoApprove, teacherId: classes.teacherId, name: classes.name })
    .from(classes)
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

  void dispatch({
    type: 'class_update',
    recipients: { userIds: [cls.teacherId] },
    tenantId: record.tenantId,
    data: {
      title: status === 'approved' ? 'New student enrolled' : 'New enrollment request',
      body: status === 'approved'
        ? `A student has enrolled in ${cls.name}.`
        : `A student has requested to join ${cls.name} and is awaiting approval.`,
    },
  })

  return {
    success: true,
    status,
    message:
      status === 'approved'
        ? 'You have been enrolled in the class'
        : 'Your enrollment request is pending teacher approval',
  }
}

// ── Enrollment management (teacher/owner) ───────────────────────────────────

export async function listClassStudents(classId: string, tenantId: string, status?: string) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')

  const conditions = status
    ? and(eq(classMembers.classId, classId), eq(classMembers.status, status))
    : eq(classMembers.classId, classId)

  return db
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
}

export async function updateEnrollmentStatus(
  classId: string,
  tenantId: string,
  studentId: string,
  requesterId: string,
  requesterRole: string,
  action: 'approve' | 'reject',
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')
  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only manage students in your own classes', 403)
  }

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

export async function removeStudentFromClass(
  classId: string,
  tenantId: string,
  studentId: string,
  requesterId: string,
  requesterRole: string,
) {
  const cls = await getClass(classId, tenantId)
  if (!cls) throw Errors.NOT_FOUND('Class')
  if (requesterRole !== 'coaching_owner' && cls.teacherId !== requesterId) {
    throw new AppError('FORBIDDEN', 'You can only manage students in your own classes', 403)
  }

  const [member] = await db
    .select({ id: classMembers.id })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.studentId, studentId)))
    .limit(1)
  if (!member) throw Errors.NOT_FOUND('Student enrollment')

  await db.delete(classMembers).where(eq(classMembers.id, member.id))
  return { success: true }
}
