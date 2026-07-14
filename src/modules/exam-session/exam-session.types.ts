export type SessionStatus = 'in_progress' | 'submitted' | 'evaluated' | 'abandoned'

export interface ExamSession {
  id: string
  examId: string
  studentId: string
  tenantId: string | null
  attemptNumber: number
  status: SessionStatus
  startedAt: Date
  expiresAt: Date
  submittedAt: Date | null
  autoScore: number | null
  manualScore: number | null
  totalMarks: number
}

export interface SessionAnswer {
  id: string
  sessionId: string
  questionId: string
  answer: Record<string, unknown> | null
  imageUrl: string | null
  isCorrect: boolean | null
  awardedMarks: number | null
  updatedAt: Date
}
