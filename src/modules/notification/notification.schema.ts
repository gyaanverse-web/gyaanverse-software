import {
  pgTable, uuid, varchar, text, timestamp, jsonb, integer, boolean, index, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { tenants } from '../tenant/tenant.schema.js'
import { users } from '../auth/auth.schema.js'

export const notifications = pgTable('notifications', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId:   uuid('tenant_id').references(() => tenants.id),
  type:       varchar('type', { length: 50 }).notNull(),
  title:      varchar('title', { length: 255 }).notNull(),
  body:       text('body').notNull(),
  link:       varchar('link', { length: 500 }),
  priority:   varchar('priority', { length: 10 }).notNull().default('normal'),
  readAt:     timestamp('read_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  metadata:   jsonb('metadata'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notif_user_created_idx').on(t.userId, t.createdAt),
  index('notif_user_unread_idx').on(t.userId, t.readAt),
  index('notif_tenant_idx').on(t.tenantId),
])

// Tracks email + SMS delivery attempts per notification per user
export const notificationDeliveries = pgTable('notification_deliveries', {
  id:             uuid('id').primaryKey().defaultRandom(),
  notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'set null' }),
  userId:         uuid('user_id').notNull().references(() => users.id),
  channel:        varchar('channel', { length: 10 }).notNull(),   // email | sms
  status:         varchar('status', { length: 20 }).notNull().default('pending'), // pending | sent | failed
  attempts:       integer('attempts').notNull().default(0),
  lastError:      text('last_error'),
  sentAt:         timestamp('sent_at', { withTimezone: true }),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notif_delivery_user_idx').on(t.userId),
  index('notif_delivery_notif_idx').on(t.notificationId),
])

// Per-user preferences: which channels are active for each notification type
export const notificationPreferences = pgTable('notification_preferences', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type:         varchar('type', { length: 50 }).notNull(),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  smsEnabled:   boolean('sms_enabled').notNull().default(false),
  inAppEnabled: boolean('in_app_enabled').notNull().default(true),
}, (t) => [
  uniqueIndex('notif_pref_user_type_uniq').on(t.userId, t.type),
])
