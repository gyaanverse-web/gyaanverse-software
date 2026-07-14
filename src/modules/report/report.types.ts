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
