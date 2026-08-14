import { env } from '@config/env.js'
import { AppError } from '@shared/errors.js'
import type {
  EngineEvaluationResponse,
  EngineIndexDocument,
  EngineIndexResponse,
  EngineOcrStep,
} from './evaluation.types.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE ONLY DOOR TO THE PYTHON AI ENGINE.
//
// Every call to the AI — reading handwriting, grading steps, indexing syllabus
// documents — goes through `callEngine` below. Nothing else in the backend talks
// to the engine directly. That is what makes the safety features here apply
// everywhere automatically.
//
// ── THE CIRCUIT BREAKER (like a fuse in a house) ───────────────────────────
//
// THE PROBLEM: when the engine is down, every call sits and waits the full
// timeout (EVAL_ENGINE_TIMEOUT_MS, 120 seconds by default) before failing. With
// several workers running in parallel, that is every worker slot blocked for two
// minutes at a time, over and over, for as long as the outage lasts. And the
// retry rules then book the same 2-minute wait again. The 200th timeout teaches
// us nothing the 5th did not already.
//
// THE FIX: count the failures. After EVAL_BREAKER_THRESHOLD failures in a row
// the "fuse blows" and every call fails INSTANTLY for EVAL_BREAKER_OPEN_MS
// instead of waiting 120 seconds.
//
// IMPORTANT: this does not cancel any retries. The error is still
// ENGINE_UNREACHABLE, `classifyFailure` still calls it `transient`, and the job
// is still retried on schedule. It just stops paying two minutes to re-learn
// something we already know.
//
// THE THREE STATES:
//   closed     normal. Calls go through.
//   open       fuse blown. Calls fail immediately, no waiting.
//   half-open  the wait has passed; let exactly ONE call through to test the
//              water. If it works, back to `closed`. If it fails, `open` again
//              for another full window.
//
// This lives in memory, per process — not shared through Redis. Each worker
// discovers the outage on its own within a handful of calls. That costs a few
// extra timeouts per worker and saves us a whole category of coordination bugs.
// ─────────────────────────────────────────────────────────────────────────────

type BreakerState = 'closed' | 'open' | 'half-open'

const breaker = {
  consecutiveFailures: 0,
  openedAt: 0,
  probeInFlight: false,
}

/**
 * The two error codes that mean *the whole engine* is unavailable, and so are
 * the only ones allowed to blow the fuse.
 *
 * ENGINE_ERROR is deliberately NOT in this list. That code means the engine
 * answered us — it returned a 500 about one particular image. That is a problem
 * with that one upload, not with the engine. If it blew the fuse, a single bad
 * photo would make every other student's paper fail instantly. It also returns
 * quickly, so it does not waste the 120 seconds this whole mechanism exists to
 * save.
 */
const BREAKER_TRIP_CODES = new Set(['ENGINE_UNREACHABLE', 'ENGINE_TIMEOUT'])

function breakerState(): BreakerState {
  if (breaker.consecutiveFailures < env.EVAL_BREAKER_THRESHOLD) return 'closed'
  if (Date.now() - breaker.openedAt >= env.EVAL_BREAKER_OPEN_MS) return 'half-open'
  return 'open'
}

function recordSuccess(): void {
  if (breaker.consecutiveFailures >= env.EVAL_BREAKER_THRESHOLD) {
    console.log('[evaluation-engine] circuit closed — engine responding again')
  }
  breaker.consecutiveFailures = 0
  breaker.openedAt = 0
  breaker.probeInFlight = false
}

function recordFailure(code: string): void {
  breaker.probeInFlight = false
  if (!BREAKER_TRIP_CODES.has(code)) return

  breaker.consecutiveFailures++
  // Restart the clock on every failure that counts. This is what makes a failed
  // test call ("half-open") buy another full waiting window, instead of us
  // testing the engine again on the very next call.
  if (breaker.consecutiveFailures >= env.EVAL_BREAKER_THRESHOLD) {
    const wasOpen = breaker.openedAt > 0
    breaker.openedAt = Date.now()
    if (!wasOpen) {
      console.warn(
        `[evaluation-engine] circuit OPEN after ${breaker.consecutiveFailures} ` +
          `consecutive failures (${code}) — failing fast for ${env.EVAL_BREAKER_OPEN_MS}ms`,
      )
    }
  }
}

