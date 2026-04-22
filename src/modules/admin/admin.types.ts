export interface AuditLog {
  id: string
  actorId: string
  tenantId: string | null
  action: string
  targetId: string | null
  metadata: Record<string, unknown> | null
  createdAt: Date
}
