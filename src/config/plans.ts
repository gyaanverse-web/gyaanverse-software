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
      teachers: 1,
      classes: 2,
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
      teachers: 3,
      classes: 10,
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
      teachers: 10,
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
