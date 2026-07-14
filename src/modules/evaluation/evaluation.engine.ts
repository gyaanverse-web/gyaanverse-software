import { env } from '@config/env.js'
import { AppError } from '@shared/errors.js'
import type {
  EngineEvaluationResponse,
  EngineIndexDocument,
  EngineIndexResponse,
  EngineOcrStep,
} from './evaluation.types.js'

async function callEngine<T>(path: string, body: Record<string, unknown>): Promise<T> {
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

    return parsed as T
  } catch (err) {
    if (err instanceof AppError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new AppError('ENGINE_TIMEOUT', 'Engine call timed out', 504)
    }
    throw new AppError('ENGINE_UNREACHABLE', `Engine unreachable: ${(err as Error).message}`, 503)
  } finally {
    clearTimeout(timeout)
  }
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
