# Class Module

Manages classes within a coaching institute. A class belongs to one tenant and one teacher. Students enroll via class join codes and are tracked in `classMembers`.

## Schema

- `classes` — `autoApprove boolean default true` controls whether join-code enrollments need teacher approval
- `classMembers` — `status: pending | approved | rejected`; unique on `(classId, studentId)`
- `joinCodes` — class-level join codes; `expiresAt` nullable; tracks `usedCount` vs `maxUses`

## Enrollment Flow

```
Teacher generates join code → Student uses code
  → autoApprove true  → classMembers row inserted (status: approved)
  → autoApprove false → classMembers row inserted (status: pending)
                              ↓
                    Teacher approves / rejects via PATCH
```

Student must already be a `memberships` row in that tenant before using a class join code — this is enforced in `useClassJoinCode` before any write.

Rejected students can re-request — the old rejected row is deleted before inserting a new pending one.

## Key Service Rules

- `getClassesForStudent` filters `classMembers.status = 'approved'` — pending students cannot see the class yet
- `deleteClass` deletes `classMembers` and `joinCodes` rows first (no cascade on FKs)
- `coaching_owner` can manage any class; `teacher` can only manage classes where `teacherId = user.id`
- `createClass` enforces plan limit via `assertWithinLimit(tenantId, 'classes')`

## Routes

Tenant-scoped routes require `authenticate → tenantMiddleware → requireTenantRole`. Join code student routes only require `authenticate` (code carries tenant context).

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `POST` | `/tenant/classes` | owner, teacher | `autoApprove` defaults to true |
| `GET` | `/tenant/classes` | owner, teacher, student | role-aware list |
| `GET/PATCH/DELETE` | `/tenant/classes/:id` | owner, teacher | ownership check in service |
| `POST/GET/DELETE` | `/tenant/classes/:id/join-codes` | owner, teacher | generate / list / revoke |
| `GET` | `/tenant/classes/:id/students?status=` | owner, teacher | filter by pending/approved/rejected |
| `PATCH` | `/tenant/classes/:id/students/:studentId` | owner, teacher | `{ action: "approve" \| "reject" }` |
| `DELETE` | `/tenant/classes/:id/students/:studentId` | owner, teacher | remove any status |
| `GET` | `/tenant/classes/join/:code` | authenticate | preview before joining |
| `POST` | `/tenant/classes/join/:code` | authenticate | enroll student |
