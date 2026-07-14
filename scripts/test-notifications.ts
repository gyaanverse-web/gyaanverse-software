/**
 * Quick smoke-test for the notification system.
 * Run from the backend/ directory:
 *   npx tsx scripts/test-notifications.ts
 *
 * Fill in USER_ID and TENANT_ID from your local DB before running.
 */

import '../src/config/env.js'  // load .env
import { dispatch } from '../src/modules/notification/index.js'
import { db } from '../src/shared/db.js'
import { users } from '../src/modules/auth/auth.schema.js'
import { tenants } from '../src/modules/tenant/tenant.schema.js'

// ── 1. Resolve a real user + tenant from the DB ───────────────────────────────
// (or paste IDs directly if you already know them)

// const [firstUser] = await db.select({ id: users.id, email: users.email }).from(users).limit(1)
// const [firstTenant] = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).limit(1)


const [firstUser] = [{
  id: "6deb734a-fcd4-4b73-8812-b94eb8de51d8",
  email: "787alisniazi787@gmail.com"
}];

const [firstTenant] = [{
  id: "15ce375a-ae77-4fa8-8987-be70e8f5aaf3",
  slug: "niazi"
}];



if (!firstUser || !firstTenant) {
  console.error('No users or tenants in the DB. Sign up via the API first.')
  process.exit(1)
}

console.log(`Dispatching to user ${firstUser.email} in tenant ${firstTenant.slug}`)

// ── 2. Fire an in-app + email notification ────────────────────────────────────

await dispatch({
  type: 'exam_assigned',
  recipients: { userIds: [firstUser.id] },
  tenantId: firstTenant.id,
  data: {
    title: 'New Exam: Physics Mock Test',
    body: 'A new exam has been assigned to your class.',
    link: '/exams/test-exam-id',
    metadata: {
      recipientName: 'Test Student',
      examTitle: 'Physics Mock Test',
      className: 'Class 12A',
    },
  },
})

console.log('✓ dispatch() called')
console.log('  → in-app row inserted into notifications table')
console.log('  → email job enqueued in notification-email BullMQ queue')
console.log('  → check Mailpit at http://localhost:54324 for the email (RESEND_API_KEY is ignored in development)')
console.log('  → SSE clients on notif:' + firstUser.id + ' will receive the payload')

// ── 3. Fire a result_ready notification (triggers SMS too if priority=urgent) ─

await dispatch({
  type: 'result_ready',
  recipients: { userIds: [firstUser.id] },
  tenantId: firstTenant.id,
  data: {
    title: 'Your result is ready',
    body: 'Your Physics Mock Test result has been evaluated.',
    link: '/results/test-session-id',
    metadata: {
      recipientName: 'Test Student',
      examTitle: 'Physics Mock Test',
    },
  },
})

console.log('✓ result_ready dispatched')

// ── 4. Fire a payment_failed notification (triggers email + SMS) ──────────────

await dispatch({
  type: 'payment_failed',
  recipients: { userIds: [firstUser.id] },
  tenantId: firstTenant.id,
  data: {
    title: 'Action required: payment failed',
    body: 'We could not process your payment. Please update your billing details.',
    link: '/billing',
    metadata: { recipientName: 'Test Owner' },
  },
})

console.log('✓ payment_failed dispatched (email + SMS channels)')
console.log('  → SMS: check worker console output (MSG91_AUTH_KEY is empty, so it logs to console)')

process.exit(0)
