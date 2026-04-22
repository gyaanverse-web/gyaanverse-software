import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../../config/env.js'

// Lazily created — only instantiated when first used
let _queue: Queue | null = null

function getQueue(): Queue {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
    _queue = new Queue('evaluation', { connection })
  }
  return _queue
}

export async function enqueueEvaluation(sessionId: string): Promise<void> {
  await getQueue().add(
    'evaluate-session',
    { sessionId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  )
}

export async function getJobStatus(_sessionId: string) {
  throw new Error('Not implemented')
}
