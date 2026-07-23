import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { tenants } from '@modules/tenant/tenant.schema.js'
import { subscriptions, invoices } from '@modules/billing/billing.schema.js'
import { handleSubscriptionWebhook } from '@modules/billing/billing.service.js'
import { env } from '@config/env.js'
import { seedTenantWithUsers } from '../../helpers/fixtures.js'

function signBody(rawBody: string): string {
  return createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')
}

function makeEvent(opts: {
  event: string
  tenantId: string
  razorpaySubId?: string
  razorpayPlanId?: string
  amount?: number
  currentEnd?: number
}) {
  return {
    event: opts.event,
    payload: {
      subscription: {
        entity: {
          id: opts.razorpaySubId ?? 'sub_test_001',
          plan_id: opts.razorpayPlanId ?? 'rzp_plan_starter',
          current_end: opts.currentEnd,
          notes: { tenant_id: opts.tenantId },
        },
      },
      payment: opts.amount
        ? { entity: { id: 'pay_x', amount: opts.amount } }
        : undefined,
    },
  }
}

describe('handleSubscriptionWebhook — signature verification', () => {
  it('CRITICAL: rejects a body with the wrong signature', async () => {
    const { tenant } = await seedTenantWithUsers()
    const body = JSON.stringify(makeEvent({ event: 'subscription.activated', tenantId: tenant.id }))

    await expect(handleSubscriptionWebhook(body, 'totally-bogus-signature')).rejects.toMatchObject({
      code: 'WEBHOOK_INVALID',
    })

    // No state changes happened
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(t.plan).toBe('free')
  })

  it('CRITICAL: rejects a tampered body (same signature, mutated body)', async () => {
    const { tenant } = await seedTenantWithUsers()
    const real = JSON.stringify(makeEvent({ event: 'subscription.activated', tenantId: tenant.id }))
    const sig = signBody(real)
    const tampered = real.replace('starter', 'pro') // sneaky plan upgrade

    await expect(handleSubscriptionWebhook(tampered, sig)).rejects.toMatchObject({
      code: 'WEBHOOK_INVALID',
    })
  })

  it('rejects when signature lengths differ (timing-safe check holds)', async () => {
    await expect(handleSubscriptionWebhook('{}', 'short')).rejects.toMatchObject({
      code: 'WEBHOOK_INVALID',
    })
  })
})

describe('handleSubscriptionWebhook — events', () => {
  it('subscription.activated upgrades the tenant plan', async () => {
    process.env.RAZORPAY_PLAN_STARTER = 'rzp_plan_starter'

    const { tenant } = await seedTenantWithUsers('free')
    const body = JSON.stringify(makeEvent({
      event: 'subscription.activated',
      tenantId: tenant.id,
      razorpayPlanId: 'rzp_plan_starter',
      currentEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    }))
    const sig = signBody(body)

    await handleSubscriptionWebhook(body, sig)

    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(t.plan).toBe('starter')

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenant.id))
    expect(sub.plan).toBe('starter')
    expect(sub.status).toBe('active')
  })

  it('subscription.charged records an invoice', async () => {
    process.env.RAZORPAY_PLAN_GROWTH = 'rzp_plan_growth'

    const { tenant } = await seedTenantWithUsers('free')
    const body = JSON.stringify(makeEvent({
      event: 'subscription.charged',
      tenantId: tenant.id,
      razorpayPlanId: 'rzp_plan_growth',
      amount: 249900, // ₹2499 in paise
      currentEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    }))
    const sig = signBody(body)

    await handleSubscriptionWebhook(body, sig)

    const invoiceRows = await db.select().from(invoices).where(eq(invoices.tenantId, tenant.id))
    expect(invoiceRows).toHaveLength(1)
    expect(invoiceRows[0].amount).toBe('2499.00')
    expect(invoiceRows[0].paidAt).not.toBeNull()
  })

  it('subscription.cancelled downgrades tenant to free', async () => {
    process.env.RAZORPAY_PLAN_STARTER = 'rzp_plan_starter'

    const { tenant } = await seedTenantWithUsers('starter')
    // Pre-create a subscription row so the cancel path has something to find
    await db.insert(subscriptions).values({
      tenantId: tenant.id,
      plan: 'starter',
      razorpaySubId: 'sub_cancel_test',
      status: 'active',
    })

    const body = JSON.stringify(makeEvent({
      event: 'subscription.cancelled',
      tenantId: tenant.id,
      razorpaySubId: 'sub_cancel_test',
      razorpayPlanId: 'rzp_plan_starter',
    }))
    const sig = signBody(body)

    await handleSubscriptionWebhook(body, sig)

    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(t.plan).toBe('free')
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.razorpaySubId, 'sub_cancel_test'))
    expect(sub.status).toBe('cancelled')
    expect(sub.plan).toBe('free')
  })

  it('payment.failed marks subscription past_due (no plan change)', async () => {
    const { tenant } = await seedTenantWithUsers('growth')
    await db.insert(subscriptions).values({
      tenantId: tenant.id,
      plan: 'growth',
      razorpaySubId: 'sub_failpay',
      status: 'active',
    })

    const body = JSON.stringify(makeEvent({
      event: 'payment.failed',
      tenantId: tenant.id,
      razorpaySubId: 'sub_failpay',
    }))
    const sig = signBody(body)

    await handleSubscriptionWebhook(body, sig)

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.razorpaySubId, 'sub_failpay'))
    expect(sub.status).toBe('past_due')
    // Tenant plan unchanged
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenant.id))
    expect(t.plan).toBe('growth')
  })

  it('ignores unknown event types silently', async () => {
    const { tenant } = await seedTenantWithUsers()
    const body = JSON.stringify({ event: 'order.paid', payload: { tenantId: tenant.id } })
    const sig = signBody(body)
    // Should not throw
    await expect(handleSubscriptionWebhook(body, sig)).resolves.toBeUndefined()
  })
})
