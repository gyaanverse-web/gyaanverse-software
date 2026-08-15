import { pgTable, uuid, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core'

/**
 * Platform-wide switches, owned by the operator panel.
 *
 * Deliberately a key/value table rather than a one-row settings table with a
 * column per switch: every new switch would otherwise be a migration, and the
 * whole point of these is that they turn a product decision into a click. The
 * shape of each value is defined in `platform.service.ts`, which is the only
 * module allowed to read this table.
 *
 * NOT for per-tenant entitlements. Those belong on the tenant (today: the
 * `plan` column; later: a `tenant_feature_overrides` table). A row here means
 * "true for the entire platform", and the resolver in `billing.service.ts`
 * layers the two in that order.
 */
export const platformSettings = pgTable('platform_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** The `super_admin` who last flipped it. Nullable — a seeded default has no author. */
  updatedBy: uuid('updated_by'),
})
