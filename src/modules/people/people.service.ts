import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { Errors } from '../../shared/errors.js'
import { users } from '../auth/auth.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { classes, classMembers, classTeachers } from '../class/class.schema.js'
import { exams } from '../exam/exam.schema.js'
import { examSessions } from '../exam-session/exam-session.schema.js'
import { reports } from '../report/report.schema.js'
import { getFeesSummary, listGuardians, getOutstandingByStudent } from '../fee/index.js'
import { isFeesEnabled } from '../platform/platform.service.js'
import { RESULTS_VISIBLE_STATUSES } from '../exam/exam.service.js'
import type { ExamStatus } from '../exam/exam.types.js'
import type { Role } from '../auth/auth.types.js'
import type {
  GuardianRef,
  PersonIdentity,
  StudentActivitySummary,
  StudentBatchRef,
  StudentExamAttempt,
  StudentListRow,
  StudentProfileResponse,
  TeacherProfile,
} from './people.types.js'

/**
 * Per-person detail reads for the coaching staff screens.
 *
 * This module owns no tables. It composes `memberships`, `classes`, `exams`,
 * `exam_sessions`, `reports` and the fee module into the two profile payloads,
 * which is why it is its own module and not more functions on
 * `tenant.service.ts` — that file would otherwise become the place every
 * cross-module join goes to live.
 *
 * Two rules hold everywhere below:
 *
 *  1. **Scope failures answer 404, never 403.** A teacher must not be able to
 *     distinguish "no such student" from "a student you are not allowed to
 *     see"; a 403 confirms the person exists and that is a membership-roster
 *     leak. Same reasoning as `loadVisibleExam` in the exam module.
 *  2. **The viewer's role comes from the membership** (`req.tenantRole`), and
 *     the narrowing is done in the QUERY, not in the serialiser. A teacher's
 *     payload is missing rows because they were never selected.
 */

export interface Viewer {
  id: string
  role: Role
}

/** A paper whose existence the coaching owner is not entitled to know about. */
const PRIVATE_AUTHOR_STATUSES: readonly ExamStatus[] = ['draft']

// ── Scope guards ────────────────────────────────────────────────────────────

/**
 * Resolve a person who must hold `role` in this tenant, as their identity block.
 *
 * The membership join is what makes this tenant-safe: a user id from another
 * coaching resolves to no row and answers 404, even though the `users` row
 * exists and would have selected fine on its own.
 */
export async function assertTenantMember(
  tenantId: string,
  userId: string,
  role: Role,
): Promise<PersonIdentity> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      phone: users.phoneNumber,
      phoneVerified: users.phoneNumberVerified,
      image: users.image,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      accountCreatedAt: users.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(
      eq(memberships.tenantId, tenantId),
      eq(memberships.userId, userId),
      eq(memberships.role, role),
    ))
    .limit(1)

  if (!row) throw Errors.NOT_FOUND(role === 'teacher' ? 'Teacher' : 'Student')
  return { ...row, role: row.role as Role }
}

/**
 * Does this teacher share at least one batch with this student?
 *
 * `approved` only — a pending join request is not yet a relationship, and
 * treating it as one would let a student grant themselves visibility to a
 * teacher by requesting a batch.
 */
export async function sharesBatchWith(
  tenantId: string,
  teacherId: string,
  studentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(classTeachers)
    .innerJoin(classMembers, eq(classMembers.classId, classTeachers.classId))
    .where(and(
      eq(classTeachers.tenantId, tenantId),
      eq(classTeachers.teacherId, teacherId),
      eq(classMembers.studentId, studentId),
      eq(classMembers.status, 'approved'),
    ))
    .limit(1)
  return !!row
}

// ── Student blocks ──────────────────────────────────────────────────────────

/**
 * The student's batches in this coaching, with the teachers on each.
 *
 * `sharedWith` narrows to the batches that teacher is assigned to, which is the
 * teacher's view: they see the student's place in *their* batch and not the
 * student's whole timetable.
 */
