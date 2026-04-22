export type NotificationType = 'result_ready' | 'exam_assigned' | 'invite_accepted' | 'payment_confirmed'

export interface Notification {
  id: string
  userId: string
  tenantId: string | null
  type: NotificationType
  title: string
  body: string
  read: boolean
  metadata: Record<string, unknown> | null
  createdAt: Date
}
