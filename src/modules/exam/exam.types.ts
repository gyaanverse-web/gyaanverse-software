export type QuestionType =
  | 'mcq_single'
  | 'mcq_multiple'
  | 'integer'
  | 'numerical'
  | 'subjective'
  | 'match'
  | 'assertion_reason'
  | 'fill_blanks'

export type ExamVisibility = 'private' | 'public_free' | 'public_paid'

// Teacher→admin approval / scheduling / live / evaluation lifecycle (PRD v1).
// Stored lowercase snake_case. Display labels are mapped in the UI layer.
//   draft            → teacher authoring
//   under_review     → submitted, awaiting admin (owner)
//   changes_requested→ admin bounced back with remarks
//   rejected         → admin rejected with remarks
//   approved         → admin approved (pre-scheduling)
//   scheduled        → date/time set, waiting to start
//   live             → in progress (students can attempt)
//   under_evaluation → window closed, sessions being evaluated
//   ready_to_publish → every session evaluated; teacher reviews the reports
//   completed        → teacher published results (student-visible) — terminal
//   archived         → retired from active lists
//
// NOTE on `completed`: publishing IS completing. There is deliberately no
// separate "results published" resting state — the teacher's publish click is
// the last lifecycle event, so `completed` means "results are out and visible".
// The state worth having before it is `ready_to_publish`, which is the one a
// human can actually act on.
export type ExamStatus =
  | 'draft'
  | 'under_review'
  | 'changes_requested'
  | 'rejected'
  | 'approved'
  | 'scheduled'
  | 'live'
  | 'under_evaluation'
  | 'ready_to_publish'
  | 'completed'
  | 'archived'

// Ordered list of all lifecycle states — handy for validation and iteration.
export const EXAM_STATUSES: readonly ExamStatus[] = [
  'draft', 'under_review', 'changes_requested', 'rejected', 'approved',
  'scheduled', 'live', 'under_evaluation', 'ready_to_publish', 'completed',
  'archived',
] as const

/**
 * Lifecycle statuses a student may see at all: an upcoming scheduled exam
 * (metadata only — questions stay hidden until it goes live), the live exam
 * itself, and every post-live state (so attempted exams remain reachable for
 * "results pending" / "result ready"). Attempting is still live-only —
 * startSession asserts `live` + the schedule window separately.
 *
 * Lives here rather than in exam.service so class.service can count a batch's
 * student-visible exams without importing the exam service.
 */
export const STUDENT_VISIBLE_STATUSES: ReadonlySet<ExamStatus> = new Set([
  'scheduled', 'live', 'under_evaluation', 'ready_to_publish', 'completed',
])

export type ExamScopeType = 'single_chapter' | 'multi_chapter' | 'full_subject' | 'full_syllabus' | 'custom'

// ── Question payload shapes ────────────────────────────────────────────────

export interface McqOption {
  id: string
  text: string
  imageUrl?: string
}

export interface McqSinglePayload { options: McqOption[] }
export interface McqMultiplePayload { options: McqOption[] }
export interface IntegerPayload {}
export interface NumericalPayload { decimalPlaces?: number }
export interface SubjectivePayload { wordLimit?: number }
export interface MatchColumn { id: string; text: string }
export interface MatchPayload { left: MatchColumn[]; right: MatchColumn[] }
export interface AssertionReasonPayload { assertion: string; reason: string }
export interface FillBlanksPayload { blanks: number }

export type QuestionPayload =
  | McqSinglePayload
  | McqMultiplePayload
  | IntegerPayload
  | NumericalPayload
  | SubjectivePayload
  | MatchPayload
  | AssertionReasonPayload
  | FillBlanksPayload

// ── Answer key shapes ─────────────────────────────────────────────────────

export interface McqSingleAnswerKey { optionId: string }
export interface McqMultipleAnswerKey { optionIds: string[] }
export interface IntegerAnswerKey { value: number }
export interface NumericalAnswerKey { value: number; tolerance?: number }
export interface SubjectiveAnswerKey { sampleAnswer?: string; rubric?: string }
export interface MatchAnswerKey { pairs: Array<{ leftId: string; rightId: string }> }
export interface AssertionReasonAnswerKey { option: 'A' | 'B' | 'C' | 'D' | 'E' }
export interface FillBlanksAnswerKey { answers: string[] }

export type AnswerKey =
  | McqSingleAnswerKey
  | McqMultipleAnswerKey
  | IntegerAnswerKey
  | NumericalAnswerKey
  | SubjectiveAnswerKey
  | MatchAnswerKey
  | AssertionReasonAnswerKey
  | FillBlanksAnswerKey