export async function getStudentBatches(
  tenantId: string,
  studentId: string,
  opts: { sharedWith?: string } = {},
): Promise<StudentBatchRef[]> {
  const rows = await db
    .select({
      id: classes.id,
      name: classes.name,
      grade: classes.grade,
      status: classMembers.status,
      enrolledAt: classMembers.enrolledAt,
    })
    .from(classMembers)
    .innerJoin(classes, eq(classes.id, classMembers.classId))
    .where(and(
      eq(classes.tenantId, tenantId),
      eq(classMembers.studentId, studentId),
      ...(opts.sharedWith
        ? [sql`exists (select 1 from ${classTeachers} where ${classTeachers.classId} = ${classes.id} and ${classTeachers.teacherId} = ${opts.sharedWith})`]
        : []),
    ))
    .orderBy(desc(classMembers.enrolledAt))

  if (rows.length === 0) return []

  // Teacher names in one grouped query — same no-N+1 shape as `attachTeachers`
  // in the class module, which this deliberately mirrors rather than imports
  // (that one is private to class.service and keyed on its own row type).
  const assigned = await db
    .select({ classId: classTeachers.classId, id: users.id, name: users.name })
    .from(classTeachers)
    .innerJoin(users, eq(users.id, classTeachers.teacherId))
    .where(inArray(classTeachers.classId, rows.map((r) => r.id)))
    .orderBy(classTeachers.assignedAt)

  const byClass = new Map<string, { id: string; name: string }[]>()
  for (const a of assigned) {
    const list = byClass.get(a.classId) ?? []
    list.push({ id: a.id, name: a.name })
    byClass.set(a.classId, list)
  }

  return rows.map((r) => ({ ...r, teachers: byClass.get(r.id) ?? [] }))
}

/**
 * Every attempt this student has made at a paper owned by this coaching.
 *
 * One row per attempt, not per exam — a student who sat the same paper twice
 * has two rows, which is what "what has this student done" means to a reader.
 *
 * `authoredBy` narrows to one teacher's papers. A teacher may see how a student
 * did on a paper they wrote and not on a colleague's, so this is the teacher
 * view's second narrowing (the first being batches).
 */
export async function getStudentExamActivity(
  tenantId: string,
  studentId: string,
  opts: { authoredBy?: string } = {},
): Promise<StudentExamAttempt[]> {
  const rows = await db
    .select({
      sessionId: examSessions.id,
      examId: examSessions.examId,
      examTitle: exams.title,
      examStatus: exams.status,
      examVisibility: exams.visibility,
      attemptNumber: examSessions.attemptNumber,
      sessionStatus: examSessions.status,
      startedAt: examSessions.startedAt,
      submittedAt: examSessions.submittedAt,
      totalMarks: examSessions.totalMarks,
      reportId: reports.id,
      reportStatus: reports.status,
      score: reports.totalScore,
      maxScore: reports.maxScore,
    })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .leftJoin(reports, eq(reports.sessionId, examSessions.id))
    .where(and(
      eq(examSessions.tenantId, tenantId),
      eq(examSessions.studentId, studentId),
      ...(opts.authoredBy ? [eq(exams.createdBy, opts.authoredBy)] : []),
    ))
    .orderBy(desc(examSessions.startedAt))

  return rows.map((r) => ({
    sessionId: r.sessionId,
    examId: r.examId,
    examTitle: r.examTitle,
    examStatus: r.examStatus as ExamStatus,
    attemptNumber: r.attemptNumber,
    sessionStatus: r.sessionStatus,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    totalMarks: r.totalMarks,
    reportId: r.reportId,
    score: r.reportId ? r.score : null,
    maxScore: r.reportId ? r.maxScore : null,
    // Whether the STUDENT can see this mark yet, mirroring
    // `assertResultsVisible`: a private paper releases its results only once
    // the lifecycle reaches `completed`. Staff see the score either way — this
    // flag tells them whether the student has seen it, which is exactly the
    // question someone fielding "where is my result?" is trying to answer.
    resultPublished: !!r.reportId
      && r.reportStatus === 'ready'
      && (r.examVisibility !== 'private' || RESULTS_VISIBLE_STATUSES.has(r.examStatus as ExamStatus)),
  }))
}

