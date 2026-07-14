// Pure generation helpers — no DB access, fully unit-testable.
//
// The generator turns a teacher's config (how many questions, the type split and
// the difficulty split) into concrete (type, difficulty, count) buckets, then a
// separate DB step fills each bucket from the question bank.

import type { QuestionType, GenerationParams } from './exam.types.js'

export type Difficulty = 'easy' | 'medium' | 'hard'

// Minutes a student is expected to spend per question, by type × difficulty.
// Used to compute exam.estimatedDurationMins.
export const TIME_MATRIX: Record<QuestionType, Record<Difficulty, number>> = {
  mcq_single: { easy: 1, medium: 2, hard: 3 },
  mcq_multiple: { easy: 1.5, medium: 2.5, hard: 3.5 },
  integer: { easy: 2, medium: 3, hard: 4 },
  numerical: { easy: 2, medium: 3, hard: 4 },
  subjective: { easy: 5, medium: 8, hard: 12 },
  match: { easy: 3, medium: 4, hard: 6 },
  assertion_reason: { easy: 2, medium: 3, hard: 4 },
  fill_blanks: { easy: 1.5, medium: 2.5, hard: 3.5 },
}

export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard']

export interface GenerationBucket {
  type: QuestionType
  difficulty: Difficulty
  count: number
}

// Largest-remainder apportionment: split `total` into integer parts that are
// proportional to `weights` and sum back to exactly `total`. Avoids the rounding
// drift you'd get from naive Math.round on each part.
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)

  const raw = weights.map((w) => (w / sum) * total)
  const floored = raw.map(Math.floor)
  let remainder = total - floored.reduce((a, b) => a + b, 0)

  // Hand out the leftover units to the largest fractional remainders first.
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac)

  const result = [...floored]
  for (let k = 0; k < order.length && remainder > 0; k++) {
    result[order[k].i]++
    remainder--
  }
  return result
}

// Validates a generation config and returns a normalized error message, or null
// if it is sound. Both distributions must be non-empty and sum to totalQuestions.
export function validateGenerationParams(params: GenerationParams): string | null {
  if (!params.totalQuestions || params.totalQuestions < 1)
    return 'totalQuestions must be at least 1'
  if (params.totalQuestions > 200)
    return 'totalQuestions cannot exceed 200'

  const typeEntries = Object.entries(params.typeDistribution).filter(([, n]) => (n ?? 0) > 0)
  const diffEntries = Object.entries(params.difficultyDistribution).filter(([, n]) => (n ?? 0) > 0)

  if (typeEntries.length === 0) return 'typeDistribution must include at least one type'
  if (diffEntries.length === 0) return 'difficultyDistribution must include at least one difficulty'

  const typeSum = typeEntries.reduce((a, [, n]) => a + (n ?? 0), 0)
  const diffSum = diffEntries.reduce((a, [, n]) => a + (n ?? 0), 0)

  if (typeSum !== params.totalQuestions)
    return `typeDistribution must sum to totalQuestions (${params.totalQuestions}), got ${typeSum}`
  if (diffSum !== params.totalQuestions)
    return `difficultyDistribution must sum to totalQuestions (${params.totalQuestions}), got ${diffSum}`

  return null
}

// Expands the (type counts) × (difficulty split) into a flat list of buckets.
// Each type's count is apportioned across difficulties using the global
// difficulty weights, so the per-type totals are preserved exactly while the
// difficulty mix is honoured as closely as integer counts allow.
export function buildBuckets(params: GenerationParams): GenerationBucket[] {
  const diffWeights = DIFFICULTIES.map((d) => params.difficultyDistribution[d] ?? 0)
  const buckets: GenerationBucket[] = []

  for (const [type, count] of Object.entries(params.typeDistribution)) {
    if (!count || count <= 0) continue
    const perDiff = apportion(count, diffWeights)
    DIFFICULTIES.forEach((difficulty, i) => {
      if (perDiff[i] > 0) {
        buckets.push({ type: type as QuestionType, difficulty, count: perDiff[i] })
      }
    })
  }

  return buckets
}

// Estimated minutes for a set of picked questions, rounded up to a whole minute.
export function estimateDurationMins(
  picks: Array<{ type: string; difficulty: string }>,
): number {
  let total = 0
  for (const p of picks) {
    const row = TIME_MATRIX[p.type as QuestionType]
    total += row?.[p.difficulty as Difficulty] ?? 0
  }
  return Math.ceil(total)
}
