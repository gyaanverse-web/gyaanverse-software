// Dev-only SQL tracing: shows which tables each endpoint actually touches.
//
// On in development, off in production and under vitest; force it either way
// with DB_QUERY_LOG=1 / DB_QUERY_LOG=0 (DB_QUERY_LOG=1 is the way to trace a
// misbehaving test). Set DB_QUERY_LOG_SQL=full to print whole statements and
// their bind params instead of the one-line summary.
//
//   ┌ POST /exams  tenant=niazi user=a3f1c2d4
//   │  BEGIN
//   │  INSERT  exams                     1 row     3.2ms
//   │  SELECT  question_bank            24 rows    2.1ms
//   │  COMMIT
//   └ 201 · 4 queries · 13.1ms
//
// Two deliberate choices:
//
//  1. We wrap the `pg` Pool rather than passing `logger` to drizzle. Drizzle's
//     logger hands us SQL and params only; the pool gives us duration and
//     rowCount too, and it also catches better-auth (which shares this `db` via
//     `drizzleAdapter`) plus any raw SQL.
//
//  2. We patch `pool.connect()` as well as `pool.query()`. `db.transaction()`
//     checks out a dedicated client, so pool-level wrapping alone would go
//     blind inside exactly the flows worth watching — exam publish, evaluation,
//     payment (28 call sites).
//
// Output goes straight to stdout rather than through pino: the box drawing
// survives that way instead of being swallowed into a JSON `msg` field.
import type { Pool, PoolClient } from 'pg'
import type { FastifyInstance } from 'fastify'
import {
  getRequestContext,
  readRequestContext,
  runInRequestContext,
  type QueryRecord,
} from './request-context.js'

export const queryLogEnabled = (() => {
  const flag = process.env.DB_QUERY_LOG
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  // 'test' is excluded because the suite runs hundreds of queries with no
  // request behind them, which buries the vitest reporter output.
  return process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
})()

const showFullSql = process.env.DB_QUERY_LOG_SQL === 'full'

/** Repeating one statement this many times in a request is almost always an N+1. */
const N_PLUS_ONE_THRESHOLD = 5

// ── formatting ───────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint('2')
const bold = paint('1')
const cyan = paint('36')
const yellow = paint('33')
const red = paint('31')
const green = paint('32')

/**
 * Best-effort table name. Drizzle quotes identifiers, so the first `from` /
 * `into` / `update` target is reliable in practice; a subquery-first statement
 * may attribute to the inner table, which is a cosmetic miss, not a bug.
 */
function extractTable(sql: string): string {
  const match = /\b(?:from|into|update)\s+(?:only\s+)?"?([a-z_][a-z0-9_$]*)"?/i.exec(sql)
  return match?.[1] ?? '—'
}

