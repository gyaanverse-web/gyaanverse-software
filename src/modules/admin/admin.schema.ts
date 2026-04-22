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
