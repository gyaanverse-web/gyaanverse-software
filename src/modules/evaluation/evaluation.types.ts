export type EvaluationJobStatus = 'pending' | 'processing' | 'completed' | 'failed'

export type StepStatus = 'right' | 'wrong' | 'unknown' | 'incomplete'

export interface EvaluationJob {
  id: string
  sessionId: string
  tenantId: string
  status: EvaluationJobStatus
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

// ── Engine wire types ──────────────────────────────────────────────────────

export interface EngineOcrStep {
  stepId: string
  text: string
}

export interface EngineEvaluatedStep extends EngineOcrStep {
  step_status: StepStatus
  step_weight: number
  topic: string
  step_understanding: string
  description: string
}

export interface EngineEvaluationResponse {
  response: EngineEvaluatedStep[]
}

export interface EngineIndexDocument {
  document_id?: string
  text: string
  metadata?: Record<string, unknown>
}

export interface EngineIndexResponse {
  collection_name: string
  indexed_chunks: number
}

// ── Aggregated AI feedback stored on question_results.aiFeedback ───────────

export interface AiFeedbackPayload {
  steps: EngineEvaluatedStep[]
  topics: string[]
  summary: {
    totalSteps: number
    rightSteps: number
    wrongSteps: number
    incompleteSteps: number
    unknownSteps: number
    rightWeight: number
    totalWeight: number
  }
}

// ── BullMQ job payload ────────────────────────────────────────────────────

export interface EvaluationJobPayload {
  jobId: string
  sessionId: string
  tenantId: string
}
