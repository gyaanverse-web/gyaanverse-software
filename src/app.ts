import Fastify from 'fastify'
import { authRoutes } from './modules/auth/auth.routes.js'
import { tenantRoutes } from './modules/tenant/tenant.routes.js'
import { inviteRoutes } from './modules/invite/invite.routes.js'
import { membershipRoutes } from './modules/membership/membership.routes.js'
import { classRoutes } from './modules/class/class.routes.js'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import cookie from '@fastify/cookie'
import sensible from '@fastify/sensible'
import rateLimit from '@fastify/rate-limit'

export async function buildApp() {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'warn' },
  })

  const isDev = process.env.NODE_ENV !== 'production'
  const appDomain = process.env.APP_DOMAIN
  const allowedOrigins: (string | RegExp)[] = isDev
    ? [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/]
    : appDomain
      ? [
          `https://${appDomain}`,
          new RegExp(`^https://[a-z0-9-]+\\.${appDomain.replace(/\./g, '\\.')}$`),
        ]
      : []

  await app.register(cors, { origin: allowedOrigins, credentials: true })
  await app.register(helmet)
  await app.register(cookie)
  await app.register(sensible)
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip ?? 'unknown',
    errorResponseBuilder: () => ({ error: 'RATE_LIMITED', message: 'Too many requests, please try again later' }),
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

  await app.register(authRoutes)
  await app.register(tenantRoutes)
  await app.register(inviteRoutes)
  await app.register(membershipRoutes)
  await app.register(classRoutes)

  return app
}
