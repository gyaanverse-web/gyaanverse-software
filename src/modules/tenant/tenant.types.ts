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

export interface Member {
  userId: string
  role: string
  joinedAt: Date
  name: string
  phone: string | null
  email: string | null
}
