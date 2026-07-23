import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireTenantRole } from '@middleware/auth.middleware.js'
import { tenantMiddleware } from '@middleware/tenant.middleware.js'
import { Errors } from '@shared/errors.js'
import { createSubscriberConnection } from './notification.redis.js'
import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  archiveNotification,
  getPreferences,
  upsertPreference,
  getUserNotifications,
  getUserUnreadCount,
  userMarkAllRead,
} from './notification.service.js'
import type { NotificationType } from './notification.types.js'

const tenantMember = [authenticate, tenantMiddleware, requireTenantRole('coaching_owner', 'teacher', 'student')]
const authOnly = [authenticate]
const AUTH = [{ bearerAuth: [] }]

export async function notificationRoutes(app: FastifyInstance) {
  // ── User-scoped routes (no tenant — for users on the main app domain) ─────────

  app.get('/notifications', {
    schema: {
      tags: ['Notifications'],
      summary: 'List notifications (user-scoped)',
      description: 'Returns cursor-paginated notifications for the authenticated user across all tenants.',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        },
      },
    },
    preHandler: authOnly,
  }, async (req, reply) => {
    const user = req.user!
    const { cursor } = req.query as { cursor?: string }
    const page = await getUserNotifications(user.id, cursor)
    reply.send(page)
  })

  app.get('/notifications/unread-count', {
    schema: {
      tags: ['Notifications'],
      summary: 'Get unread notification count (user-scoped)',
      security: AUTH,
    },
    preHandler: authOnly,
  }, async (req, reply) => {
    const user = req.user!
    const count = await getUserUnreadCount(user.id)
    reply.send({ count })
  })

  app.get('/notifications/stream', {
    schema: {
      tags: ['Notifications'],
      summary: 'SSE stream for real-time notifications (user-scoped)',
      description: 'Opens a Server-Sent Events stream. The server pushes notification payloads as `data:` events. Keep-alive pings are sent every 30s.',
      security: AUTH,
    },
    preHandler: authOnly,
  }, async (req, reply) => {
    const user = req.user!

    const origin = req.headers.origin ?? '*'
    reply.hijack()

    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    })
    raw.flushHeaders()
    raw.write(':\n\n')

    const subscriber = createSubscriberConnection()
    await subscriber.subscribe(`notif:${user.id}`)

    subscriber.on('message', (_channel, payload) => {
      raw.write(`data: ${payload}\n\n`)
    })

    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(':\n\n')
    }, 30_000)

    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve)
      req.raw.on('error', resolve)
    })

    clearInterval(heartbeat)
    await subscriber.unsubscribe()
    subscriber.disconnect()
    if (!raw.writableEnded) raw.end()
  })

  app.patch('/notifications/:id/read', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark a notification as read (user-scoped)',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: authOnly,
  }, async (req, reply) => {
    const user = req.user!
    const { id } = req.params as { id: string }
    await markRead(id, user.id)
    reply.send({ ok: true })
  })

  app.patch('/notifications/read-all', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark all notifications as read (user-scoped)',
      security: AUTH,
    },
    preHandler: authOnly,
  }, async (req, reply) => {
    const user = req.user!
    await userMarkAllRead(user.id)
    reply.send({ ok: true })
  })

  app.delete('/notifications/:id', {
    schema: {
      tags: ['Notifications'],
      summary: 'Archive (soft-delete) a notification (user-scoped)',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: authOnly,
  }, async (req, reply) => {
    const user = req.user!
    const { id } = req.params as { id: string }
    await archiveNotification(id, user.id)
    reply.send({ ok: true })
  })

  // ── Notification list (cursor-paginated) ─────────────────────────────────

  app.get('/tenant/notifications', {
    schema: {
      tags: ['Notifications'],
      summary: 'List notifications (tenant-scoped)',
      security: AUTH,
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
        },
      },
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const tenant = req.tenant!
    const { cursor } = req.query as { cursor?: string }
    const page = await getNotifications(user.id, tenant.id, cursor)
    reply.send(page)
  })

  // ── Unread count ──────────────────────────────────────────────────────────

  app.get('/tenant/notifications/unread-count', {
    schema: {
      tags: ['Notifications'],
      summary: 'Get unread count (tenant-scoped)',
      security: AUTH,
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const tenant = req.tenant!
    const count = await getUnreadCount(user.id, tenant.id)
    reply.send({ count })
  })

  // ── SSE stream — must be registered before /:id routes ───────────────────
  // One SSE connection per tenant tab; Redis pub/sub fans in-app notifications
  // to any live connection for this user.

  app.get('/tenant/notifications/stream', {
    schema: {
      tags: ['Notifications'],
      summary: 'SSE stream for real-time notifications (tenant-scoped)',
      description: 'Server-Sent Events stream scoped to the resolved tenant. Redis pub/sub delivers new notifications in real time.',
      security: AUTH,
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!

    // Hijack response so Fastify doesn't auto-finalize it.
    // reply.hijack() bypasses @fastify/cors onSend hook, so we must write CORS
    // headers manually — otherwise the browser blocks the cross-origin SSE stream.
    const origin = req.headers.origin ?? '*'
    reply.hijack()

    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    })
    raw.flushHeaders()

    // Initial ping so client confirms the connection is open
    raw.write(':\n\n')

    const subscriber = createSubscriberConnection()
    await subscriber.subscribe(`notif:${user.id}`)

    subscriber.on('message', (_channel, payload) => {
      raw.write(`data: ${payload}\n\n`)
    })

    // Keep-alive ping every 30s to prevent idle timeouts
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(':\n\n')
    }, 30_000)

    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve)
      req.raw.on('error', resolve)
    })

    clearInterval(heartbeat)
    await subscriber.unsubscribe()
    subscriber.disconnect()
    if (!raw.writableEnded) raw.end()
  })

  // ── Mark one as read ──────────────────────────────────────────────────────

  app.patch('/tenant/notifications/:id/read', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark a notification as read (tenant-scoped)',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const { id } = req.params as { id: string }
    await markRead(id, user.id)
    reply.send({ ok: true })
  })

  // ── Mark all as read ──────────────────────────────────────────────────────

  app.patch('/tenant/notifications/read-all', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark all notifications as read (tenant-scoped)',
      security: AUTH,
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const tenant = req.tenant!
    await markAllRead(user.id, tenant.id)
    reply.send({ ok: true })
  })

  // ── Soft delete (archive) ─────────────────────────────────────────────────

  app.delete('/tenant/notifications/:id', {
    schema: {
      tags: ['Notifications'],
      summary: 'Archive a notification (tenant-scoped)',
      security: AUTH,
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const { id } = req.params as { id: string }
    await archiveNotification(id, user.id)
    reply.send({ ok: true })
  })

  // ── Preferences ───────────────────────────────────────────────────────────

  app.get('/tenant/notifications/preferences', {
    schema: {
      tags: ['Notifications'],
      summary: 'Get notification preferences',
      description: 'Returns the user\'s notification channel preferences (email, SMS, in-app) for each notification type.',
      security: AUTH,
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const prefs = await getPreferences(user.id)
    reply.send({ preferences: prefs })
  })

  app.patch('/tenant/notifications/preferences/:type', {
    schema: {
      tags: ['Notifications'],
      summary: 'Update notification preferences for a type',
      security: AUTH,
      params: {
        type: 'object',
        required: ['type'],
        properties: { type: { type: 'string', description: 'Notification type key' } },
      },
      body: {
        type: 'object',
        properties: {
          emailEnabled: { type: 'boolean' },
          smsEnabled: { type: 'boolean' },
          inAppEnabled: { type: 'boolean' },
        },
      },
    },
    preHandler: tenantMember,
  }, async (req, reply) => {
    const user = req.user!
    const { type } = req.params as { type: string }

    const schema = z.object({
      emailEnabled: z.boolean().optional(),
      smsEnabled: z.boolean().optional(),
      inAppEnabled: z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION(parsed.error.errors[0].message)

    await upsertPreference(user.id, type as NotificationType, parsed.data)
    reply.send({ ok: true })
  })
}
