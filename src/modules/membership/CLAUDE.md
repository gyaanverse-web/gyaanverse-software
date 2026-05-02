# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Membership Module — Scope

Owns two distinct join-code systems and enrollment tracking. The **coaching join code** flow (fully implemented) lets students join a coaching institute via a shareable code. The **class join code** + **enrollment** flow (`joinCodes`, `enrollments` tables) is stubbed — functions exist but all throw `Not implemented`.

## Files

| File | Purpose |
|------|---------|
| `membership.schema.ts` | `memberships`, `coachingJoinCodes`, `joinCodes`, `enrollments` tables |
| `membership.types.ts` | `Membership`, `CoachingJoinCode`, `JoinCode`, `Enrollment` interfaces |
| `membership.service.ts` | Business logic — coaching join codes (live) + class enrollment (stubs) |
| `membership.routes.ts` | Route handlers for join code management and student join flow |

## Routes

### Tenant-scoped (owner manages codes)

| Method | Path | Middleware chain |
|--------|------|-----------------|
| `POST` | `/tenant/join-code` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` |
| `GET` | `/tenant/join-code` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` |
| `DELETE` | `/tenant/join-code/:id` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` |

### Global (student uses codes)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/join/:code` | — | Public preview — shows coaching name/logo only |
| `POST` | `/join/:code` | `authenticate` | Joins the coaching as student |

Codes are normalised to **uppercase** before any lookup (`code.toUpperCase()` in routes). Always store and query in uppercase.

## Join Code Lifecycle

```
generate → [share with students] → preview → use
                                            ↓
                                        revoke (owner)
```

**Validity checks** (applied in both `previewCoachingJoinCode` and `useCoachingJoinCode`):
1. Code must exist
2. `revoked !== true`
3. `expiresAt` is null or still in the future
4. `usedCount < maxUses`

**`useCoachingJoinCode` transaction** (atomic):
1. Insert `memberships` row (role = `student`)
2. Set `users.tenantId` to the resolved tenant
3. Increment `coachingJoinCodes.usedCount` using `sql\`usedCount + 1\`` (avoids read-modify-write race)

`assertWithinLimit(tenantId, 'students')` is called **before** the transaction. If the coaching is at capacity, the join is rejected before any writes happen.

## Schema Notes

**`memberships`** has a `uniqueIndex` on `(userId, tenantId)` — a user can only have one membership per tenant. Duplicate-join attempts are caught at the application layer first (`ALREADY_MEMBER` error) before the DB constraint would fire.

**Two separate join-code tables exist**:
- `coachingJoinCodes` — coaching-level, students join the institute
- `joinCodes` — class-level, students enroll in a specific class (not yet implemented)

Do not confuse them. The `joinCodes` table and all associated service functions (`enrollStudent`, `generateJoinCode`, `revokeJoinCode`, `isEnrolled`, `getEnrollments`) are stubs. Implement them when building the class enrollment feature.

**Code character set**: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — deliberately excludes `0`, `O`, `1`, `I` to prevent misreading. Code generation retries up to 5 times on collision before throwing `INTERNAL_ERROR`.

## `memberships` Table — Cross-Module Usage

The `memberships` table is imported and queried directly by several other modules:
- `auth.middleware.ts` (`requireTenantRole`) — reads membership role for authorization
- `tenant.service.ts` (`registerCoaching`, `addTeacher`, `joinAsStudent`, `removeMember`) — inserts and deletes membership rows
- `billing.service.ts` (`countUsage`) — counts `student` and `teacher` rows for plan limit enforcement

When altering the `memberships` schema, check all of the above for impact.
