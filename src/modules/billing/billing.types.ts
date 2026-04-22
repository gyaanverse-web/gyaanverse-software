import type { PlanName } from '../../config/plans.js'

export interface Subscription {
  id: string
  tenantId: string
  plan: PlanName
  razorpaySubId: string | null
  status: 'active' | 'past_due' | 'cancelled'
  currentPeriodEnd: Date | null
  trialEndsAt: Date | null
}
