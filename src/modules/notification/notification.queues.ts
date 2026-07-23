import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '@config/env.js'

// Shared connection for all notification queues (not used for pub/sub)
let _connection: IORedis | null = null

function getConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
  }
  return _connection
}

let _emailQueue: Queue | null = null
let _smsQueue: Queue | null = null
let _bulkQueue: Queue | null = null

export function getEmailQueue(): Queue {
  if (!_emailQueue) {
    _emailQueue = new Queue('notification-email', { connection: getConnection() })
  }
  return _emailQueue
}

export function getSmsQueue(): Queue {
  if (!_smsQueue) {
    _smsQueue = new Queue('notification-sms', { connection: getConnection() })
  }
  return _smsQueue
}

export function getBulkQueue(): Queue {
  if (!_bulkQueue) {
    _bulkQueue = new Queue('notification-bulk', { connection: getConnection() })
  }
  return _bulkQueue
}
