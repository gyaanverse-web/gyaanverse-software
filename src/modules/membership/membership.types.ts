export interface Membership {
  id: string
  userId: string
  tenantId: string
  role: string
  createdAt: Date
}

export interface JoinCode {
  id: string
  code: string
  classId: string
  tenantId: string
  expiresAt: Date
  maxUses: number
  usedCount: number
  revoked: boolean
}

export interface Enrollment {
  id: string
  studentId: string
  classId: string
  tenantId: string
  joinedAt: Date
}
