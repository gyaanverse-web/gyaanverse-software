// Platform-wide audit trail. Cross-cutting infrastructure rather than any one
// module's concern, so it sits in `shared/`.
//
// Written only through `logInternalAction` (middleware/internal.ts), and so far
// only by `/internal/*` — the operator surface, where one person acts across
// tenant boundaries on data the affected coaching cannot see them touch. That
// is the case an audit trail is actually for. Tenant-scoped actions are not
// recorded here: exam lifecycle changes have `exam_status_history`, and score
// overrides carry their own `question_results.reviewed_by` / `reviewed_at`.
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
