// ─────────────────────────────────────────────────────────────────────────────
// The shared vocabulary of the evaluation module.
//
// This file holds ONLY type definitions — the shapes of the data. It contains no
// logic, touches no database and calls nothing. Every other file in this folder
// imports its words from here so they all mean the same thing.
//
// If you change a name in here, TypeScript will point at every place that has to
// change with it. If you change a name that also exists as a value in the
// database (like `needs_human`), TypeScript will NOT catch the rows already
// saved with the old word — those need a migration.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The life of one evaluation job, as stored in `evaluation_jobs.status`.
 *
 *   pending     waiting in the queue for a worker to pick it up
 *   processing  a worker is running it right now
 *   completed   finished successfully
 *   failed      the last try did not work (it may still be retried — see
 *               `publicJobStatus` in evaluation.service.ts for why students and
 *               teachers are never shown this word)
 */
export type EvaluationJobStatus = 'pending' | 'processing' | 'completed' | 'failed'

/**
 * The AI's verdict on ONE step of a student's handwritten working.
 * A single answer is usually several steps, each judged separately.
 */
export type StepStatus = 'right' | 'wrong' | 'unknown' | 'incomplete'

/**
 * WHY a job failed — this decides whether anything tries it again.
 * Stored in the `evaluation_jobs.failure_class` column.
 *
 * - `transient`   — the engine or the network had a bad moment. The paper itself
 *                   is fine, so keep retrying.
 * - `permanent`   — this job can never succeed (its session or exam was deleted).
 *                   Stop immediately; do not waste the remaining tries.
 * - `needs_human` — everything ran, but nothing readable came out. Retrying does
 *                   not fix a blank or blurred photo — a person has to look.
 */
export type EvaluationFailureClass = 'transient' | 'permanent' | 'needs_human'

/**
 * WHO the score on an answer belongs to.
 * Stored in the `question_results.review_status` column.
 *
 * - `ai`          — the AI graded it and nobody has needed to get involved.
 * - `needs_human` — the backstop wrote a 0 here just so the class could move on.
 *                   That 0 is a placeholder, NOT the student's real mark.
 * - `resolved`    — a Gyanverse staff member has since graded it by hand.
 *
 * This is **internal only**. Coaching owners, teachers and students never see
 * this field. The person who reviews these is Gyanverse staff, never the
 * coaching's own teacher.
 */
export type QuestionReviewStatus = 'ai' | 'needs_human' | 'resolved'

export interface EvaluationJob {
  id: string
  sessionId: string
  tenantId: string
  status: EvaluationJobStatus
  attempts: number
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
  lastErrorCode: string | null
  failureClass: EvaluationFailureClass | null
  nextRetryAt: Date | null
  leaseExpiresAt: Date | null
  settledAt: Date | null
}

export interface QuestionResult {
  id: string
  jobId: string
  questionId: string
  score: number
  maxScore: number
  aiFeedback: string | null
  imageUrl: string
  reviewStatus: QuestionReviewStatus
  aiScore: number | null
  reviewedBy: string | null
  reviewedAt: Date | null
  reviewNote: string | null
}

// ── The shapes the AI engine sends and receives ────────────────────────────
//
// These use snake_case (`step_status`, not `stepStatus`) because that is
// literally what the Python AI engine puts on the wire. Do not "tidy" them into
// camelCase — the names have to match the engine exactly or the data arrives
// as undefined.

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

// ── What gets saved into `question_results.ai_feedback` ────────────────────
//
// The engine's step-by-step verdict, plus a small tally, stored as JSON text in
// one column. This is what the student's report screen reads to show "you got
// step 2 wrong".

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

// ── What we put on the queue ──────────────────────────────────────────────
//
// Only three ids, never the whole paper. The worker looks everything else up
// from the database when it runs, so a job that sits in the queue for an hour
// still works with the latest data rather than a stale copy.

export interface EvaluationJobPayload {
  jobId: string
  sessionId: string
  tenantId: string
}
