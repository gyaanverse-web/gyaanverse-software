import IORedis from 'ioredis'
import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { env } from '../config/env.js'
import { AppError } from './errors.js'

/**
 * Rate-limiting primitives shared by the global @fastify/rate-limit plugin and
 * the per-identifier throttles on the credential routes.
 *
 * Two separate mechanisms, deliberately:
 *
 *   - The **plugin** counts requests per caller (session, else IP) and is the
 *     general flood guard. Registered in app.ts.
 *   - `throttleBy` counts attempts per *credential* — a specific email address
 *     or phone number — and is the brute-force guard. Keying those on IP alone
 *     is useless against a distributed attacker and actively harmful to a
 *     coaching centre, where thirty students behind one NAT would lock each
 *     other out of the login form.
 */

// Dedicated connection: the limiter must not compete with BullMQ's clients for
// the connection pool, and it needs settings BullMQ explicitly forbids
// (`maxRetriesPerRequest` must be null for a queue).
let _client: IORedis | null = null
let _errorLogged = false

export function getRateLimitRedis(): IORedis {
  if (!_client) {
    _client = new IORedis(env.REDIS_URL, {
      // The limiter sits on the hot path of every request, so a sick Redis must
      // fail fast rather than add latency. With `enableOfflineQueue: false`
      // commands reject immediately while disconnected instead of piling up in
      // a queue that drains all at once on reconnect.
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })

    // An ioredis client with no 'error' listener throws unhandled and takes the
    // process down. Log the first failure of each outage — every request would
    // otherwise emit one — and re-arm on reconnect.
    _client.on('error', (err: Error) => {
      if (_errorLogged) return
      _errorLogged = true
      console.warn(`[rate-limit] Redis unavailable, limiter is failing open: ${err.message}`)
    })
    _client.on('ready', () => {
      _errorLogged = false
    })
  }
  return _client
}

/**
 * Block until the limiter's Redis is usable, up to `timeoutMs`.
 *
 * `enableOfflineQueue: false` means every command issued before the socket is
 * up rejects immediately — so without this the limiter silently fails open for
 * the first stretch of a process's life, which is exactly when a restart loop
 * would be hammering it. Awaited once during boot; returns false rather than
 * throwing so a missing Redis degrades the limiter instead of the whole API.
 */
export function waitForRateLimitRedis(timeoutMs = 2000): Promise<boolean> {
  const redis = getRateLimitRedis()
  if (redis.status === 'ready') return Promise.resolve(true)

  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      clearTimeout(timer)
      redis.off('ready', onReady)
      resolve(ok)
    }
    const onReady = () => settle(true)
    const timer = setTimeout(() => settle(false), timeoutMs)
    redis.once('ready', onReady)
  })
}

/**
 * Cheap fail-open guard. Issuing a command on a disconnected client with the
 * offline queue disabled throws per call, so check the status first rather than
 * paying for an exception on every request of an outage.
 */
function usable(redis: IORedis): boolean {
  return redis.status === 'ready'
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

// Better Auth's session cookie. The `__Secure-` variant is what actually
// arrives in production (secure cookies over HTTPS); the bare name is dev.
// There is no `__Host-` variant to handle — that prefix forbids a Domain
// attribute, and config/auth.ts sets one for cross-subdomain sessions.
const SESSION_COOKIE = 'better-auth.session_token'

/**
 * Pull the session token straight out of the raw Cookie header.
 *
 * Deliberately not using `req.cookies` from @fastify/cookie: that decorator is
 * populated by the plugin's own onRequest hook, and the limiter runs at
 * onRequest too — the relative order of two plugins' hooks is registration
 * order, which is a dependency too subtle to rest a security control on.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE || name === `__Secure-${SESSION_COOKIE}`) {
      return part.slice(eq + 1).trim() || null
    }
  }
  return null
}

/**
 * The global limiter key: one bucket per signed-in device, falling back to IP
 * for anonymous callers.
 *
 * Keying on IP alone is wrong for this product. A coaching centre is one NAT,
 * so every student there shares a single bucket and a normal morning looks
 * exactly like a flood. The session token is the closest thing to a per-device
 * identity available at onRequest, before any auth middleware has run.
 *
 * Hashed because this value becomes a Redis key — a live session token must
 * never be persisted or logged in a form that could be replayed.
 */
export function rateLimitKey(req: FastifyRequest): string {
  const token = readSessionCookie(req.headers.cookie)
  if (token) return `s:${fingerprint(token)}`
  return `ip:${req.ip ?? 'unknown'}`
}

/**
 * Throttle attempts against a single credential.
 *
 * @param scope      Bucket namespace, e.g. 'signin' — keeps a phone number's
 *                   OTP-send budget separate from its OTP-verify budget.
 * @param identifier The email or phone the attempt targets. Hashed before use.
 * @param max        Attempts allowed per window.
 * @param windowSec  Window length in seconds.
 *
 * Fails **open** if Redis is unreachable: locking every user out of sign-in is
 * a worse outage than briefly losing brute-force protection, and the plugin's
 * per-IP limit still applies as a backstop.
 */
export async function throttleBy(
  scope: string,
  identifier: string,
  max: number,
  windowSec: number,
): Promise<void> {
  const redis = getRateLimitRedis()
  if (!usable(redis)) return

  const key = `throttle:${scope}:${fingerprint(identifier.trim().toLowerCase())}`

  let count: number
  try {
    count = await redis.incr(key)
    // Only the attempt that created the key sets its TTL, so the window is
    // fixed from the first attempt rather than sliding forward on every hit
    // (which would let a steady drip of requests keep the key alive forever).
    if (count === 1) await redis.expire(key, windowSec)
  } catch {
    return
  }

  if (count <= max) return

  let retryIn = windowSec
  try {
    const ttl = await redis.ttl(key)
    if (ttl > 0) retryIn = ttl
  } catch {
    /* keep the nominal window */
  }

  throw new AppError(
    'RATE_LIMITED',
    `Too many attempts. Please try again in ${retryIn}s.`,
    429,
  )
}

/**
 * Drop a throttle bucket after a successful attempt, so the limit only ever
 * counts *failures*. Without this, someone legitimately signing in across a
 * few devices spends the same budget as an attacker guessing passwords.
 */
export async function clearThrottle(scope: string, identifier: string): Promise<void> {
  const redis = getRateLimitRedis()
  if (!usable(redis)) return

  try {
    await redis.del(`throttle:${scope}:${fingerprint(identifier.trim().toLowerCase())}`)
  } catch {
    /* the bucket expires on its own; nothing to recover */
  }
}
