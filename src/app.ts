import Fastify from 'fastify'
import { billingRoutes } from './modules/billing/billing.routes.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { tenantRoutes } from './modules/tenant/tenant.routes.js'
import { inviteRoutes } from './modules/invite/invite.routes.js'
import { membershipRoutes } from './modules/membership/membership.routes.js'
import { classRoutes } from './modules/class/class.routes.js'
import { questionBankRoutes } from './modules/question-bank/question-bank.routes.js'
import { examRoutes } from './modules/exam/exam.routes.js'
import { examSessionRoutes } from './modules/exam-session/exam-session.routes.js'
import { paymentRoutes } from './modules/payment/payment.routes.js'
import { notificationRoutes } from './modules/notification/notification.routes.js'
import { evaluationRoutes } from './modules/evaluation/evaluation.routes.js'
import { evaluationInternalRoutes } from './modules/evaluation/evaluation.internal.routes.js'
import { storageRoutes } from './modules/storage/storage.routes.js'
import { reportRoutes } from './modules/report/report.routes.js'
import { examReviewRoutes } from './modules/exam-review/exam-review.routes.js'
import { platformRoutes } from './modules/platform/platform.routes.js'
import { registerBullBoard } from './config/bull-board.js'
import { registerApiDocs } from './config/docs.js'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import cookie from '@fastify/cookie'
import sensible from '@fastify/sensible'
import rateLimit from '@fastify/rate-limit'
import { registerQueryLog } from './shared/query-log.js'
import { getRateLimitRedis, rateLimitKey, waitForRateLimitRedis } from './shared/rate-limit.js'

export async function buildApp() {
  const isDev = process.env.NODE_ENV !== 'production'

  const app = Fastify({
    // In production the API sits behind Railway's edge proxy, so the socket's
    // remote address is the proxy — identical for every user on earth. Without
    // this, `req.ip` collapses all traffic into a single rate-limit bucket.
    //
    // `1` (trust exactly one hop), never `true`: `true` walks the whole
    // X-Forwarded-For chain, and clients control that header — an attacker
    // could present a fresh IP per request and bypass the limiter entirely.
    // If a CDN is ever added in front of Railway this becomes 2; verify against
    // a real request's X-Forwarded-For rather than assuming.
    trustProxy: isDev ? false : 1,
    logger:
      process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'warn' },
  })

  // Registered first so the async-local store wraps the whole request lifecycle —
  // every later hook, preHandler and handler runs inside it. Dev-only; see
  // shared/query-log.ts.
  registerQueryLog(app)

  const appDomain = process.env.APP_DOMAIN
  const prodOrigins: (string | RegExp)[] = appDomain
    ? [
        `https://${appDomain}`,
        new RegExp(`^https://[a-z0-9-]+\\.${appDomain.replace(/\./g, '\\.')}$`),
      ]
    : []

  // The operator panel is deployed separately from the app (see env.ts). While it
  // sits at admin.<APP_DOMAIN> the regex above already covers it and this adds
  // nothing; once it moves to its own domain — the point of deploying it apart —
  // this line is what keeps it able to reach the API at all.
  //
  // Worth knowing when it does move: a missing origin here does not present as an
  // auth or config error, it presents as a CORS failure in the browser, which is
  // exactly how the 2026 wildcard-TLS incident disguised itself. If the panel
  // dies on a domain switch, check OPS_ORIGIN before believing the error.
  const opsOrigin = process.env.OPS_ORIGIN
  if (opsOrigin) prodOrigins.push(opsOrigin)

  await app.register(cors, {
    origin: isDev ? true : prodOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug'],
  })
  // Disable CSP in dev so the Swagger UI (inline scripts/styles) loads without issues
  await app.register(helmet, {
    contentSecurityPolicy: isDev ? false : undefined,
  })
  await app.register(cookie)
  await app.register(sensible)
  await app.register(rateLimit, {
    global: true,
    max: 500,
    timeWindow: '1 minute',
    // Shared counters across API replicas. The default in-memory store gives
    // each instance its own budget (so N replicas = N x the intended limit) and
    // wipes every count on deploy.
    redis: getRateLimitRedis(),
    nameSpace: 'rl:',
    // Never 500 a request because the limiter's Redis is unhappy — the plugin's
    // default is to rethrow the store error. Failing open here is the right
    // trade: an unlimited minute beats a total outage.
    skipOnError: true,
    // Uptime checks must not consume anyone's budget.
    allowList: (req) => req.url === '/health',
    // One bucket per signed-in device rather than per IP — see shared/rate-limit.ts
    // for why IP keying breaks a coaching centre behind a single NAT.
    keyGenerator: rateLimitKey,
    // Return 429 with a structured body so the frontend can distinguish rate-limit
    // errors from auth failures (default statusCode is 429, not 500)
    errorResponseBuilder: (_req, context) => ({
      error: 'RATE_LIMITED',
      message: `Too many requests, please try again in ${Math.ceil(context.ttl / 1000)}s`,
    }),
  })

  // The limiter fails open while its Redis connection is still being
  // established, so give it a bounded moment to come up before we start serving.
  // Without this every limit is unenforced for the first stretch after boot —
  // precisely the window a crash-looping instance spends serving traffic.
  if (!(await waitForRateLimitRedis())) {
    app.log.warn('Rate limiter Redis not ready — limits fail open until it connects')
  }

  // ── Bull Board (/queues) — the fallback ops surface ─────────────────────────
  //
  // Registered BEFORE swagger, and that ordering is the point: @fastify/swagger's
  // `onRoute` hook only sees routes added after it, so nothing under /queues can
  // reach the public spec even if a library stops setting `schema.hide` for us.
  // The board's own hook forces `hide` as well — see config/bull-board.ts for
  // why this is belted and braced rather than trusted to one mechanism.
  //
  // Mounts only when it is safe to: in production, a missing BULL_BOARD_PASSWORD
  // means no board at all, never an unguarded one.
  await registerBullBoard(app)

  // ── OpenAPI docs (/docs) ───────────────────────────────────────────────────
  //
  // Registered before the route files, because @fastify/swagger collects routes
  // through an `onRoute` hook and cannot see anything added before it.
  //
  // Same fail-closed rule as /queues: open in dev and staging, and in production
  // only when API_DOCS_PASSWORD is set. See config/docs.ts.
  await registerApiDocs(app)

  app.setErrorHandler((error: any, req, reply) => {
    if (error.name === 'AppError') {
      reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      })
      return
    }

    if (error.validation) {
      reply.status(422).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.validation,
      })
      return
    }

    req.log.error(error)
    reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    })
  })

  app.get('/health', async () => ({ status: 'ok' }))

  await app.register(billingRoutes)
  await app.register(authRoutes)
  await app.register(tenantRoutes)
  await app.register(inviteRoutes)
  await app.register(membershipRoutes)
  await app.register(classRoutes)
  await app.register(questionBankRoutes)
  await app.register(examRoutes)
  await app.register(examSessionRoutes)
  await app.register(paymentRoutes)
  await app.register(notificationRoutes)
  await app.register(evaluationRoutes)
  // Gyaanverse platform ops — cross-tenant, super_admin only, hidden from Swagger.
  await app.register(evaluationInternalRoutes)
  await app.register(storageRoutes)
  await app.register(reportRoutes)
  await app.register(examReviewRoutes)
  await app.register(platformRoutes)

  return app
}
