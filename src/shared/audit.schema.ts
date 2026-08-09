// Platform-wide audit trail. Cross-cutting infrastructure rather than any one
// module's concern, so it sits in `shared/`. NOTE: the table exists (migration
// 0000) but nothing writes to it yet — exam lifecycle changes are audited
// separately via `exam_status_history`.
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
