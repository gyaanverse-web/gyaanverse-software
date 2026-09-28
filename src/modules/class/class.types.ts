export interface Class {
  id: string
  tenantId: string
  name: string
  grade: string | null
  description: string | null
  autoApprove: boolean
  createdAt: Date
  updatedAt: Date
}

export interface ClassTeacherRef {
  id: string
  name: string
}

export interface ClassMember {
  id: string
  classId: string
  studentId: string
  status: 'pending' | 'approved' | 'rejected'
  enrolledAt: Date
}

export interface ClassJoinCode {
  id: string
  code: string
  classId: string
  tenantId: string
  createdBy: string
  expiresAt: Date | null
  maxUses: number
  usedCount: number
  revoked: boolean
  createdAt: Date
}
