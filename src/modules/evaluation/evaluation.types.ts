export interface EvaluationJob {
  id: string
  sessionId: string
  tenantId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  attempts: number
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
}

export interface QuestionResult {
  id: string
  jobId: string
  questionId: string
  score: number
  maxScore: number
  aiFeedback: string | null
  imageUrl: string
}
