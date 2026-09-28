import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../../config/env.js'

export const FEE_ASSIGNMENT_QUEUE = 'fee-assignment'

let _connection: IORedis | null = null

function getConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
  }
  return _connection
}

let _assignmentQueue: Queue | null = null

/**
 * A 500-student fan-out writing ~3,000 rows inside an HTTP request would hit
 * the proxy timeout and leave a half-assigned class — see LLD §7b. The route
 * enqueues here and returns 202; the worker in worker.ts does the writing.
 */
export function getFeeAssignmentQueue(): Queue {
  if (!_assignmentQueue) {
    _assignmentQueue = new Queue(FEE_ASSIGNMENT_QUEUE, { connection: getConnection() })
  }
  return _assignmentQueue
}

/**
 * The once-daily fee tick (reminders, late fees, reconciler) plus the
 * guardian deliveries it fans out to. One queue for both: they are the same
 * control-plane concern, and it keeps the worker at one fee process.
 */
export const FEE_LIFECYCLE_QUEUE = 'fee-lifecycle'

let _lifecycleQueue: Queue | null = null

export function getFeeLifecycleQueue(): Queue {
  if (!_lifecycleQueue) {
    _lifecycleQueue = new Queue(FEE_LIFECYCLE_QUEUE, { connection: getConnection() })
  }
  return _lifecycleQueue
}

export interface FeeAssignmentJobPayload {
  tenantId: string
  structureId: string
  classId: string
}
