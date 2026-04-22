import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import cookie from '@fastify/cookie'
import sensible from '@fastify/sensible'

export async function buildApp() {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : { level: 'warn' },
  })

  await app.register(cors, { origin: true, credentials: true })
  await app.register(helmet)
  await app.register(cookie)
  await app.register(sensible)

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

  // TODO: register module routes here as modules are built

  return app
}
