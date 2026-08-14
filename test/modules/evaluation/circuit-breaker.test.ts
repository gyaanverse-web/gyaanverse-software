import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from '@config/env.js'
import { AppError } from '@shared/errors.js'
import {
  ocrImage,
  engineBreakerStatus,
  resetEngineBreaker,
} from '@modules/evaluation/evaluation.engine.js'
import { classifyFailure } from '@modules/evaluation/evaluation.retry.js'

// ─────────────────────────────────────────────────────────────────────────────
// The circuit breaker exists for one number: EVAL_ENGINE_TIMEOUT_MS, 120s by
// default. Without it, every call against a dead engine pays that in full, and
// Phase 5's concurrency multiplies the bill by the number of worker slots. So
// the assertions here are mostly *call counts on fetch* — "how many times did we
// wait two minutes to learn something we already knew?"
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLD = env.EVAL_BREAKER_THRESHOLD

function unreachable() {
  return vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5000'))
}

function ok() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ocr_data: [{ stepId: '1', text: 'x = 4' }] }),
  })
}

function serverError() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: 'Gemini SDK not installed' }),
  })
}

async function callAndCatch(): Promise<AppError> {
  try {
    await ocrImage('https://example.com/answer.jpg')
    throw new Error('expected the engine call to throw')
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    return err
  }
}

/** Drive the breaker to open. Returns the fetch mock so callers can count. */
async function tripBreaker() {
  const fetchMock = unreachable()
  vi.stubGlobal('fetch', fetchMock)
  for (let i = 0; i < THRESHOLD; i++) await callAndCatch()
  return fetchMock
}

beforeEach(() => {
  resetEngineBreaker()
  // Only Date is faked. The breaker's open window is measured with Date.now(),
  // but callEngine's abort timer is a real setTimeout that the `finally` clears
  // — faking it too would put this file in the business of managing a timeout
  // it never means to fire, and pg's own timers are in the same process.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-12T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetEngineBreaker()
})

describe('engine circuit breaker', () => {
  it('stays closed while the engine answers', async () => {
    vi.stubGlobal('fetch', ok())
    await ocrImage('https://example.com/answer.jpg')
    expect(engineBreakerStatus().state).toBe('closed')
  })

  it('opens after the threshold and then stops calling the engine at all', async () => {
    const fetchMock = await tripBreaker()

    expect(engineBreakerStatus().state).toBe('open')
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD)

    // The point of the whole file: ten more jobs hitting a dead engine buy zero
    // further timeouts. Before this, each of these was a full 120s wait.
    for (let i = 0; i < 10; i++) await callAndCatch()
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD)
  })

  it('CRITICAL: a fast-fail is still transient, so the ladder keeps its promise', async () => {
    await tripBreaker()
    const err = await callAndCatch()

    // If the breaker invented a new code, classifyFailure would fall through to
    // its default — which happens to be `transient` too, but by accident rather
    // than by design. Fail fast must mean "not now", never "give up": a
    // permanent/needs_human class here would strand the cohort the moment the
    // engine blipped, which is the exact stall this plan removes.
    expect(err.code).toBe('ENGINE_UNREACHABLE')
    expect(classifyFailure(err.code, 1)).toBe('transient')
    expect(classifyFailure(err.code, 49)).toBe('transient')
  })

  it('a success resets the streak', async () => {
    const fetchMock = unreachable()
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < THRESHOLD - 1; i++) await callAndCatch()
    expect(engineBreakerStatus().consecutiveFailures).toBe(THRESHOLD - 1)

    vi.stubGlobal('fetch', ok())
    await ocrImage('https://example.com/answer.jpg')
    expect(engineBreakerStatus()).toEqual({ state: 'closed', consecutiveFailures: 0 })
  })

  it('does NOT trip on an engine that answers with an error', async () => {
    // The live 2026-08-12 incident shape: a 500 from a reachable engine. It is a
    // per-request verdict as far as this layer can tell, and one bad upload must
    // not fail-fast every other paper in the queue. It also costs no wall-clock,
    // which is the only thing the breaker is here to save.
    const fetchMock = serverError()
    vi.stubGlobal('fetch', fetchMock)

    for (let i = 0; i < THRESHOLD + 3; i++) {
      const err = await callAndCatch()
      expect(err.code).toBe('ENGINE_ERROR')
    }

    expect(engineBreakerStatus().state).toBe('closed')
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD + 3)
  })

  it('half-opens after the window and lets exactly one call through', async () => {
    await tripBreaker()

    vi.setSystemTime(Date.now() + env.EVAL_BREAKER_OPEN_MS + 1)
    expect(engineBreakerStatus().state).toBe('half-open')

    // A recovering engine must not receive the whole concurrent batch at the
    // moment it is least able to take it. One probe goes; the rest fail fast.
    // `callAndCatch()` runs synchronously as far as the fetch, so the first call
    // has claimed the probe slot before the second one is even constructed —
    // this is the real concurrency, not a simulation of it.
    const probeFetch = unreachable()
    vi.stubGlobal('fetch', probeFetch)

    const probe = callAndCatch()
    const shedA = callAndCatch()
    const shedB = callAndCatch()
    await Promise.all([probe, shedA, shedB])

    expect(probeFetch).toHaveBeenCalledTimes(1)
    expect((await shedA).message).toMatch(/probe in flight/)
  })

  it('a failed probe re-opens for a fresh window', async () => {
    await tripBreaker()
    vi.setSystemTime(Date.now() + env.EVAL_BREAKER_OPEN_MS + 1)

    const probeFetch = unreachable()
    vi.stubGlobal('fetch', probeFetch)
    await callAndCatch() // the probe, and it fails

    expect(engineBreakerStatus().state).toBe('open')
    for (let i = 0; i < 5; i++) await callAndCatch()
    expect(probeFetch).toHaveBeenCalledTimes(1)
  })

  it('a successful probe closes the breaker and traffic resumes', async () => {
    await tripBreaker()
    vi.setSystemTime(Date.now() + env.EVAL_BREAKER_OPEN_MS + 1)

    const recovered = ok()
    vi.stubGlobal('fetch', recovered)

    const steps = await ocrImage('https://example.com/answer.jpg')
    expect(steps).toHaveLength(1)
    expect(engineBreakerStatus()).toEqual({ state: 'closed', consecutiveFailures: 0 })

    await ocrImage('https://example.com/answer.jpg')
    await ocrImage('https://example.com/answer.jpg')
    expect(recovered).toHaveBeenCalledTimes(3)
  })
})
