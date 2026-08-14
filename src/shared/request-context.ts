// Per-request context propagated through async calls via AsyncLocalStorage.
//
// The problem this solves: `pool.query` sits four or five awaits below the route
// handler and has no idea which request it is serving. Threading a context
// argument down through every service signature would touch ~19 files, so
// instead we seed an async-local store once in an `onRequest` hook and let the
// DB layer read it back out (see `query-log.ts`).
//
// Dev-only concern. Nothing here runs when query logging is disabled.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyRequest } from 'fastify'

export interface QueryRecord {
  sql: string
  params: readonly unknown[]
  durationMs: number
  /** `null` for statements pg reports no row count for (BEGIN, COMMIT, DDL). */
  rowCount: number | null
  /** Set when the statement threw; the query is still recorded so failures show up. */
  error?: string
}

export interface RequestContext {
  req: FastifyRequest
  queries: QueryRecord[]
}

/**
 * Also stashed on the request object itself. `onResponse` reads it from there
 * rather than from the store, because Fastify does not guarantee that response
 * hooks run inside the same async context that `onRequest` established.
 */
export const kRequestContext = Symbol('gv.requestContext')

const storage = new AsyncLocalStorage<RequestContext>()

export function runInRequestContext(req: FastifyRequest, next: () => void): void {
  const ctx: RequestContext = { req, queries: [] }
  ;(req as unknown as Record<symbol, unknown>)[kRequestContext] = ctx
  storage.run(ctx, next)
}

/** Returns `undefined` outside a request — worker jobs, schedulers, seed scripts. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

export function readRequestContext(req: FastifyRequest): RequestContext | undefined {
  return (req as unknown as Record<symbol, unknown>)[kRequestContext] as
    | RequestContext
    | undefined
}
