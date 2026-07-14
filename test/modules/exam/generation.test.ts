import { describe, it, expect } from 'vitest'
import {
  TIME_MATRIX, DIFFICULTIES, buildBuckets, validateGenerationParams, estimateDurationMins,
} from '@modules/exam/exam.generation.js'
import type { GenerationParams } from '@modules/exam/exam.types.js'

// Pure functions — no DB. These exercise the test-engine's apportionment and
// time-estimation logic directly.

const QUESTION_TYPES = [
  'mcq_single', 'mcq_multiple', 'integer', 'numerical',
  'subjective', 'match', 'assertion_reason', 'fill_blanks',
] as const

function sum(ns: number[]) {
  return ns.reduce((a, b) => a + b, 0)
}

describe('TIME_MATRIX', () => {
  it('covers all eight question types × three difficulties', () => {
    for (const type of QUESTION_TYPES) {
      expect(TIME_MATRIX[type], `missing time row for ${type}`).toBeTruthy()
      for (const d of DIFFICULTIES) {
        expect(typeof TIME_MATRIX[type][d]).toBe('number')
        expect(TIME_MATRIX[type][d]).toBeGreaterThan(0)
      }
    }
  })

  it('is monotonically non-decreasing easy → medium → hard', () => {
    for (const type of QUESTION_TYPES) {
      const { easy, medium, hard } = TIME_MATRIX[type]
      expect(medium).toBeGreaterThanOrEqual(easy)
      expect(hard).toBeGreaterThanOrEqual(medium)
    }
  })
})

describe('validateGenerationParams', () => {
  const base: GenerationParams = {
    subjectId: 'a',
    totalQuestions: 10,
    typeDistribution: { mcq_single: 6, integer: 4 },
    difficultyDistribution: { easy: 3, medium: 4, hard: 3 },
  }

  it('accepts a sound config', () => {
    expect(validateGenerationParams(base)).toBeNull()
  })

  it('rejects totalQuestions < 1', () => {
    expect(validateGenerationParams({ ...base, totalQuestions: 0 })).toMatch(/at least 1/)
  })

  it('rejects totalQuestions > 200', () => {
    expect(validateGenerationParams({ ...base, totalQuestions: 201 })).toMatch(/exceed 200/)
  })

  it('rejects an empty type distribution', () => {
    expect(validateGenerationParams({ ...base, typeDistribution: {} })).toMatch(/typeDistribution/)
  })

  it('rejects an empty difficulty distribution', () => {
    expect(validateGenerationParams({ ...base, difficultyDistribution: {} })).toMatch(/difficultyDistribution/)
  })

  it('rejects a type distribution that does not sum to totalQuestions', () => {
    const err = validateGenerationParams({ ...base, typeDistribution: { mcq_single: 6, integer: 3 } })
    expect(err).toMatch(/typeDistribution must sum/)
  })

  it('rejects a difficulty distribution that does not sum to totalQuestions', () => {
    const err = validateGenerationParams({ ...base, difficultyDistribution: { easy: 3, medium: 4, hard: 2 } })
    expect(err).toMatch(/difficultyDistribution must sum/)
  })

  it('ignores zero-valued entries when summing', () => {
    const err = validateGenerationParams({
      ...base,
      typeDistribution: { mcq_single: 6, integer: 4, subjective: 0 },
    })
    expect(err).toBeNull()
  })
})

describe('buildBuckets', () => {
  it('matches the spec example exactly (50 questions)', () => {
    const params: GenerationParams = {
      subjectId: 'a',
      totalQuestions: 50,
      typeDistribution: { mcq_single: 25, integer: 15, subjective: 10 },
      difficultyDistribution: { easy: 10, medium: 20, hard: 20 },
    }
    const buckets = buildBuckets(params)

    // Overall total is preserved.
    expect(sum(buckets.map((b) => b.count))).toBe(50)

    // Per-type totals are exact.
    const byType = (t: string) => sum(buckets.filter((b) => b.type === t).map((b) => b.count))
    expect(byType('mcq_single')).toBe(25)
    expect(byType('integer')).toBe(15)
    expect(byType('subjective')).toBe(10)

    // For this clean ratio (0.2 / 0.4 / 0.4) the difficulty totals land exactly.
    const byDiff = (d: string) => sum(buckets.filter((b) => b.difficulty === d).map((b) => b.count))
    expect(byDiff('easy')).toBe(10)
    expect(byDiff('medium')).toBe(20)
    expect(byDiff('hard')).toBe(20)
  })

  it('preserves per-type totals and overall total even when ratios force rounding', () => {
    const params: GenerationParams = {
      subjectId: 'a',
      totalQuestions: 10,
      typeDistribution: { mcq_single: 7, integer: 3 },
      difficultyDistribution: { easy: 5, medium: 5 },
    }
    const buckets = buildBuckets(params)

    expect(sum(buckets.map((b) => b.count))).toBe(10)
    const byType = (t: string) => sum(buckets.filter((b) => b.type === t).map((b) => b.count))
    expect(byType('mcq_single')).toBe(7)
    expect(byType('integer')).toBe(3)

    // Difficulty totals are best-effort (per-type rounding), but must stay close.
    const byDiff = (d: string) => sum(buckets.filter((b) => b.difficulty === d).map((b) => b.count))
    expect(Math.abs(byDiff('easy') - 5)).toBeLessThanOrEqual(1)
    expect(Math.abs(byDiff('medium') - 5)).toBeLessThanOrEqual(1)
  })

  it('omits buckets with a zero count', () => {
    const params: GenerationParams = {
      subjectId: 'a',
      totalQuestions: 4,
      typeDistribution: { mcq_single: 4 },
      difficultyDistribution: { easy: 4 }, // medium & hard absent
    }
    const buckets = buildBuckets(params)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toEqual({ type: 'mcq_single', difficulty: 'easy', count: 4 })
  })

  it('only emits the requested types', () => {
    const params: GenerationParams = {
      subjectId: 'a',
      totalQuestions: 6,
      typeDistribution: { subjective: 6 },
      difficultyDistribution: { easy: 2, medium: 2, hard: 2 },
    }
    const buckets = buildBuckets(params)
    expect(new Set(buckets.map((b) => b.type))).toEqual(new Set(['subjective']))
    expect(sum(buckets.map((b) => b.count))).toBe(6)
  })
})

describe('estimateDurationMins', () => {
  it('sums the time matrix and rounds up to whole minutes', () => {
    // 2 × mcq_single/easy (1) + 1 × subjective/hard (12) = 14
    const picks = [
      { type: 'mcq_single', difficulty: 'easy' },
      { type: 'mcq_single', difficulty: 'easy' },
      { type: 'subjective', difficulty: 'hard' },
    ]
    expect(estimateDurationMins(picks)).toBe(14)
  })

  it('rounds fractional totals up', () => {
    // mcq_multiple/easy = 1.5 → ceil → 2
    expect(estimateDurationMins([{ type: 'mcq_multiple', difficulty: 'easy' }])).toBe(2)
  })

  it('returns 0 for no picks', () => {
    expect(estimateDurationMins([])).toBe(0)
  })

  it('ignores unknown type/difficulty combinations rather than throwing', () => {
    expect(estimateDurationMins([{ type: 'nonsense', difficulty: 'easy' }])).toBe(0)
  })
})
