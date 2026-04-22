export interface Report {
  id: string
  sessionId: string
  studentId: string
  examId: string
  tenantId: string
  totalScore: number
  maxScore: number
  status: string
  createdAt: Date
}

export interface ReportItem {
  id: string
  reportId: string
  questionId: string
  score: number
  maxScore: number
  feedback: string | null
  imageUrl: string
}