// ── Domain types ───────────────────────────────────────────────────────────
//
// Catalog types (Subject, Module, Chapter, Section, Concept) live in the
// question-bank module — import them from there if needed.

export interface Exam {
  id: string
  tenantId: string
  createdBy: string
  title: string
  description: string | null
  instructions: string | null
  durationMins: number
  estimatedDurationMins: number | null
  generationParams: GenerationParams | null
  gradeLevel: string | null
  subjectId: string | null
  scopeType: ExamScopeType
  visibility: ExamVisibility
  price: string | null
  maxAttempts: number
  status: ExamStatus
  totalMarks: number
  // Optional quality/coverage score surfaced on the Test Overview (PRD).
  qualityScore: number | null
  publishedAt: Date | null
  scheduledAt: Date | null
  endsAt: Date | null
  // ── Approval-lifecycle timestamps & audit ────────────────────────────────
  // Set when the teacher submits for review (draft/changes_requested → under_review).
  submittedAt: Date | null
  // Admin (coaching_owner) who last approved/rejected/requested changes.
  reviewedBy: string | null
  reviewedAt: Date | null
  // Remarks attached to the last review decision (changes_requested / rejected).
  reviewRemarks: string | null
  // Both set together at the publish click (ready_to_publish → completed), since
  // publishing is what finishes the lifecycle. Kept as two columns because
  // `resultsPublishedAt` is what report/marketplace reads already key off.
  resultsPublishedAt: Date | null
  completedAt: Date | null
  // ── Resumable authoring wizard ────────────────────────────────────────────
  // Step last reached in the test-engine wizard (1..4), and the form state for
  // those steps. Null for exams never authored through the wizard.
  wizardStep: number | null
  wizardState: WizardState | null
  createdAt: Date
  updatedAt: Date
}

// The number of steps in the authoring wizard. Kept here (not in the UI) so the
// server can reject an out-of-range step instead of storing nonsense.
export const WIZARD_STEPS = 4

/**
 * Form state for the resumable test-engine wizard, persisted on the draft after
 * every step so a teacher can close the tab and come back to it.
 *
 * Every field is optional: a draft is saved from step 1 onward, long before the
 * later steps have been filled in. This is UI scratch state — the authoritative
 * record of what a paper was generated from is `exam.generationParams`, written
 * by the generator itself.
 */
export interface WizardState {
  classIds?: string[]
  subjectId?: string
  // Wizard-level grouping ('single' | 'multi' | 'full-subject' | 'custom').
  // Distinct from `ExamScopeType`, which the generator derives from the ids.
  scopeType?: string
  chapterIds?: string[]
  // Per-question-type counts, e.g. { mcq_single: 15, numerical: 7 }.
  typeCounts?: Record<string, number>
  // Easy/medium/hard weights as percentages summing to 100.
  difficultyPct?: Partial<Record<'easy' | 'medium' | 'hard', number>>
  verifiedOnly?: boolean
}

// One row per status change — powers the PRD "timeline" and approval remarks.
// `fromStatus` is null for the initial creation; `actorId` is null for
// system/worker-driven transitions (scheduled→live, live→under_evaluation,
// under_evaluation→ready_to_publish, and the public-exam auto-publish).
export interface ExamStatusHistory {
  id: string
  examId: string
  fromStatus: ExamStatus | null
  toStatus: ExamStatus
  actorId: string | null
  remarks: string | null
  createdAt: Date
}

export type DraftStatus = 'pending' | 'kept' | 'discarded'

export interface Question {
  id: string
  examId: string
  tenantId: string
  bankQuestionId: string | null
  order: number
  type: QuestionType
  difficulty: string | null
  body: string
  imageUrls: string[] | null
  payload: QuestionPayload
  answerKey: AnswerKey
  languageVariants: Record<string, string> | null
  marks: number
  negativeMarks: number
  explanation: string | null
  draftStatus: DraftStatus | null
  createdAt: Date
  updatedAt: Date
}

export type QuestionForStudent = Omit<Question, 'answerKey'>

// ── Generation config (stored as exam.generationParams) ──────────────────────

export interface GenerationParams {
  subjectId?: string
  moduleIds?: string[]
  chapterIds?: string[]
  sectionIds?: string[]
  conceptIds?: string[]
  totalQuestions: number
  typeDistribution: Partial<Record<QuestionType, number>>
  difficultyDistribution: Partial<Record<'easy' | 'medium' | 'hard', number>>
  allowRepeatFromBank?: boolean
  verifiedOnly?: boolean
  language?: string
  // Restrict the pool to a question origin ('original' | 'textbook' | 'pyq').
  sourceType?: string
  // Restrict to Bloom's cognitive levels (e.g. ['apply','analyze']).
  cognitiveLevels?: string[]
}
