import { createHmac, timingSafeEqual } from 'crypto'
import { eq, and, count, gte, lt, desc } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { PLANS, getPlan as getPlanConfig, type PlanName, type PlanFeatures, type PlanLimits } from '../../config/plans.js'
import { AppError, Errors } from '../../shared/errors.js'
import { env } from '../../config/env.js'
import { tenants } from '../tenant/tenant.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { classes } from '../class/class.schema.js'
import { exams } from '../exam/exam.schema.js'
import { evaluationJobs } from '../evaluation/evaluation.schema.js'
import { subscriptions, invoices } from './billing.schema.js'

async function resolvePlanName(tenantId: string): Promise<PlanName> {
  const [row] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!row) throw Errors.NOT_FOUND('Tenant')
  return row.plan as PlanName
}

async function countUsage(tenantId: string, limit: keyof PlanLimits): Promise<number> {
  switch (limit) {
    case 'students': {
      const [{ value }] = await db
        .select({ value: count() })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'student')))
      return value
    }
    case 'teachers': {
      const [{ value }] = await db
        .select({ value: count() })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'teacher')))
      return value
    }
    case 'classes': {
      const [{ value }] = await db
        .select({ value: count() })
        .from(classes)
        .where(eq(classes.tenantId, tenantId))
      return value
    }
    case 'mocks_per_month': {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const [{ value }] = await db
        .select({ value: count() })
        .from(exams)
        .where(and(eq(exams.tenantId, tenantId), gte(exams.createdAt, monthStart), lt(exams.createdAt, monthEnd)))
      return value
    }
    case 'ai_evaluations': {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const [{ value }] = await db
        .select({ value: count() })
        .from(evaluationJobs)
        .where(and(eq(evaluationJobs.tenantId, tenantId), gte(evaluationJobs.createdAt, monthStart), lt(evaluationJobs.createdAt, monthEnd)))
      return value
    }
  }
}

export async function getPlan(tenantId: string) {
  const name = await resolvePlanName(tenantId)
  return getPlanConfig(name)
}

export async function hasFeature(tenantId: string, feature: keyof PlanFeatures): Promise<boolean> {
  const name = await resolvePlanName(tenantId)
  return PLANS[name].features[feature]
}

export async function isWithinLimit(tenantId: string, limit: keyof PlanLimits): Promise<boolean> {
  const name = await resolvePlanName(tenantId)
  const max = PLANS[name].limits[limit]
  const current = await countUsage(tenantId, limit)
  return current < max
}

export async function assertWithinLimit(tenantId: string, limit: keyof PlanLimits): Promise<void> {
  const within = await isWithinLimit(tenantId, limit)
  if (!within) throw Errors.PLAN_LIMIT(limit.replace(/_/g, ' '))
}

export async function assertHasFeature(tenantId: string, feature: keyof PlanFeatures): Promise<void> {
  const has = await hasFeature(tenantId, feature)
  if (!has) throw Errors.FEATURE_GATED(feature.replace(/_/g, ' '))
}

export async function getEntitlements(tenantId: string) {
  return getPlan(tenantId)
}

export async function getSubscription(tenantId: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1)
  return row ?? null
}

export async function getInvoices(tenantId: string) {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.tenantId, tenantId))
    .orderBy(desc(invoices.createdAt))
}

export async function getUsageSummary(tenantId: string) {
  const planName = await resolvePlanName(tenantId)
  const plan = PLANS[planName]
  const subscription = await getSubscription(tenantId)

  const limits = Object.keys(plan.limits) as (keyof PlanLimits)[]
  const usageEntries = await Promise.all(
    limits.map(async (key) => [key, await countUsage(tenantId, key)] as const),
  )

  const usage = Object.fromEntries(
    usageEntries.map(([key, current]) => [
      key,
      { current, limit: plan.limits[key] },
    ]),
  ) as Record<keyof PlanLimits, { current: number; limit: number }>

  return { plan, subscription, usage }
}

