import type { QuestionType, QuestionPayload, AnswerKey } from '../exam/exam.types.js'

export type Difficulty = 'easy' | 'medium' | 'hard'
export type BankStatus = 'draft' | 'active' | 'flagged' | 'archived'

// Re-export the question primitives so the bank can be reasoned about without
// reaching into the exam module.
export type { QuestionType, QuestionPayload, AnswerKey }

// ── Hierarchy ────────────────────────────────────────────────────────────────

export interface Subject {
  id: string
  tenantId: string | null
  name: string
  code: string | null
  gradeLevel: string | null
  language: string
  status: string
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Module {
  id: string
  subjectId: string
  tenantId: string | null
  name: string
  order: number
  status: string
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Chapter {
  id: string
  moduleId: string
  tenantId: string | null
  name: string
  order: number
  status: string
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Section {
  id: string
  chapterId: string
  tenantId: string | null
  name: string
  order: number
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Concept {
  id: string
  sectionId: string
  tenantId: string | null
  name: string
  description: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

// ── Hierarchy path ───────────────────────────────────────────────────────────

// Identifies where a question sits. `subjectId` is always resolved; deeper
// levels are present only when the question is tagged at that grain.
export interface HierarchyPath {
  subjectId: string
  moduleId: string | null
  chapterId: string | null
  sectionId: string | null
  conceptId: string | null
}

// What a caller supplies — any single level (or several). The service walks up
// from the deepest provided id to fill all ancestors.
export interface HierarchyPathInput {
  subjectId?: string
  moduleId?: string
  chapterId?: string
  sectionId?: string
  conceptId?: string
}

// ── Question bank ────────────────────────────────────────────────────────────

export interface QuestionSource {
  type: 'original' | 'textbook' | 'pyq'
  [k: string]: unknown
}

export interface BankQuestion extends HierarchyPath {
  id: string
  tenantId: string | null
  type: QuestionType
  difficulty: Difficulty
  body: string
  imageUrls: string[] | null
  payload: QuestionPayload
  answerKey: AnswerKey
  defaultMarks: number
  defaultNegativeMarks: number
  explanation: string | null
  explanationImageUrls: string[] | null
  solutionVideoUrl: string | null
  tags: string[] | null
  language: string
  source: QuestionSource | null
  usageCount: number
  avgSuccessRate: string | null
  isVerified: boolean
  verifiedBy: string | null
  verifiedAt: Date | null
  status: BankStatus
  flagReason: string | null
  metadata: Record<string, unknown> | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

// Filters accepted by the bank listing endpoint.
export interface BankQuestionFilters extends HierarchyPathInput {
  type?: QuestionType
  difficulty?: Difficulty
  status?: BankStatus
  isVerified?: boolean
  language?: string
  tags?: string[]
  search?: string
}
