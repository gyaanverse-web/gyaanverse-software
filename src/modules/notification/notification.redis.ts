import IORedis from 'ioredis'
import { env } from '@config/env.js'

// Dedicated pub client — never used for pub/sub subscribe
let _pubClient: IORedis | null = null

function getPubClient(): IORedis {
  if (!_pubClient) {
    _pubClient = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
  }
  return _pubClient
}

export function publishNotification(userId: string, payload: unknown): Promise<number> {
  return getPubClient().publish(`notif:${userId}`, JSON.stringify(payload))
}

// Each SSE handler creates its own subscriber connection (subscribe mode
// blocks the connection from other commands)
export function createSubscriberConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
}
