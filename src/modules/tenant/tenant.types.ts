export interface Tenant {
  id: string
  slug: string
  name: string
  logoUrl: string | null
  ownerId: string
  plan: string
  status: 'active' | 'suspended'
  createdAt: Date
}

export interface TenantSettings {
  tenantId: string
  allowPublicMocks: boolean
  customDomain: string | null
}
