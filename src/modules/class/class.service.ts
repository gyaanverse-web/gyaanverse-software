import { eq, and, sql, desc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { AppError, Errors } from '../../shared/errors.js'
import { classes, classMembers, joinCodes, CLASS_CODE_CHARS } from './class.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { users } from '../auth/auth.schema.js'
import { assertWithinLimit } from '../billing/billing.service.js'

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

export async function getAllClasses(tenantId: string) {
  return db.select().from(classes).where(eq(classes.tenantId, tenantId)).orderBy(classes.createdAt)
}

export async function getClassesForTeacher(teacherId: string, tenantId: string) {
  return db
    .select()
    .from(classes)
    .where(and(eq(classes.teacherId, teacherId), eq(classes.tenantId, tenantId)))
    .orderBy(classes.createdAt)
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
    .select({ autoApprove: classes.autoApprove })
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
