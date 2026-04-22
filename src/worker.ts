import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { env } from './config/env.js'

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

async function startWorker() {
  const worker = new Worker(
    'evaluation',
    async (_job) => {
      // TODO: wire to evaluation.processJob() when evaluation module is implemented
    },
    { connection },
  )

  worker.on('error', (err) => console.error('[worker] error:', err))

  process.on('SIGTERM', async () => {
    await worker.close()
    connection.disconnect()
  })

  console.log('[worker] started, waiting for jobs...')
}

startWorker().catch((err) => {
  console.error('[worker] failed to start:', err)
  process.exit(1)
})