/** For tests only. Never called by the running app — the fuse lives as long as
 *  the process does. */
export function resetEngineBreaker(): void {
  breaker.consecutiveFailures = 0
  breaker.openedAt = 0
  breaker.probeInFlight = false
}

/** A look at the fuse without touching it — used by health checks and tests. */
export function engineBreakerStatus(): { state: BreakerState; consecutiveFailures: number } {
  return { state: breakerState(), consecutiveFailures: breaker.consecutiveFailures }
}

/**
 * Make one call to the AI engine, with the fuse and a timeout around it.
 *
 * Every failure is turned into one of four stable codes, because the rest of the
 * system decides what to do based on the CODE, not on the error message:
 *
 *   ENGINE_UNREACHABLE  503  we could not reach it at all (or the fuse is blown)
 *   ENGINE_TIMEOUT      504  it never answered within EVAL_ENGINE_TIMEOUT_MS
 *   ENGINE_ERROR        502  it answered with an error about this one request
 *   ENGINE_BAD_RESPONSE 502  it answered, but not with valid JSON
 */
async function callEngine<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const state = breakerState()
  if (state === 'open') {
    throw new AppError(
      'ENGINE_UNREACHABLE',
      `Engine circuit open after ${breaker.consecutiveFailures} consecutive failures`,
      503,
    )
  }
  // `half-open` lets exactly ONE call through to test whether the engine is back.
  // Everyone else keeps failing instantly until that test call reports its
  // result. Without this, an engine that is just coming back up would be hit by
  // the entire waiting batch at once — at the exact moment it is least able to
  // cope — and it would go straight back down.
  if (state === 'half-open') {
    if (breaker.probeInFlight) {
      throw new AppError('ENGINE_UNREACHABLE', 'Engine circuit open — probe in flight', 503)
    }
    breaker.probeInFlight = true
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.EVAL_ENGINE_TIMEOUT_MS)

  try {
    const res = await fetch(`${env.EVAL_ENGINE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await res.text()
    let parsed: any
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new AppError(
        'ENGINE_BAD_RESPONSE',
        `Engine returned non-JSON response (${res.status})`,
        502,
      )
    }

    if (!res.ok) {
      const message = parsed?.error ?? `Engine call failed (${res.status})`
      throw new AppError('ENGINE_ERROR', String(message), 502)
    }

    recordSuccess()
    return parsed as T
  } catch (err) {
    const appErr = toAppError(err)
    recordFailure(appErr.code)
    throw appErr
  } finally {
    clearTimeout(timeout)
  }
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  if ((err as Error).name === 'AbortError') {
    return new AppError('ENGINE_TIMEOUT', 'Engine call timed out', 504)
  }
  return new AppError('ENGINE_UNREACHABLE', `Engine unreachable: ${(err as Error).message}`, 503)
}

export async function ocrImage(source: string): Promise<EngineOcrStep[]> {
  const result = await callEngine<{ ocr_data: EngineOcrStep[] }>('/get_json_ocr', { source })
  return Array.isArray(result.ocr_data) ? result.ocr_data : []
}

export async function evaluateSteps(params: {
  ocrData: EngineOcrStep[]
  question: string
  collectionName?: string
  topK?: number
}): Promise<EngineEvaluationResponse> {
  const body: Record<string, unknown> = {
    ocr_data: params.ocrData,
    question: params.question,
  }
  if (params.collectionName) body.collection_name = params.collectionName
  if (params.topK !== undefined) body.top_k = params.topK
  return callEngine<EngineEvaluationResponse>('/checked_json_ocr', body)
}

export async function indexDocuments(params: {
  documents: EngineIndexDocument[]
  collectionName?: string
}): Promise<EngineIndexResponse> {
  const body: Record<string, unknown> = { documents: params.documents }
  if (params.collectionName) body.collection_name = params.collectionName
  return callEngine<EngineIndexResponse>('/index_documents', body)
}

export async function indexTextDocuments(params: {
  documentPaths: string[]
  collectionName?: string
}): Promise<EngineIndexResponse> {
  const body: Record<string, unknown> = { document_paths: params.documentPaths }
  if (params.collectionName) body.collection_name = params.collectionName
  return callEngine<EngineIndexResponse>('/index_text_documents', body)
}