function extractOperation(sql: string): string {
  return (/^\s*\(*\s*([a-z]+)/i.exec(sql)?.[1] ?? '?').toUpperCase()
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function formatParams(params: readonly unknown[]): string {
  const rendered = params.map((p) => {
    if (p === null || p === undefined) return 'null'
    if (p instanceof Date) return p.toISOString()
    if (typeof p === 'object') return truncate(JSON.stringify(p), 40)
    if (typeof p === 'string') return `'${truncate(p, 40)}'`
    return String(p)
  })
  return `[${rendered.join(', ')}]`
}

function formatRows(rowCount: number | null): string {
  if (rowCount === null) return ''
  return `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
}

function formatDuration(ms: number): string {
  const text = `${ms.toFixed(1)}ms`
  if (ms >= 100) return red(text)
  if (ms >= 25) return yellow(text)
  return dim(text)
}

/** BEGIN / COMMIT / ROLLBACK are rendered bare — they mark transaction scope. */
const TRANSACTION_KEYWORDS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT'])

function formatQueryLine(record: QueryRecord): string {
  const sql = collapse(record.sql)
  const operation = extractOperation(sql)

  if (TRANSACTION_KEYWORDS.has(operation) && !showFullSql) {
    return dim(operation)
  }

  const head = showFullSql
    ? truncate(sql, 160)
    : `${operation.padEnd(7)} ${cyan(extractTable(sql).padEnd(24))} ${formatRows(record.rowCount).padStart(9)}`

  let line = `${head}  ${formatDuration(record.durationMs)}`
  if (showFullSql && record.params.length > 0) line += `\n│      ${dim(formatParams(record.params))}`
  if (record.error) line += `  ${red(`✖ ${truncate(record.error, 80)}`)}`
  return line
}

function statusColor(status: number): (s: string) => string {
  if (status >= 500) return red
  if (status >= 400) return yellow
  return green
}

// ── printing ─────────────────────────────────────────────────────────────────

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

/**
 * Queries with no request behind them: BullMQ workers, the exam scheduler, seed
 * scripts. Printed as they happen since there is no response to batch them at.
 */
function printStandalone(record: QueryRecord): void {
  const sql = collapse(record.sql)
  if (TRANSACTION_KEYWORDS.has(extractOperation(sql))) return
  write(`${dim('·')} ${formatQueryLine(record)}`)
}

function printRequest(
  method: string,
  url: string,
  labels: string,
  status: number,
  elapsedMs: number,
  queries: QueryRecord[],
): void {
  const header = `${bold(method)} ${url}${labels ? `  ${dim(labels)}` : ''}`
  write(`${dim('┌')} ${header}`)
  for (const record of queries) write(`${dim('│')}  ${formatQueryLine(record)}`)

  const counts = new Map<string, number>()
  for (const record of queries) {
    const key = collapse(record.sql)
    if (TRANSACTION_KEYWORDS.has(extractOperation(key))) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const summary = [
    statusColor(status)(String(status)),
    `${queries.length} ${queries.length === 1 ? 'query' : 'queries'}`,
    `${elapsedMs.toFixed(1)}ms`,
  ].join(dim(' · '))
  write(`${dim('└')} ${summary}`)

  for (const [sql, count] of counts) {
    if (count < N_PLUS_ONE_THRESHOLD) continue
    write(
      `  ${yellow('⚠ N+1?')} ${dim(`${count}× ${extractOperation(sql)} ${extractTable(sql)}`)}`,
    )
  }
}

// ── recording ────────────────────────────────────────────────────────────────

function record(entry: QueryRecord): void {
  const ctx = getRequestContext()
  if (ctx) ctx.queries.push(entry)
  else printStandalone(entry)
}

/**
 * `pool.query` accepts either a SQL string or a `{ text }` config object —
 * drizzle uses the config form for prepared statements, better-auth the string
 * form. The callback overload is passed straight through untouched; nothing in
 * this codebase uses it, and instrumenting it would mean rewriting the callback.
 */
function instrumentQueryMethod<T extends { query: (...args: any[]) => any }>(target: T): void {
  const original = target.query.bind(target)

  target.query = function instrumentedQuery(this: unknown, ...args: any[]) {
    if (args.some((arg) => typeof arg === 'function')) return original(...args)

    const [config, values] = args
    const sql: string =
      typeof config === 'string' ? config : (config?.text ?? String(config ?? ''))
    const params: readonly unknown[] = Array.isArray(values)
      ? values
      : Array.isArray(config?.values)
        ? config.values
        : []

    const startedAt = performance.now()
    let result: any
    try {
      result = original(...args)
    } catch (error) {
      record({
        sql,
        params,
        durationMs: performance.now() - startedAt,
        rowCount: null,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    // pg always returns a promise here (the callback overload bailed out above),
    // but stay defensive: an unexpected sync return is passed through unchanged.
    if (!result || typeof result.then !== 'function') return result

    return result.then(
      (value: { rowCount?: number | null }) => {
        record({
          sql,
          params,
          durationMs: performance.now() - startedAt,
          rowCount: value?.rowCount ?? null,
        })
        return value
      },
      (error: unknown) => {
        record({
          sql,
          params,
          durationMs: performance.now() - startedAt,
          rowCount: null,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    )
  } as T['query']
}

/** Pooled clients are reused across checkouts; this keeps us from double-wrapping. */
const kInstrumented = Symbol('gv.queryLogInstrumented')

function instrumentClient(client: PoolClient): PoolClient {
  const flagged = client as unknown as Record<symbol, boolean>
  if (flagged[kInstrumented]) return client
  flagged[kInstrumented] = true
  instrumentQueryMethod(client)
  return client
}

export function instrumentPool(pool: Pool): Pool {
  if (!queryLogEnabled) return pool

  instrumentQueryMethod(pool)

  // Cast away pg's `connect` overloads (promise form vs callback form); they do
  // not survive a spread, and we dispatch on the argument shape ourselves.
  const originalConnect = pool.connect.bind(pool) as (...args: any[]) => any
  pool.connect = function instrumentedConnect(this: unknown, ...args: any[]) {
    if (args.some((arg) => typeof arg === 'function')) return originalConnect(...args)
    return (originalConnect() as Promise<PoolClient>).then(instrumentClient)
  } as Pool['connect']

  return pool
}

// ── Fastify wiring ───────────────────────────────────────────────────────────

export function registerQueryLog(app: FastifyInstance): void {
  if (!queryLogEnabled) return

  // Seeding the store in `onRequest` and calling `done` from inside `als.run`
  // makes every later hook, handler and query part of that async context.
  app.addHook('onRequest', (req, _reply, done) => runInRequestContext(req, done))

  app.addHook('onResponse', (req, reply, done) => {
    const ctx = readRequestContext(req)
    // Requests that touched no tables (/health, /docs, preflights) print nothing —
    // otherwise the noise buries the traces worth reading.
    if (ctx && ctx.queries.length > 0) {
      // Read tenant/user at flush time, not at onRequest: both are attached by
      // preHandlers that have not run yet when the store is created.
      const labels = [
        req.tenant ? `tenant=${req.tenant.slug}` : undefined,
        req.user ? `user=${req.user.id.slice(0, 8)}` : undefined,
      ]
        .filter(Boolean)
        .join(' ')

      printRequest(req.method, req.url, labels, reply.statusCode, reply.elapsedTime, ctx.queries)
    }
    done()
  })
}
