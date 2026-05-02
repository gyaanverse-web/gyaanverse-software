export type Role = 'super_admin' | 'coaching_owner' | 'teacher' | 'student'

export interface User {
  id: string
  name: string
  email: string | null
  emailVerified: boolean
  image: string | null
  phoneNumber: string | null
  phoneNumberVerified: boolean
  isProfileComplete: boolean
  role: Role
  tenantId: string | null
  createdAt: Date
}
