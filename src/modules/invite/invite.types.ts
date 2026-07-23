export interface Invite {
  id: string
  tenantId: string
  invitedBy: string
  contact: string
  contactType: 'email' | 'phone'
  role: string
  token: string
  expiresAt: Date
  status: 'pending' | 'accepted' | 'revoked'
  createdAt: Date
}
