import { eq, and, or, isNull, desc, sql, inArray } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { notifications, notificationDeliveries, notificationPreferences } from './notification.schema.js'
import { users } from '@modules/auth/auth.schema.js'
import { classMembers } from '@modules/class/class.schema.js'
import {
  NOTIFICATION_CONFIG,
  type DispatchInput,
  type Notification,
  type NotificationPage,
  type NotificationType,
  type BulkNotifyPayload,
} from './notification.types.js'
import { getEmailQueue, getSmsQueue, getBulkQueue } from './notification.queues.js'
import { publishNotification } from './notification.redis.js'
import { Errors } from '@shared/errors.js'

const PAGE_SIZE = 20

// ── Core dispatch ─────────────────────────────────────────────────────────────

export async function dispatch(input: DispatchInput): Promise<void> {
  if ('classId' in input.recipients) {
    await getBulkQueue().add('bulk-notify', {
      classId: input.recipients.classId,
      tenantId: input.tenantId,
      type: input.type,
      data: input.data,
    } satisfies BulkNotifyPayload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    })
    return
  }

  const { userIds } = input.recipients
  if (userIds.length === 0) return
  await dispatchToUsers(userIds, input)
}

// Used by both direct dispatch and the bulk worker after expanding classId
export async function dispatchToUsers(
  userIds: string[],
  input: Omit<DispatchInput, 'recipients'>,
): Promise<void> {
  const config = NOTIFICATION_CONFIG[input.type]

  // 1. Bulk insert in-app notification rows
  const rows = userIds.map((userId) => ({
    id: crypto.randomUUID(),
    userId,
    tenantId: input.tenantId ?? null,
    type: input.type,
    title: input.data.title,
    body: input.data.body,
    link: input.data.link ?? null,
    priority: config.priority,
    metadata: (input.data.metadata ?? null) as Record<string, unknown> | null,
  }))

  await db.insert(notifications).values(rows)

  // 2. Publish each row to Redis so live SSE clients receive it immediately.
  //    In-app is never suppressed — the bell always shows everything. Only the
  //    outbound email/SMS channels honour per-user preferences (step 3).
  for (const row of rows) {
    await publishNotification(row.userId, { ...row, readAt: null, archivedAt: null, createdAt: new Date() })
  }

  // 3. Enqueue email/SMS delivery jobs, respecting per-user preferences.
  //    A user with no preference row for this type defaults to "on" (all channels
  //    that the type's config enables will fire).
  if (config.email || config.sms) {
    const prefs = await getChannelPreferences(userIds, input.type)
    for (const row of rows) {
      const pref = prefs.get(row.userId)
      if (config.email && (pref?.emailEnabled ?? true)) {
        await getEmailQueue().add('send-email', {
          notificationId: row.id,
          userId: row.userId,
          type: input.type,
        }, {
          attempts: 4,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        })
      }
      if (config.sms && (pref?.smsEnabled ?? true)) {
        await getSmsQueue().add('send-sms', {
          notificationId: row.id,
          userId: row.userId,
          type: input.type,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        })
      }
    }
  }
}

// Batch-fetch email/SMS preferences for a set of users for one notification type.
// Missing rows mean "no preference set" → caller treats the channel as enabled.
async function getChannelPreferences(
  userIds: string[],
  type: NotificationType,
): Promise<Map<string, { emailEnabled: boolean; smsEnabled: boolean }>> {
  const map = new Map<string, { emailEnabled: boolean; smsEnabled: boolean }>()
  if (userIds.length === 0) return map

  const rows = await db
    .select({
      userId: notificationPreferences.userId,
      emailEnabled: notificationPreferences.emailEnabled,
      smsEnabled: notificationPreferences.smsEnabled,
    })
    .from(notificationPreferences)
    .where(
      and(
        inArray(notificationPreferences.userId, userIds),
        eq(notificationPreferences.type, type),
      ),
    )

  for (const r of rows) {
    map.set(r.userId, { emailEnabled: r.emailEnabled, smsEnabled: r.smsEnabled })
  }
  return map
}