/** Counts and mean over the attempts already fetched — no extra round-trip. */
function summarise(attempts: StudentExamAttempt[]): StudentActivitySummary {
  const scored = attempts.filter((a) => a.score !== null && a.maxScore !== null && a.maxScore > 0)
  return {
    attempted: attempts.length,
    submitted: attempts.filter((a) => a.submittedAt !== null).length,
    evaluated: scored.length,
    averagePercent: scored.length === 0
      ? null
      : Math.round(scored.reduce((sum, a) => sum + (a.score! / a.maxScore!) * 100, 0) / scored.length),
  }
}

/**
 * The student detail payload, shaped by who is asking.
 *
 * The owner gets everything. An assigned teacher gets a structurally narrower
 * object with no `fees` and no `guardians` KEY — not nulled fields — so a client
 * that forgets to branch on `scope` cannot render an empty money card. An
 * unassigned teacher gets 404 before any of this runs.
 */
export async function getStudentProfile(
  tenantId: string,
  studentId: string,
  viewer: Viewer,
): Promise<StudentProfileResponse> {
  const student = await assertTenantMember(tenantId, studentId, 'student')

  if (viewer.role === 'teacher') {
    if (!(await sharesBatchWith(tenantId, viewer.id, studentId))) {
      throw Errors.NOT_FOUND('Student')
    }
    const [batches, attempts] = await Promise.all([
      getStudentBatches(tenantId, studentId, { sharedWith: viewer.id }),
      getStudentExamActivity(tenantId, studentId, { authoredBy: viewer.id }),
    ])
    return { scope: 'teacher', student, batches, attempts, activity: summarise(attempts) }
  }

  // Owner. Fees are read only while the platform switch is on: with it off every
  // fee route answers 404 by design (`requireFeesEnabled`), so composing the
  // block anyway would put numbers on a screen whose own module is turned off.
  const feesOn = await isFeesEnabled()
  const [batches, attempts, fees, guardians] = await Promise.all([
    getStudentBatches(tenantId, studentId),
    getStudentExamActivity(tenantId, studentId),
    feesOn ? getFeesSummary(tenantId, studentId) : Promise.resolve(null),
    feesOn ? listGuardians(tenantId, studentId) : Promise.resolve([]),
  ])

  return {
    scope: 'owner',
    student,
    batches,
    attempts,
    activity: summarise(attempts),
    fees: fees && {
      totalBilled: fees.totalBilled,
      totalPaid: fees.totalPaid,
      totalWaived: fees.totalWaived,
      balance: fees.balance,
      overdueAmount: fees.overdueAmount,
      creditBalance: fees.creditBalance,
      nextDue: fees.nextDue,
    },
    guardians: guardians as GuardianRef[],
  }
}

/**
 * The students list. The owner sees every student in the coaching; a teacher
 * sees only students approved in a batch they are assigned to.
 *
 * Four grouped queries, not one join: batch counts and attempt counts would
 * multiply each other across a single join, and the fee sum would multiply
 * both. Same reasoning as `listTeachersWithWorkload`.
 */
