import { describe, it, expect } from 'vitest'
import {
  allTenantsChannelPattern,
  notificationChannel,
} from '@modules/notification/notification.redis.js'

// Audit F-5: the live SSE feed used to be `notif:<userId>` for every tenant, so a
// user in two coachings saw coaching B's events in real time on coaching A.
describe('notification pub/sub channels', () => {
  const userId = crypto.randomUUID()
  const tenantA = crypto.randomUUID()
  const tenantB = crypto.randomUUID()

  it('CRITICAL: two tenants of the same user publish on different channels', () => {
    expect(notificationChannel(userId, tenantA)).not.toBe(notificationChannel(userId, tenantB))
  })

  it('a tenant-less notification goes to the global channel, never to a tenant one', () => {
    expect(notificationChannel(userId, null)).toBe(`notif:${userId}:global`)
    expect(notificationChannel(userId, null)).not.toBe(notificationChannel(userId, tenantA))
  })

  it('the app-host pattern covers every tenant channel and the global one for that user only', () => {
    // Redis glob `*` — translate to a regex to check what it would match.
    const pattern = allTenantsChannelPattern(userId)
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace('*', '.*') + '$')

    expect(re.test(notificationChannel(userId, tenantA))).toBe(true)
    expect(re.test(notificationChannel(userId, tenantB))).toBe(true)
    expect(re.test(notificationChannel(userId, null))).toBe(true)
    expect(re.test(notificationChannel(crypto.randomUUID(), tenantA))).toBe(false)
  })
})
