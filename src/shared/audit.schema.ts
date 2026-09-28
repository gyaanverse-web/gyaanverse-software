// Platform-wide audit trail. Cross-cutting infrastructure rather than any one
// module's concern, so it sits in `shared/`.
//
// Two writers:
//   1. `logInternalAction` (middleware/internal.ts), for `/internal/*` — the
//      operator surface, where one person acts across tenant boundaries on data
//      the affected coaching cannot see them touch.
//   2. `fee.ledger.ts`, for every Layer-3 fee write (payments, bounces,
//      reversals, adjustments). Written INSIDE the ledger transaction, so a
//      money entry and its audit row commit or fail together. Automated writes
//      (late fees levied by the tick) use the nil-UUID SYSTEM_ACTOR.
//
// Other tenant-scoped actions are not recorded here: exam lifecycle changes
// have `exam_status_history`, and score overrides carry their own
// `question_results.reviewed_by` / `reviewed_at`.
//
// `tenantId` is nullable on purpose — a platform-level action has no tenant, and
// inventing one to fill the column would make the trail lie.
import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core'

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').notNull(),
  tenantId: uuid('tenant_id'),
  action: varchar('action', { length: 100 }).notNull(),
  targetId: uuid('target_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_logs_tenant_id_idx').on(t.tenantId)])
