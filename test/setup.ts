// ── Test bootstrap ────────────────────────────────────────────────────────
// Runs BEFORE any test file imports from `src/`. Order matters: we must set
// process.env.DATABASE_URL to the test DB before `@config/env.js` is loaded
// (it captures the value at import time).

import * as dotenv from 'dotenv'
import { vi, beforeAll, beforeEach } from 'vitest'

// Force, not default. This machine carries a user-level NODE_ENV=production
// (see scripts/dev-guard.ts for the same problem in the seeding tools), and it
// wins over both dotenv and the `??=` defaults below — so the whole suite used
// to die on import at `Missing required env var: MSG91_AUTH_KEY`, a var that is
// only required in production and that no test touches.
//
// There is no reading of "run the test suite" under which the answer is
// anything but `test`, so this one is set outright rather than defaulted.
process.env.NODE_ENV = 'test'

// Load .env.test if it exists, then fall back to .env so DEV secrets fill the gaps.
dotenv.config({ path: '.env.test' })
dotenv.config()

// Promote DATABASE_URL_TEST → DATABASE_URL so all src/ code that imports `env`
// hits the test database. Refuse to run if the URL doesn't look like a test DB
// — a misconfiguration here would TRUNCATE production data on every test run.
const testUrl = process.env.DATABASE_URL_TEST
if (!testUrl) {
  throw new Error(
    'Refusing to run tests: DATABASE_URL_TEST is not set. ' +
      'Create a separate Postgres database (e.g. `createdb gyaanverse_test`) and set ' +
      'DATABASE_URL_TEST in .env.test or your shell environment.',
  )
}
if (!/test/i.test(testUrl)) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL_TEST=${testUrl} doesn't contain "test". ` +
      'This is a safety guard against truncating a non-test database.',
  )
}
process.env.DATABASE_URL = testUrl

// Supply dummy values for env vars we don't actually use in tests. env.ts uses
// requireEnv on these and would crash on import otherwise.
const envDefaults: Record<string, string> = {
  REDIS_URL: 'redis://localhost:6379/15',
  BETTER_AUTH_SECRET: 'test-secret-not-used',
  BETTER_AUTH_URL: 'http://localhost:8000',
  RESEND_API_KEY: 'test-resend',
  RAZORPAY_KEY_ID: 'test-razorpay',
  RAZORPAY_KEY_SECRET: 'test-razorpay-secret',
  RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret',
  APP_DOMAIN: 'lvh.me',
  CLOUDINARY_CLOUD_NAME: 'test',
  CLOUDINARY_API_KEY: 'test',
  CLOUDINARY_API_SECRET: 'test',
}
for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] ??= value
}

// ── Global mocks ──────────────────────────────────────────────────────────
// dispatch() touches Redis (pub/sub) + enqueues to BullMQ. Tests don't need
// real fan-out — they need to know dispatch was called with the right shape.
// `vi.mock` is hoisted above all imports by Vitest, so this affects every
// `import { dispatch } from '@modules/notification/...'` in the test suite.

vi.mock('@modules/notification/notification.service.js', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  dispatchToUsers: vi.fn().mockResolvedValue(undefined),
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  archiveNotification: vi.fn(),
  getPreferences: vi.fn(),
  upsertPreference: vi.fn(),
  getUserForDelivery: vi.fn(),
  getNotificationById: vi.fn(),
  recordDelivery: vi.fn(),
  getClassMemberIds: vi.fn().mockResolvedValue([]),
}))

vi.mock('@modules/notification/index.js', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  dispatchToUsers: vi.fn().mockResolvedValue(undefined),
}))

// Same dance for the relative-path imports that bypass the alias.
vi.mock('../../notification/notification.service.js', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  dispatchToUsers: vi.fn().mockResolvedValue(undefined),
}))

// Stub the evaluation queue so enqueueing doesn't actually open a Redis socket.
//
// `getJobs` returns [] by default, which for the reconciler means "the queue has
// forgotten everything" — the orphan case. That is the right default for a suite
// with no Redis: tests that care about a live queue entry override this mock
// themselves (see test/modules/evaluation/reconciler.test.ts), and tests that
// don't care are unaffected because nothing else reads it.
vi.mock('bullmq', () => {
  class Queue {
    constructor(public name: string) {}
    add = vi.fn().mockResolvedValue({ id: 'mock-job-id' })
    getJobs = vi.fn().mockResolvedValue([])
    getJobCounts = vi.fn().mockResolvedValue({})
    // Read by `getReconcilerScheduleHealth`. Empty = "nothing is scheduled",
    // which is the state Phase 9 found after a Redis flush; tests that care
    // override it.
    getJobSchedulers = vi.fn().mockResolvedValue([])
  }
  class Worker {
    constructor(public name: string) {}
    on() {}
    close() {}
  }
  class UnrecoverableError extends Error {}
  return { Queue, Worker, UnrecoverableError }
})

// ioredis is constructed in service.ts even if we never use it — stub it out.
vi.mock('ioredis', () => {
  return {
    default: class MockRedis {
      constructor() {}
      on() {}
      disconnect() {}
    },
  }
})

// ── Migrations + per-test cleanup ─────────────────────────────────────────

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'

// Build a dedicated pool for setup so we don't depend on the src/ db pool
// (which would lazily open on first import).
const setupPool = new Pool({ connectionString: testUrl })
const setupDb = drizzle(setupPool)

// Built once after migration: a single TRUNCATE ... CASCADE over every table in
// the public schema. Reflecting the table set (rather than hand-maintaining a
// list) means new tables are isolated automatically and the list can never go
// stale as the schema grows. CASCADE + RESTART IDENTITY make order irrelevant.
// Drizzle's own migration bookkeeping lives in the `drizzle` schema, so the
// public-schema filter leaves it untouched.
let truncateStatement: string | null = null

beforeAll(async () => {
  await migrate(setupDb, { migrationsFolder: './drizzle' })

  const result = await setupDb.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'`,
  )
  const tables = result.rows.map((r) => `"${r.tablename}"`)
  if (tables.length === 0) throw new Error('Test setup: no public tables found — did migrations run?')
  truncateStatement = `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`
})

beforeEach(async () => {
  if (!truncateStatement) throw new Error('Test setup: truncate statement not initialized')
  await setupDb.execute(sql.raw(truncateStatement))
})
