# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Tenant Module — Scope

Manages coaching institutes (tenants), their settings, and their membership roster. Also owns the `tenantSettings` table and coordinates with `billing.service.ts` for plan enforcement. Tenant resolution (subdomain → slug → row) lives in `src/middleware/tenant.middleware.ts`.

## Files

| File | Purpose |
|------|---------|
| `tenant.schema.ts` | `tenants` and `tenantSettings` tables |
| `tenant.types.ts` | `Tenant`, `TenantSettings`, `Member` interfaces |
| `tenant.service.ts` | All business logic — registration, membership, settings |
| `tenant.routes.ts` | Route handlers (global + tenant-scoped) |

## Routes

Two distinct route namespaces — global (no tenant context) and tenant-scoped.

### Global routes (no tenant context)

| Method | Path | Auth | Who |
|--------|------|------|-----|
| `POST` | `/tenants` | `authenticate` | Any verified user |
| `GET` | `/tenants/me` | `authenticate` | Any authenticated user |
| `GET` | `/tenants/:id` | — | Public (safe fields only) |
| `POST` | `/tenants/join` | `authenticate` | Any authenticated user |

### Tenant-scoped routes (resolved via subdomain or `?tenant=`)

| Method | Path | Middleware chain | Who |
|--------|------|-----------------|-----|
| `POST` | `/tenant/teachers` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` | Owner |
| `GET` | `/tenant/members` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner', 'teacher')` | Owner, Teacher |
| `DELETE` | `/tenant/members/:userId` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` | Owner |
| `PATCH` | `/tenant/settings` | `authenticate → tenantMiddleware → requireTenantRole('coaching_owner')` | Owner |

## Key Business Logic

### `registerCoaching` — atomic 4-step transaction
1. Validates slug (format + reserved list + uniqueness)
2. Asserts caller has at least one verified identity (`emailVerified` or `phoneNumberVerified`)
3. Asserts caller doesn't already own a coaching (`coaching_owner` membership)
4. In a single transaction: inserts `tenants`, `tenantSettings`, `memberships` (as `coaching_owner`), and updates `users.role` + `users.tenantId`

**Reserved slugs**: `www`, `api`, `admin`, `app`, `static` — extend `RESERVED_SLUGS` in `tenant.service.ts` if more are needed.

### `addTeacher`
- Looks up the target user by **phone number** (teachers must already have an account)
- Enforces the plan's `teachers` limit via `assertWithinLimit` before inserting
- Updates both `memberships` and `users.role` / `users.tenantId` in a transaction

### `joinAsStudent`
- Accepts `tenantId` (not slug) in the request body
- Checks tenant `status === 'active'` before allowing join
- Enforces the plan's `students` limit via `assertWithinLimit`

### `removeMember`
- Self-removal is blocked (`targetUserId === requesterId`)
- Removing the `coaching_owner` is blocked regardless of who is requesting
- After deleting the membership row, resets `users.tenantId = null` and `users.role = 'student'` **only if** the removed user's `tenantId` still points to this tenant (guards against the user having joined another tenant in between)

### `updateSettings`
- `allowPublicMocks = true` requires the `public_mocks` feature (Starter+)
- `customDomain` requires the `custom_branding` feature (Pro only)
- Both are enforced via `assertHasFeature` from `billing.service.ts` before the DB update

## Schema Notes

**Circular FK**: `tenants.ownerId → users.id` and `users.tenantId → tenants.id` form a mutual dependency. The circular import is resolved by wrapping `ownerId`'s reference callback as `(): AnyPgColumn => users.id`. Do not change this to a direct reference.

**`tenantSettings` is 1-to-1** with `tenants` — `tenantId` is both the PK and the FK. It is always created in the same transaction as the parent `tenants` row (in both `createTenant` and `registerCoaching`).

**`GET /tenants/:id`** strips sensitive fields (`ownerId`, `plan`, `createdAt`) before responding — only `id`, `slug`, `name`, `logoUrl`, `status` are returned. Keep this projection intentional when adding new columns.

## Tenant Resolution (src/middleware/tenant.middleware.ts)

Resolution order:
1. Subdomain: `sharma.yourapp.com` → slug `sharma` (strips port before matching)
2. Query param: `?tenant=sharma` (local dev fallback)

Attaches the full `Tenant` row to `req.tenant`. Routes that use `tenantMiddleware` can safely read `(req as any).tenant` — it is always non-null if the middleware didn't throw.

## Plan Enforcement

All limit/feature checks are delegated to `billing.service.ts`:
- `assertWithinLimit(tenantId, 'students' | 'teachers' | ...)` — throws `PLAN_LIMIT` if over quota
- `assertHasFeature(tenantId, 'public_mocks' | 'custom_branding' | ...)` — throws `FEATURE_GATED` if not on required plan

Never inline plan logic in service functions — always call through `billing.service.ts`.
