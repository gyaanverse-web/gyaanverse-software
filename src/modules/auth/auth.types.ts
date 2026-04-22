export type Role = 'super_admin' | 'coaching_owner' | 'teacher' | 'student'

export interface User {
  id: string
  name: string
  email: string | null
  phone: string | null
  phoneVerified: boolean
  role: Role
  tenantId: string | null
  createdAt: Date
}
