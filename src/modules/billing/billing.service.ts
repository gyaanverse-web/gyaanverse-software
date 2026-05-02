import { eq, and, count, gte, lt } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { PLANS, getPlan as getPlanConfig, type PlanName, type PlanFeatures, type PlanLimits } from '../../config/plans.js'
import { Errors } from '../../shared/errors.js'
import { tenants } from '../tenant/tenant.schema.js'
import { memberships } from '../membership/membership.schema.js'
import { classes } from '../class/class.schema.js'
import { exams } from '../exam/exam.schema.js'
import { evaluationJobs } from '../evaluation/evaluation.schema.js'

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

export async function handleSubscriptionWebhook(_payload: unknown, _signature: string) {
  throw new Error('Not implemented')
}
