import { describe, it, expect } from 'vitest'
import {
  EVALUATION_JOB_OPTS,
  MAX_ATTEMPTS,
  UNGRADEABLE_ATTEMPTS,
  classifyFailure,
  isTerminal,
  retryDelayMs,
} from '@modules/evaluation/evaluation.retry.js'

describe('retryDelayMs', () => {
  it('starts at 5s and doubles', () => {
    expect(retryDelayMs(1)).toBe(5_000)
    expect(retryDelayMs(2)).toBe(10_000)
    expect(retryDelayMs(3)).toBe(20_000)
  })

  it('caps at 30 minutes and never overflows', () => {
    expect(retryDelayMs(20)).toBe(30 * 60_000)
    expect(retryDelayMs(MAX_ATTEMPTS)).toBe(30 * 60_000)
    expect(Number.isFinite(retryDelayMs(1_000))).toBe(true)
  })

  it('CRITICAL: a multi-hour engine outage cannot exhaust one job budget', () => {
    // Stall path #1. The old policy — 3 attempts, 5s exponential — burned every
    // attempt inside 35 seconds, so any outage longer than that stranded the
    // entire cohort in under_evaluation.
    let total = 0
    for (let a = 1; a <= MAX_ATTEMPTS; a++) total += retryDelayMs(a)
    expect(total).toBeGreaterThan(12 * 60 * 60_000) // > 12h of coverage
  })
})

describe('classifyFailure', () => {
  it('treats engine failures as transient however many attempts have gone by', () => {
    for (const code of [
      'ENGINE_TIMEOUT',
      'ENGINE_UNREACHABLE',
      'ENGINE_ERROR',
      'ENGINE_BAD_RESPONSE',
    ]) {
      expect(classifyFailure(code, 1)).toBe('transient')
      expect(classifyFailure(code, MAX_ATTEMPTS)).toBe('transient')
    }
  })

  it('treats a missing session/exam as permanent', () => {
    expect(classifyFailure('NOT_FOUND', 1)).toBe('permanent')
    expect(isTerminal('permanent')).toBe(true)
  })

  it('retries an ungradeable paper, then escalates to needs_human', () => {
    // Both doors onto the same condition — the real engine uses both. A blank
    // page comes back from OCR as [{ text: '' }], not [], so it reaches the
    // evaluator, which then returns no scored steps.
    for (const code of ['OCR_EMPTY', 'EVAL_EMPTY']) {
      expect(classifyFailure(code, 1)).toBe('transient')
      expect(classifyFailure(code, UNGRADEABLE_ATTEMPTS - 1)).toBe('transient')
      expect(classifyFailure(code, UNGRADEABLE_ATTEMPTS)).toBe('needs_human')
      expect(classifyFailure(code, UNGRADEABLE_ATTEMPTS + 10)).toBe('needs_human')
    }
  })

  it('defaults unknown codes to transient', () => {
    // Retrying something unretryable wastes compute; NOT retrying something
    // retryable strands a cohort. The asymmetry decides the default.
    expect(classifyFailure('UNKNOWN', 1)).toBe('transient')
    expect(isTerminal('transient')).toBe(false)
  })
})

describe('EVALUATION_JOB_OPTS', () => {
  it('uses the custom backoff strategy, not BullMQ exponential', () => {
    // `type: 'custom'` resolves to evaluationBackoffStrategy in worker.ts.
    // BullMQ's own exponential has no cap, so attempt 50 would be ~years out.
    expect(EVALUATION_JOB_OPTS.backoff).toEqual({ type: 'custom' })
    expect(EVALUATION_JOB_OPTS.attempts).toBe(MAX_ATTEMPTS)
  })

  it('retains failed jobs far beyond the old count of 100', () => {
    // The reconciler spots an orphan by the absence of a queue entry, so tight
    // eviction manufactures the drift it is meant to repair (stall path #4).
    const removeOnFail = EVALUATION_JOB_OPTS.removeOnFail as { count: number; age: number }
    expect(removeOnFail.count).toBeGreaterThanOrEqual(10_000)
    expect(removeOnFail.age).toBeGreaterThanOrEqual(24 * 60 * 60)
  })
})
