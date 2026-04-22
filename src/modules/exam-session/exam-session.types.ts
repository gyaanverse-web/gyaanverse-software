export interface ExamSession {
  id: string
  examId: string
  studentId: string
  tenantId: string
  status: 'in_progress' | 'submitted'
  startedAt: Date
  submittedAt: Date | null
}

export interface SessionAnswer {
  id: string
  sessionId: string
  questionId: string
  imageUrl: string
  uploadedAt: Date
}