export async function listStudents(
  tenantId: string,
  viewer: Viewer,
): Promise<StudentListRow[]> {
  const scopedToTeacher = viewer.role === 'teacher'

  const base = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phoneNumber,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(
      eq(memberships.tenantId, tenantId),
      eq(memberships.role, 'student'),
      ...(scopedToTeacher
        ? [sql`exists (
            select 1 from ${classMembers}
            join ${classTeachers} on ${classTeachers.classId} = ${classMembers.classId}
            where ${classMembers.studentId} = ${users.id}
              and ${classMembers.status} = 'approved'
              and ${classTeachers.teacherId} = ${viewer.id}
              and ${classTeachers.tenantId} = ${tenantId}
          )`]
        : []),
    ))
    .orderBy(users.name)

  if (base.length === 0) return []
  const ids = base.map((s) => s.id)

  const [batchRows, attemptRows, outstanding] = await Promise.all([
    db
      .select({
        studentId: classMembers.studentId,
        classId: classes.id,
        className: classes.name,
      })
      .from(classMembers)
      .innerJoin(classes, eq(classes.id, classMembers.classId))
      .where(and(
        eq(classes.tenantId, tenantId),
        inArray(classMembers.studentId, ids),
        eq(classMembers.status, 'approved'),
        ...(scopedToTeacher
          ? [sql`exists (select 1 from ${classTeachers} where ${classTeachers.classId} = ${classes.id} and ${classTeachers.teacherId} = ${viewer.id})`]
          : []),
      ))
      .orderBy(classes.name),
    db
      .select({
        studentId: examSessions.studentId,
        attemptCount: sql<number>`count(*)`.mapWith(Number),
        lastActiveAt: sql<Date | null>`max(${examSessions.startedAt})`,
      })
      .from(examSessions)
      .where(and(eq(examSessions.tenantId, tenantId), inArray(examSessions.studentId, ids)))
      .groupBy(examSessions.studentId),
    // Money is the owner's business, and the figure is absent rather than zero
    // for a teacher so the column can be dropped entirely client-side.
    !scopedToTeacher && (await isFeesEnabled())
      ? getOutstandingByStudent(tenantId, ids)
      : Promise.resolve(null),
  ])

  const batchesBy = new Map<string, string[]>()
  for (const b of batchRows) {
    const list = batchesBy.get(b.studentId) ?? []
    list.push(b.className)
    batchesBy.set(b.studentId, list)
  }
  const activityBy = new Map(attemptRows.map((a) => [a.studentId, a]))

  return base.map((s) => {
    const names = batchesBy.get(s.id) ?? []
    const activity = activityBy.get(s.id)
    return {
      ...s,
      batchCount: names.length,
      batchNames: names,
      attemptCount: activity?.attemptCount ?? 0,
      lastActiveAt: activity?.lastActiveAt ?? null,
      outstanding: outstanding ? (outstanding.get(s.id) ?? 0) : null,
    }
  })
}

// ── Teacher profile ─────────────────────────────────────────────────────────

/**
 * The owner's view of one teacher: contact, assigned batches, authored papers
 * and workload totals.
 *
 * **Drafts are excluded from both the paper list and the count.** Under the hard
 * role split the owner never sees a teacher's unfinished paper — not in a list,
 * not in stats, and not as a number that implies one exists. The pre-existing
 * `listTeachersWithWorkload` count did include them; both are filtered now.
 */
export async function getTeacherProfile(
  tenantId: string,
  teacherId: string,
): Promise<TeacherProfile> {
  const teacher = await assertTenantMember(tenantId, teacherId, 'teacher')

  const [batches, papers] = await Promise.all([
    db
      .select({
        id: classes.id,
        name: classes.name,
        grade: classes.grade,
        assignedAt: classTeachers.assignedAt,
        studentCount: sql<number>`(
          select count(*) from ${classMembers}
          where ${classMembers.classId} = ${classes.id} and ${classMembers.status} = 'approved'
        )`.mapWith(Number),
      })
      .from(classTeachers)
      .innerJoin(classes, eq(classes.id, classTeachers.classId))
      .where(and(eq(classTeachers.tenantId, tenantId), eq(classTeachers.teacherId, teacherId)))
      .orderBy(classes.name),
    db
      .select({
        id: exams.id,
        title: exams.title,
        status: exams.status,
        totalMarks: exams.totalMarks,
        scheduledAt: exams.scheduledAt,
        createdAt: exams.createdAt,
      })
      .from(exams)
      .where(and(
        eq(exams.tenantId, tenantId),
        eq(exams.createdBy, teacherId),
        ...PRIVATE_AUTHOR_STATUSES.map((s) => ne(exams.status, s)),
      ))
      .orderBy(desc(exams.createdAt)),
  ])

  return {
    teacher,
    batches,
    papers: papers.map((p) => ({ ...p, status: p.status as ExamStatus })),
    workload: {
      batchCount: batches.length,
      studentCount: batches.reduce((sum, b) => sum + b.studentCount, 0),
      paperCount: papers.length,
    },
  }
}
