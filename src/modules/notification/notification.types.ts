export type NotificationType =
  | 'exam_assigned'
  | 'exam_starting_soon'
  | 'result_ready'
  // Approval-lifecycle (PRD v1)
  | 'exam_submitted'          // → admin/owner: teacher submitted for review
  | 'exam_scheduled'          // → teacher: approved & scheduled
  | 'exam_changes_requested'  // → teacher: bounced back with remarks
  | 'exam_rejected'           // → teacher: rejected with remarks
  | 'results_published'       // → students: teacher published results
  | 'class_update'
  | 'invite_received'
  | 'invite_accepted'
  | 'payment_confirmed'
  | 'payment_failed'
  | 'plan_limit_warning'

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent'
export type DeliveryChannel = 'email' | 'sms'
export type DeliveryStatus = 'pending' | 'sent' | 'failed'

export interface Notification {
  id: string
  userId: string
  tenantId: string | null
  type: NotificationType
  title: string
  body: string
  link: string | null
  priority: NotificationPriority
  readAt: Date | null
  archivedAt: Date | null
  metadata: Record<string, unknown> | null
  createdAt: Date
}

export interface NotificationPage {
  items: Notification[]
  nextCursor: string | null
}

// DispatchInput: caller provides recipients as either userIds or a classId for fan-out
export interface DispatchInput {
  type: NotificationType
  recipients: { userIds: string[] } | { classId: string }
  tenantId: string | null
  data: {
    title: string
    body: string
    link?: string
    metadata?: Record<string, unknown>
  }
}

export interface EmailDeliveryPayload {
  notificationId: string
  userId: string
  userEmail: string
  type: NotificationType
  title: string
  body: string
  link: string | null
}

export interface SmsDeliveryPayload {
  notificationId: string
  userId: string
  phoneNumber: string
  type: NotificationType
  body: string
}

export interface BulkNotifyPayload {
  classId: string
  tenantId: string | null
  type: NotificationType
  data: {
    title: string
    body: string
    link?: string
    metadata?: Record<string, unknown>
  }
}

export interface NotificationConfig {
  priority: NotificationPriority
  email: boolean
  sms: boolean
}

// Drives which channels fire per notification type — callers never decide this
export const NOTIFICATION_CONFIG: Record<NotificationType, NotificationConfig> = {
  exam_assigned:      { priority: 'high',   email: true,  sms: false },
  exam_starting_soon: { priority: 'urgent', email: false, sms: true  },
  result_ready:       { priority: 'high',   email: true,  sms: false },
  exam_submitted:         { priority: 'high',   email: true,  sms: false },
  exam_scheduled:         { priority: 'high',   email: true,  sms: false },
  exam_changes_requested: { priority: 'high',   email: true,  sms: false },
  exam_rejected:          { priority: 'high',   email: true,  sms: false },
  results_published:      { priority: 'high',   email: true,  sms: false },
  class_update:       { priority: 'normal', email: false, sms: false },
  // email:false — invite.service sends its own dedicated invite email (the one
  // carrying the accept link). Enabling the generic channel here delivered a
  // second, redundant email to the invitee.
  invite_received:    { priority: 'high',   email: false, sms: false },
  invite_accepted:    { priority: 'normal', email: true,  sms: false },
  payment_confirmed:  { priority: 'normal', email: true,  sms: false },
  payment_failed:     { priority: 'urgent', email: true,  sms: true  },
  plan_limit_warning: { priority: 'high',   email: true,  sms: false },
}
