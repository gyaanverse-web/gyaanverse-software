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
import { storageRoutes } from './modules/storage/storage.routes.js'
import { reportRoutes } from './modules/report/report.routes.js'
import { adminRoutes } from './modules/admin/admin.routes.js'
import { createBoard } from './config/bull-board.js'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import cookie from '@fastify/cookie'
import sensible from '@fastify/sensible'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { swaggerConfig } from './config/swagger.js'

export async function buildApp() {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'warn' },
  })

  const isDev = process.env.NODE_ENV !== 'production'
  const appDomain = process.env.APP_DOMAIN
  const prodOrigins: (string | RegExp)[] = appDomain
    ? [
        `https://${appDomain}`,
        new RegExp(`^https://[a-z0-9-]+\\.${appDomain.replace(/\./g, '\\.')}$`),
      ]
    : []

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
    max: isDev ? 500 : 500,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip ?? 'unknown',
    // Return 429 with a structured body so the frontend can distinguish rate-limit
    // errors from auth failures (default statusCode is 429, not 500)
    errorResponseBuilder: (_req, context) => ({
      error: 'RATE_LIMITED',
      message: `Too many requests, please try again in ${Math.ceil(context.ttl / 1000)}s`,
    }),
  })

  // ── OpenAPI docs (/docs) — register before routes so all routes are picked up ──
  await app.register(swagger, swaggerConfig)
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
  })

  app.get('/openapi.json', async (_req, reply) => {
    reply.send(app.swagger())
  })

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
  await app.register(storageRoutes)
  await app.register(reportRoutes)
  await app.register(adminRoutes)

  if (isDev) {
    const board = createBoard()
    await app.register(board.registerPlugin(), { prefix: '/queues' })
    app.log.info('Bull Board available at http://localhost:8000/queues')
  }

  return app
}