// Bulk worker calls this to expand classId → student userIds
export async function getClassMemberIds(classId: string): Promise<string[]> {
  const rows = await db
    .select({ studentId: classMembers.studentId })
    .from(classMembers)
    .where(and(eq(classMembers.classId, classId), eq(classMembers.status, 'approved')))

  return rows.map((r) => r.studentId)
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getNotifications(
  userId: string,
  tenantId: string,
  cursor?: string,
): Promise<NotificationPage> {
  const conditions = [
    eq(notifications.userId, userId),
    or(eq(notifications.tenantId, tenantId), isNull(notifications.tenantId)),
    isNull(notifications.archivedAt),
  ]

  if (cursor) {
    // cursor format: ISO8601_uuid  e.g. "2025-05-16T10:00:00.000Z_uuid"
    const [tsStr, id] = cursor.split('_')
    const ts = new Date(tsStr)
    if (!isNaN(ts.getTime()) && id) {
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${ts.toISOString()}, ${id})`,
      )
    }
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(PAGE_SIZE + 1)

  const hasMore = rows.length > PAGE_SIZE
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows
  const last = items.at(-1)
  const nextCursor = hasMore && last
    ? `${last.createdAt.toISOString()}_${last.id}`
    : null

  return { items: items as Notification[], nextCursor }
}

export async function getUnreadCount(userId: string, tenantId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        or(eq(notifications.tenantId, tenantId), isNull(notifications.tenantId)),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
      ),
    )

  return result[0]?.count ?? 0
}

export async function markRead(notificationId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1)

  if (!row) throw Errors.NOT_FOUND('Notification')
  if (row.userId !== userId) throw Errors.FORBIDDEN()

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), isNull(notifications.readAt)))
}

export async function markAllRead(userId: string, tenantId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.tenantId, tenantId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
      ),
    )
}

export async function archiveNotification(notificationId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1)

  if (!row) throw Errors.NOT_FOUND('Notification')
  if (row.userId !== userId) throw Errors.FORBIDDEN()

  await db
    .update(notifications)
    .set({ archivedAt: new Date() })
    .where(eq(notifications.id, notificationId))
}

// ── Delivery helpers (called from workers) ────────────────────────────────────

export async function getUserForDelivery(userId: string) {
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  return user ?? null
}

export async function getNotificationById(notificationId: string) {
  const [row] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .limit(1)

  return (row ?? null) as Notification | null
}

export async function recordDelivery(params: {
  notificationId: string
  userId: string
  channel: 'email' | 'sms'
  status: 'sent' | 'failed'
  attempts: number
  lastError?: string
}): Promise<void> {
  await db.insert(notificationDeliveries).values({
    notificationId: params.notificationId,
    userId: params.userId,
    channel: params.channel,
    status: params.status,
    attempts: params.attempts,
    lastError: params.lastError ?? null,
    sentAt: params.status === 'sent' ? new Date() : null,
  })
}

// ── User-only queries (no tenant filter — for main app domain users) ──────────

export async function getUserNotifications(userId: string, cursor?: string): Promise<NotificationPage> {
  const conditions = [
    eq(notifications.userId, userId),
    isNull(notifications.archivedAt),
  ]

  if (cursor) {
    const [tsStr, id] = cursor.split('_')
    const ts = new Date(tsStr)
    if (!isNaN(ts.getTime()) && id) {
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${ts.toISOString()}, ${id})`,
      )
    }
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(PAGE_SIZE + 1)

  const hasMore = rows.length > PAGE_SIZE
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows
  const last = items.at(-1)
  const nextCursor = hasMore && last
    ? `${last.createdAt.toISOString()}_${last.id}`
    : null

  return { items: items as Notification[], nextCursor }
}

export async function getUserUnreadCount(userId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
      ),
    )

  return result[0]?.count ?? 0
}

export async function userMarkAllRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
      ),
    )
}

// ── User preferences ──────────────────────────────────────────────────────────

export async function getPreferences(userId: string) {
  return db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
}

export async function upsertPreference(
  userId: string,
  type: NotificationType,
  prefs: { emailEnabled?: boolean; smsEnabled?: boolean; inAppEnabled?: boolean },
): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({ userId, type, ...prefs })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.type],
      set: prefs,
    })
}
