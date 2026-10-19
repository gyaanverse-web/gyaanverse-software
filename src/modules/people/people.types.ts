import type { ExamStatus } from '../exam/exam.types.js'
import type { Role } from '../auth/auth.types.js'

/**
 * Shapes for the per-person detail pages inside a coaching.
 *
 * The owner's and the teacher's view of the same student are two different
 * TYPES, not one type with nullable money fields. A teacher's payload has no
 * `fees` key and no `guardians` key at all, so a frontend that forgets to check
 * the role cannot render an empty Fees card — the property does not exist to
 * read. See `StudentProfileForTeacher` below.
 */

/** Identity block — the same for every viewer who is allowed to see the person. */
export interface PersonIdentity {
  id: string
  name: string
  email: string | null
  emailVerified: boolean
  phone: string | null
  phoneVerified: boolean
  image: string | null
  /** Role held in THIS coaching (the membership role), never the account role. */
  role: Role
  /** When they joined this coaching — `memberships.createdAt`, not `users.createdAt`. */
  joinedAt: Date
  /** When the account itself was created. */
  accountCreatedAt: Date
}

export interface StudentBatchRef {
  id: string
  name: string
  grade: string | null
  /** 'pending' | 'approved' | 'rejected' — the enrollment, not the batch. */
  status: string
  enrolledAt: Date
  teachers: { id: string; name: string }[]
}

/**
 * One attempt, not one exam. A student with two attempts at the same paper gets
 * two rows, which is what a person looking at "what has this student done"
 * expects to see.
 *
 * `score` is null while the paper is unmarked — distinct from a scored zero,
 * which is why it is nullable rather than defaulted.
 */
export interface StudentExamAttempt {
  sessionId: string
  examId: string
  examTitle: string
  examStatus: ExamStatus
  attemptNumber: number
  /** 'in_progress' | 'submitted' | 'evaluated' | 'abandoned' */
  sessionStatus: string
  startedAt: Date
  submittedAt: Date | null
  totalMarks: number
  reportId: string | null
  score: number | null
  maxScore: number | null
  /** True once the report is readable by the student — drives "Result ready". */
  resultPublished: boolean
}

export interface StudentActivitySummary {
  attempted: number
  submitted: number
  evaluated: number
  /** Mean of `score / maxScore` over evaluated attempts, 0–100, or null if none. */
  averagePercent: number | null
}

/** Money block. Owner-only, and only while the platform fees switch is on. */
export interface StudentFeeBlock {
  totalBilled: number
  totalPaid: number
  totalWaived: number
  balance: number
  overdueAmount: number
  creditBalance: number
  nextDue: { invoiceId: string; label: string; dueDate: string; amount: number } | null
}

export interface GuardianRef {
  id: string
  name: string
  relation: string
  phone: string | null
  email: string | null
  isPrimary: boolean
}

/** What the coaching owner sees. */
export interface StudentProfile {
  student: PersonIdentity
  batches: StudentBatchRef[]
  attempts: StudentExamAttempt[]
  activity: StudentActivitySummary
  /**
   * Null means "fees are switched off platform-wide", which is different from a
   * student who simply owes nothing (that is a zeroed block). The frontend
   * renders no Fees tab for null and an empty-state tab for zeros.
   */
  fees: StudentFeeBlock | null
  guardians: GuardianRef[]
}

/**
 * What an assigned teacher sees. Structurally narrower than `StudentProfile`:
 *
 *  - `batches` holds only batches this teacher is assigned to;
 *  - `attempts` holds only attempts at papers this teacher authored;
 *  - there is no `fees` key and no `guardians` key.
 *
 * `scope: 'teacher'` is on the wire so the client can switch on one field
 * rather than probing for absent keys.
 */
export interface StudentProfileForTeacher {
  scope: 'teacher'
  student: PersonIdentity
  batches: StudentBatchRef[]
  attempts: StudentExamAttempt[]
  activity: StudentActivitySummary
}

export type StudentProfileResponse =
  | ({ scope: 'owner' } & StudentProfile)
  | StudentProfileForTeacher

/** A row on the students list page. */
export interface StudentListRow {
  id: string
  name: string
  email: string | null
  phone: string | null
  joinedAt: Date
  batchCount: number
  /** Names of the batches, for the list's secondary line. Capped by the query. */
  batchNames: string[]
  attemptCount: number
  lastActiveAt: Date | null
  /** Owner-only + fees-on; null otherwise, same meaning as on the profile. */
  outstanding: number | null
}

export interface TeacherBatchRef {
  id: string
  name: string
  grade: string | null
  studentCount: number
  assignedAt: Date
}

export interface TeacherPaperRef {
  id: string
  title: string
  status: ExamStatus
  totalMarks: number
  scheduledAt: Date | null
  createdAt: Date
}

/**
 * The owner's view of one teacher. There is no teacher-facing or student-facing
 * variant: `/account` is the teacher's own surface and everyone else gets 404,
 * so one shape is the whole contract.
 */
export interface TeacherProfile {
  teacher: PersonIdentity
  batches: TeacherBatchRef[]
  /**
   * Authored papers, **never including `draft`**. An owner who could see that a
   * draft exists — even as a row with no title shown — would break the
   * private-drafts invariant. Drafts are excluded from `workload.paperCount` too.
   */
  papers: TeacherPaperRef[]
  workload: {
    batchCount: number
    studentCount: number
    paperCount: number
  }
}
