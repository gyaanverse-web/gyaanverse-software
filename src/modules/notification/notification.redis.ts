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

// Channels are tenant-scoped: `notif:<userId>:<tenantId>`, or
// `notif:<userId>:global` for a notification with no tenant (e.g. a marketplace
// purchase). A tenant subdomain subscribes to its own tenant plus global, so a
// user in two coachings never sees coaching B's events live on coaching A. The
// app host has no tenant to prefer and pattern-subscribes to all of them.
// User ids are UUIDs, so they contain no glob metacharacters.
export function notificationChannel(userId: string, tenantId: string | null): string {
  return `notif:${userId}:${tenantId ?? 'global'}`
}

export function allTenantsChannelPattern(userId: string): string {
  return `notif:${userId}:*`
}

export function publishNotification(userId: string, tenantId: string | null, payload: unknown): Promise<number> {
  return getPubClient().publish(notificationChannel(userId, tenantId), JSON.stringify(payload))
}

// Each SSE handler creates its own subscriber connection (subscribe mode
// blocks the connection from other commands)
export function createSubscriberConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
}
