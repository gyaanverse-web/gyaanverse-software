import type { NotificationType } from './notification.types.js'

export async function notify(
  userId: string,
  type: NotificationType,
  data: { title: string; body: string; metadata?: Record<string, unknown> },
  tenantId?: string,
) {
  throw new Error('Not implemented')
}

export async function getNotifications(userId: string) {
  throw new Error('Not implemented')
}

export async function markRead(notificationId: string, userId: string) {
  throw new Error('Not implemented')
}

export async function streamNotifications(userId: string) {
  throw new Error('Not implemented')
}
