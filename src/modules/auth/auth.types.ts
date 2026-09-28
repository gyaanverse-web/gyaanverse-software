export type Role = 'super_admin' | 'coaching_owner' | 'teacher' | 'student'

/** What the user chose on the signup screen. Routing only — see users.signupIntent. */
export type SignupIntent = 'student' | 'coaching_owner'

export interface User {
  id: string
  name: string
  email: string | null
  emailVerified: boolean
  image: string | null
  phoneNumber: string | null
  phoneNumberVerified: boolean
  isProfileComplete: boolean
  accountRole: Role
  signupIntent: SignupIntent
  createdAt: Date
}
