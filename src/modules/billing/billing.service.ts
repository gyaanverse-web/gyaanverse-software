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
import { isBillingEnabled } from '../platform/platform.service.js'

async function resolvePlanName(tenantId: string): Promise<PlanName> {
  const [row] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (!row) throw Errors.NOT_FOUND('Tenant')
  return row.plan as PlanName
}

// ─────────────────────────────────────────────────────────────────────────────
// The entitlement resolver.
//
// The ONE question the rest of the codebase is allowed to ask about what a
// coaching may do. Every enforcement point — eleven of them, each a single
// `await` at the top of a service function — reads its answer from here and
// nothing else. That indirection is the whole design: to change what a tenant
// can do you change what this function ANSWERS, never who asks it. No call site
// has an `if (billingEnabled)` in it, and none should ever grow one.
//
// Today it composes two inputs:
//
//   1. The platform switch (`billing_enabled`) — global, operator-owned.
//   2. `tenants.plan` → the static matrix in `config/plans.ts`.
//
// A third is expected and has a deliberate seam left for it: a
// `tenant_feature_overrides` row, layered on top of the plan, for the
// "give this one coaching custom branding" case. When it lands it goes in
// `resolveEntitlements` and nowhere else, and no call site changes then either.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The value every limit reports while billing is off.
 *
 * 99999 rather than `Infinity` for two reasons: `JSON.stringify(Infinity)` is
 * `null`, which would arrive at the browser as a missing limit; and the `pro`
 * plan already uses this number, so the frontend's existing `fmtLimit` renders
 * it as "Unlimited" with no new client-side special case.
 *
 * It is a DISPLAY value only. Enforcement does not compare against it — the
 * assert helpers below return early when billing is off, so a coaching is never
 * one row away from being blocked by a number that was meant to mean "no cap".
 */
const UNMETERED = 99999

export interface Entitlements {
  /** Is the billing product live at all? False during MVP. */
  billingEnabled: boolean
  plan: { name: PlanName; label: string; price_inr: number }
  features: PlanFeatures
  limits: PlanLimits
}

export async function resolveEntitlements(tenantId: string): Promise<Entitlements> {
  const billingEnabled = await isBillingEnabled()

  if (!billingEnabled) {
    // Note what is NOT done here: `tenants.plan` is not read, not reset, and not
    // written. Whatever plan a coaching is on is preserved untouched, so turning
    // billing on later restores the exact matrix it would have had — rather than
    // dropping everyone to `free` and generating a wave of support tickets on
    // launch day.
    return {
      billingEnabled: false,
      plan: { name: 'free', label: 'Unlimited', price_inr: 0 },
      features: {
        analytics: true,
        public_mocks: true,
        custom_branding: true,
        api_access: true,
      },
      limits: {
        students: UNMETERED,
        mocks_per_month: UNMETERED,
        ai_evaluations: UNMETERED,
        teachers: UNMETERED,
        classes: UNMETERED,
      },
    }
  }

  const plan = PLANS[await resolvePlanName(tenantId)]
  return {
    billingEnabled: true,
    plan: { name: plan.name, label: plan.label, price_inr: plan.price_inr },
    features: plan.features,
    limits: plan.limits,
  }
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
      // Counted on SUBMISSION, not creation. A teacher's unsubmitted drafts are
      // scratch work — the wizard now creates a draft row the moment they start,
      // so counting `createdAt` would bill the coaching for every abandoned
      // attempt. The quota is consumed when a paper enters the review pipeline
      // (`submittedAt`, stamped by the draft→under_review transition).
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const [{ value }] = await db
        .select({ value: count() })
        .from(exams)
        .where(and(eq(exams.tenantId, tenantId), gte(exams.submittedAt, monthStart), lt(exams.submittedAt, monthEnd)))
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
  const { features } = await resolveEntitlements(tenantId)
  return features[feature]
}

/**
 * Usage against a limit without deciding anything about it.
 *
 * Callers that must not be blocked by a quota — `ai_evaluations` above all, see
 * the note in `config/plans.ts` — use this to log or flag an overage and carry
 * on, rather than `assertWithinLimit`, which aborts the operation.
 */
export async function getLimitUsage(
  tenantId: string,
  limit: keyof PlanLimits,
): Promise<{ current: number; max: number; within: boolean }> {
  const { limits } = await resolveEntitlements(tenantId)
  const max = limits[limit]
  const current = await countUsage(tenantId, limit)
  return { current, max, within: current < max }
}

export async function isWithinLimit(tenantId: string, limit: keyof PlanLimits): Promise<boolean> {
  const { within } = await getLimitUsage(tenantId, limit)
  return within
}

/**
 * While billing is off these two return without running a single query.
 *
 * That is worth more than the correctness it buys. `assertWithinLimit` is on the
 * hot path of member creation, class creation, invites and paper submission, and
 * `countUsage` is a `COUNT(*)` over a tenant's memberships or exams each time —
 * so short-circuiting removes the entire cost of a feature nobody is using yet,
 * instead of paying for it to compute a number that is then compared against
 * 99999 and discarded.
 */
export async function assertWithinLimit(tenantId: string, limit: keyof PlanLimits): Promise<void> {
  if (!(await isBillingEnabled())) return
  const within = await isWithinLimit(tenantId, limit)
  if (!within) throw Errors.PLAN_LIMIT(limit.replace(/_/g, ' '))
}

export async function assertHasFeature(tenantId: string, feature: keyof PlanFeatures): Promise<void> {
  if (!(await isBillingEnabled())) return
  const has = await hasFeature(tenantId, feature)
  if (!has) throw Errors.FEATURE_GATED(feature.replace(/_/g, ' '))
}

export async function getEntitlements(tenantId: string) {
  return resolveEntitlements(tenantId)
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
  const plan = await resolveEntitlements(tenantId)
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
