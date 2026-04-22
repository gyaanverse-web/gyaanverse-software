import { buildApp } from './app.js'
import { env } from './config/env.js'

async function startServer() {
  const app = await buildApp()

  app.listen({ port: env.PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
      app.log.error(err)
      process.exit(1)
    }
  })
}

startServer().catch((err) => {
  console.error('[server] failed to start:', err)
  process.exit(1)
})