export async function handleSubscriptionWebhook(rawBody: string, signature: string) {
  // Verify Razorpay webhook signature (HMAC-SHA256)
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')

  const sigBuffer = Buffer.from(signature)
  const expBuffer = Buffer.from(expected)
  if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
    throw new AppError('WEBHOOK_INVALID', 'Invalid webhook signature', 400)
  }

  const event = JSON.parse(rawBody) as { event: string; payload: Record<string, unknown> }
  const sub = (event.payload['subscription'] as { entity?: Record<string, unknown> })?.entity
  const payment = (event.payload['payment'] as { entity?: Record<string, unknown> })?.entity

  switch (event.event) {
    case 'subscription.activated':
    case 'subscription.charged': {
      if (!sub) break

      const razorpaySubId = sub['id'] as string
      const planId = sub['plan_id'] as string
      const currentEnd = sub['current_end'] as number | undefined

      // Map Razorpay plan ID → internal plan name via env vars (RAZORPAY_PLAN_<NAME>=<id>)
      const planName = resolvePlanFromRazorpayId(planId)

      await db.transaction(async (tx) => {
        await tx
          .insert(subscriptions)
          .values({
            tenantId: sub['notes'] ? (sub['notes'] as Record<string, string>)['tenant_id'] : '',
            plan: planName,
            razorpaySubId,
            status: 'active',
            currentPeriodEnd: currentEnd ? new Date(currentEnd * 1000) : null,
          })
          .onConflictDoUpdate({
            target: subscriptions.tenantId,
            set: {
              plan: planName,
              razorpaySubId,
              status: 'active',
              currentPeriodEnd: currentEnd ? new Date(currentEnd * 1000) : null,
            },
          })

        const tenantId = (sub['notes'] as Record<string, string>)?.['tenant_id']
        if (tenantId) {
          await tx.update(tenants).set({ plan: planName }).where(eq(tenants.id, tenantId))
        }

        // Record invoice on charge events
        if (event.event === 'subscription.charged' && payment) {
          const amount = ((payment['amount'] as number) / 100).toFixed(2)
          const period = currentEnd
            ? new Date(currentEnd * 1000).toISOString().slice(0, 7)
            : new Date().toISOString().slice(0, 7)

          const tenantIdForInvoice = (sub['notes'] as Record<string, string>)?.['tenant_id']
          if (tenantIdForInvoice) {
            await tx.insert(invoices).values({
              tenantId: tenantIdForInvoice,
              amount,
              period,
              paidAt: new Date(),
            })
          }
        }
      })
      break
    }

    case 'subscription.cancelled':
    case 'subscription.halted': {
      if (!sub) break

      const razorpaySubId = sub['id'] as string
      const [existing] = await db
        .select({ tenantId: subscriptions.tenantId })
        .from(subscriptions)
        .where(eq(subscriptions.razorpaySubId, razorpaySubId))
        .limit(1)

      if (existing) {
        await db.transaction(async (tx) => {
          await tx
            .update(subscriptions)
            .set({ status: 'cancelled', plan: 'free' })
            .where(eq(subscriptions.razorpaySubId, razorpaySubId))
          await tx
            .update(tenants)
            .set({ plan: 'free' })
            .where(eq(tenants.id, existing.tenantId))
        })
      }
      break
    }

    case 'payment.failed': {
      if (!sub) break
      const razorpaySubId = sub['id'] as string
      await db
        .update(subscriptions)
        .set({ status: 'past_due' })
        .where(eq(subscriptions.razorpaySubId, razorpaySubId))
      break
    }
  }
}

function resolvePlanFromRazorpayId(razorpayPlanId: string): PlanName {
  const map: Record<string, PlanName> = {
    [process.env['RAZORPAY_PLAN_STARTER'] ?? '']: 'starter',
    [process.env['RAZORPAY_PLAN_GROWTH'] ?? '']: 'growth',
    [process.env['RAZORPAY_PLAN_PRO'] ?? '']: 'pro',
  }
  return map[razorpayPlanId] ?? 'free'
}
