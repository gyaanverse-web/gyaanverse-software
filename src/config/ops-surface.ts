import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { env } from './env.js'

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR SURFACES — the shared rule for anything mounted on the API that is
// for us rather than for a coaching.
//
// There are two of them today: the queue dashboard (`/queues`) and the API
// documentation (`/docs`). They are not the same kind of thing — one restarts
// jobs, the other only describes routes — but they share one property that
// decides how they are exposed: **neither is part of the product**. No student,
// teacher or owner has a reason to load either, so an anonymous request to one
// in production is either us or somebody mapping the system.
//
// One rule covers both, and it is deliberately the same rule so there is only
// one thing to remember when promoting an environment:
//
//   development / staging   mounted. Unguarded unless you set a password.
//   production              mounted ONLY if a password is set. No password
//                           means the surface does not exist — not that it
//                           exists unguarded.
//
// **Fail closed, never fail open.** The failure this prevents is silent: an
// environment variable that was never copied across to the new project, and a
// public queue console or a public route map as the result. An absent surface
// announces itself the moment an operator goes looking for it; an unguarded one
// announces itself to everybody else first.
//
// The IP allowlist is defence in depth and never the gate on its own. Railway
// terminates TLS at its own edge, so `req.ip` is one hop of a client-supplied
// X-Forwarded-For (see `trustProxy` in app.ts). Good for narrowing to an office
// IP; not something to rest access on.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Hashed first so the buffers are always 32 bytes: `timingSafeEqual` throws
 * outright on a length mismatch, which would both break the check and turn the
 * length of the configured password into an observable.
 */
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

/** `::ffff:203.0.113.4` and `203.0.113.4` are the same host; allowlists are written as the latter. */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

/** Split a comma-separated `*_IPS` variable into entries, tolerating spaces and trailing commas. */
export function parseIpAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export type SurfaceAccess = { ok: true } | { ok: false; status: 401 | 404 }

/**
 * Decide whether one request may reach an operator surface.
 *
 * A pure function on purpose: this is the security decision, and the Fastify
 * hook around it is plumbing. Testing it directly means the interesting cases
 * (an empty allowlist, a password with a colon in it, a wrong username with the
 * right password) are unit tests rather than HTTP fixtures.
 *
 * **A blocked IP gets 404, not 403.** There is no reason to tell an address that
 * has already failed the allowlist that anything lives at this path.
 */
export function checkSurfaceAccess(opts: {
  ip: string
  authorization: string | undefined
  user: string
  password: string
  allowedIps: string[]
}): SurfaceAccess {
  if (opts.allowedIps.length > 0 && !opts.allowedIps.includes(normalizeIp(opts.ip))) {
    return { ok: false, status: 404 }
  }

  // No password configured means this guard was mounted for the allowlist
  // alone — legitimate in dev, refused in production by `mountOpsSurface`.
  if (!opts.password) return { ok: true }

  const [scheme, encoded] = (opts.authorization ?? '').split(' ')
  if (!encoded || scheme.toLowerCase() !== 'basic') return { ok: false, status: 401 }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const sep = decoded.indexOf(':')
  if (sep === -1) return { ok: false, status: 401 }

  // `indexOf`, not `split` — a password containing a colon is valid and
  // splitting on every colon would silently truncate it to the first segment.
  const user = decoded.slice(0, sep)
  const password = decoded.slice(sep + 1)

  // Both halves always compared, never short-circuited on the username: an
  // early return on a wrong user is a timing oracle for which accounts exist.
  const userOk = secretEquals(user, opts.user)
  const passwordOk = secretEquals(password, opts.password)

  return userOk && passwordOk ? { ok: true } : { ok: false, status: 401 }
}

export type OpsSurfaceOptions = {
  /** Human name used in logs and the WWW-Authenticate realm, e.g. `queue dashboard`. */
  name: string
  /** The env var to name in the "not mounted" warning, e.g. `BULL_BOARD_PASSWORD`. */
  passwordVar: string
  user: string
  password: string
  /** Raw comma-separated allowlist, straight from the env var. */
  ips: string
  /** Registers the actual routes inside the guarded scope. */
  register: (scope: FastifyInstance) => Promise<void>
}

/**
 * Mount an operator surface behind the shared guard — or deliberately don't.
 *
 * Returns whether it was mounted, so the caller can skip anything that depends
 * on it (`/openapi.json` has nothing to serve if Swagger never registered).
 */
export async function mountOpsSurface(
  app: FastifyInstance,
  opts: OpsSurfaceOptions,
): Promise<boolean> {
  const isProd = env.NODE_ENV === 'production'
  const allowedIps = parseIpAllowlist(opts.ips)

  if (isProd && !opts.password) {
    app.log.warn(
      `${opts.name} not mounted: ${opts.passwordVar} is unset. Operator surfaces are ` +
        'never exposed unguarded in production — set a password to enable it.',
    )
    return false
  }

  const guarded = Boolean(opts.password) || allowedIps.length > 0

  await app.register(async (scope) => {
    if (guarded) {
      scope.addHook('onRequest', async (req, reply) => {
        const verdict = checkSurfaceAccess({
          ip: req.ip ?? '',
          authorization: req.headers.authorization,
          user: opts.user,
          password: opts.password,
          allowedIps,
        })
        if (verdict.ok) return

        if (verdict.status === 401) {
          reply.header('WWW-Authenticate', `Basic realm="Gyanverse ${opts.name}", charset="UTF-8"`)
          return reply
            .status(401)
            .send({ error: 'UNAUTHORIZED', message: `${opts.name} requires credentials` })
        }
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Route not found' })
      })
    }

    await opts.register(scope)
  })

  if (!isProd) {
    app.log.info(
      `${opts.name} available at http://localhost:${env.PORT} ` +
        (guarded ? '(guarded)' : '(unguarded — dev only)'),
    )
  }
  return true
}
