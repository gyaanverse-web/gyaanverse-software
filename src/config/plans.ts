export type PlanName = 'free' | 'starter' | 'growth' | 'pro'

export interface PlanFeatures {
  analytics: boolean
  public_mocks: boolean
  custom_branding: boolean
  api_access: boolean
}

export interface PlanLimits {
  students: number
  mocks_per_month: number
  /**
   * REPORT-ONLY. Never blocks. (Decision, 2026-08-12.)
   *
   * Every other limit here gates an action a human is taking and can react to:
   * a teacher hits the mock cap while creating a paper and gets told so. An
   * `ai_evaluations` overage would instead be discovered by `enqueueEvaluation`
   * *after* a student has already submitted, and refusing there means the paper
   * is never graded, the session never settles, and the exam never leaves
   * `under_evaluation` — the whole cohort's results held hostage by a billing
   * counter. That is strictly worse than grading over the cap.
   *
   * So `enqueueEvaluation` reads usage via `getLimitUsage` and logs the overage
   * rather than calling `assertWithinLimit`. The number below stays meaningful
   * as a plan-page figure and in `getUsageSummary`; enforcement, when it comes,
   * belongs at the billing layer (overage invoice, upgrade prompt), not in the
   * grading path.
   */
  ai_evaluations: number
  teachers: number
  classes: number
}

export interface Plan {
  name: PlanName
  label: string
  price_inr: number
  features: PlanFeatures
  limits: PlanLimits
}

export const PLANS: Record<PlanName, Plan> = {
  free: {
    name: 'free',
    label: 'Free',
    price_inr: 0,
    features: {
      analytics: false,
      public_mocks: false,
      custom_branding: false,
      api_access: false,
    },
    limits: {
      students: 30,
      mocks_per_month: 3,
      ai_evaluations: 10,
      teachers: 5,
      classes: 5,
    },
  },
  starter: {
    name: 'starter',
    label: 'Starter',
    price_inr: 999,
    features: {
      analytics: false,
      public_mocks: true,
      custom_branding: false,
      api_access: false,
    },
    limits: {
      students: 100,
      mocks_per_month: 15,
      ai_evaluations: 100,
      teachers: 10,
      classes: 20,
    },
  },
  growth: {
    name: 'growth',
    label: 'Growth',
    price_inr: 2499,
    features: {
      analytics: true,
      public_mocks: true,
      custom_branding: false,
      api_access: false,
    },
    limits: {
      students: 500,
      mocks_per_month: 50,
      ai_evaluations: 500,
      teachers: 20,
      classes: 50,
    },
  },
  pro: {
    name: 'pro',
    label: 'Pro',
    price_inr: 5999,
    features: {
      analytics: true,
      public_mocks: true,
      custom_branding: true,
      api_access: true,
    },
    limits: {
      students: 99999,
      mocks_per_month: 99999,
      ai_evaluations: 99999,
      teachers: 99999,
      classes: 99999,
    },
  },
}

export function getPlan(name: PlanName): Plan {
  return PLANS[name]
}
