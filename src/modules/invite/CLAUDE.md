# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Invite Module — Scope

Handles teacher invitations sent by coaching owners via email or phone. Produces a one-time token link that a teacher clicks to join the coaching. Currently the only role that can be invited is `teacher` — `role` is hardcoded to `'teacher'` in `createInvite`.

## Files

| File | Purpose |
|------|---------|
| `invite.schema.ts` | `invites` table |
| `invite.types.ts` | `Invite` interface |
| `invite.service.ts` | Business logic — create, list, revoke, accept |
| `invite.routes.ts` | Route handlers |

## Routes

| Method | Path | Middleware chain | Notes |
|--------|------|-----------------|-------|
| `POST` | `/tenant/invites` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` | Sends email or SMS |
| `GET` | `/tenant/invites` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` | Filterable by `?status=` |
| `DELETE` | `/tenant/invites/:id` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` | Pending only |
| `POST` | `/invites/accept` | `authenticate` | No tenant middleware — tenant resolved from token |

`POST /invites/accept` intentionally has no `tenantMiddleware` — the invite token carries the `tenantId` internally. Do not add subdomain/query-param resolution to this route.

## Invite Lifecycle

```
createInvite → [email or SMS sent] → acceptInvite
                                   ↓
                               revokeInvite (owner, pending only)
```

**Token**: 32-char hex string (`crypto.randomUUID().replace(/-/g, '')`). Stored in `invites.token` with a unique index. TTL is **48 hours** (`INVITE_TTL_HOURS = 48`).

**Status transitions** (one direction only):
- `pending` → `accepted` (via `acceptInvite`)
- `pending` → `revoked` (via `revokeInvite`)

`revokeInvite` throws `INVITE_NOT_PENDING` if the invite is already `accepted` or `revoked`. `acceptInvite` throws `INVITE_ALREADY_USED` for the same guard.

## `createInvite` — Guards (in order)

1. Rejects if a `pending` invite already exists for the same `contact` + `tenantId` (`INVITE_EXISTS`)
2. Checks the plan's `teachers` limit via `assertWithinLimit` before inserting
3. Inserts the invite row, then dispatches email or SMS

**Dev behaviour**: in non-production, both email and SMS delivery are skipped and the invite URL is printed to stdout. SMS delivery is also unfinished in production — `sendInvitePhone` logs a warning and does nothing (MSG91 transactional SMS template not yet configured).

## `acceptInvite` — Guards (in order)

1. Token must exist
2. `status === 'pending'`
3. `expiresAt` not passed
4. Accepted user's email or phone must match `invite.contact` (`INVITE_CONTACT_MISMATCH` — prevents someone else's account from consuming the invite)
5. User must not already be a member of the coaching (`ALREADY_MEMBER`)
6. Plan `teachers` limit checked again via `assertWithinLimit`

**Transaction** (atomic on accept):
1. Insert `memberships` row (role = `teacher`)
2. Set `users.role = 'teacher'` and `users.tenantId` to the coaching
3. Set `invites.status = 'accepted'`

## Validation

The route uses a Zod `.refine()` that cross-validates `contact` against `contactType`:
- `contactType: 'email'` → `contact` must pass `z.string().email()`
- `contactType: 'phone'` → `contact` must match `/^\+?[0-9]{10,15}$/`

This runs in the route, not the service — the service trusts that `contact` and `contactType` are already consistent.

## Schema Notes

`invites.tenantId` has `onDelete: 'cascade'` — invite rows are deleted automatically if the tenant is deleted. `invitedBy` does not cascade (preserves audit trail even if the inviting user is removed).

`listInvites` strips `token` and `invitedBy` from the returned rows — do not add `token` to the projection as it is a secret one-time credential.
