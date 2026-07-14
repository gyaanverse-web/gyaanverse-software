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
export type ExamStatus = 'draft' | 'published' | 'archived'
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
  publishedAt: Date | null
  scheduledAt: Date | null
  endsAt: Date | null
  createdAt: Date
  updatedAt: Date
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
