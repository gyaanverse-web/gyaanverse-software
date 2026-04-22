import { pgTable, uuid, varchar, numeric, timestamp, index } from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id).unique(),
  plan: varchar('plan', { length: 50 }).notNull().default('free'),
  razorpaySubId: varchar('razorpay_sub_id', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('subscriptions_tenant_id_idx').on(t.tenantId)])

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  period: varchar('period', { length: 20 }).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('invoices_tenant_id_idx').on(t.tenantId)])
