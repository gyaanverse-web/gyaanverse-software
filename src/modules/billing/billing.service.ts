import type { PlanName } from '../../config/plans.js'

export async function getPlan(tenantId: string) {
  throw new Error('Not implemented')
}

export async function hasFeature(tenantId: string, feature: string): Promise<boolean> {
  throw new Error('Not implemented')
}

export async function isWithinLimit(tenantId: string, limit: string): Promise<boolean> {
  throw new Error('Not implemented')
}

export async function getEntitlements(tenantId: string) {
  throw new Error('Not implemented')
}

export async function handleSubscriptionWebhook(payload: unknown, signature: string) {
  throw new Error('Not implemented')
}
