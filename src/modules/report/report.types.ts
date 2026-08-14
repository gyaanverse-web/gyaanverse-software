export type ReportStatus = 'pending' | 'ready' | 'archived'

export interface Report {
  id: string
  sessionId: string
  studentId: string
  examId: string
  tenantId: string
  totalScore: number
  maxScore: number
  autoScore: number
  aiScore: number
  status: ReportStatus
  publishedAt: Date | null
  createdAt: Date
}

export interface ReportItem {
  id: string
  reportId: string
  questionId: string
  score: number
  maxScore: number
  feedback: string | null
  imageUrl: string | null
}

export interface ReportSummary {
  id: string
  sessionId: string
  examId: string
  examTitle: string
  studentId: string
  totalScore: number
  maxScore: number
  autoScore: number
  aiScore: number
  status: ReportStatus
  publishedAt: Date | null
  createdAt: Date
}

/**
 * Teacher-facing row. A reviewer is looking at a class, not at their own single
 * report, so the student has to be nameable — `studentId` alone is unusable in
 * a marks list. Students never get these fields; their own list is `ReportSummary`.
 */
export interface TeacherReportSummary extends ReportSummary {
  studentName: string
  studentEmail: string | null
}

/**
 * A student whose paper is in but whose report does not exist yet.
 *
 * Carries an identity and a timestamp and nothing else — no score, no status, no
 * reason. The omissions are the design: this list mixes papers still being
 * evaluated with papers the backstop flagged for a Gyanverse operator, and
 * anything that let a teacher tell those apart would tell them which student's
 * answer the AI could not read. See `listSessionsAwaitingReport`.
 */
export interface AwaitingReportSummary {
  sessionId: string
  studentId: string
  studentName: string
  studentEmail: string | null
  submittedAt: Date | null
}

/** Single report plus its per-question items, for the teacher's review drill-down. */
export interface ReportDetail extends Report {
  studentName: string
  studentEmail: string | null
  items: ReportItem[]
}
