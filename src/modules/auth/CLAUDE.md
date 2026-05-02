# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Auth Module — Scope

Handles user identity, sessions, and profile management. Auth configuration lives in `src/config/auth.ts`; middleware lives in `src/middleware/auth.middleware.ts`. This module owns only the DB schema, service functions, and route handlers.

## Files

| File | Purpose |
|------|---------|
| `auth.schema.ts` | `users`, `session`, `account`, `verification` tables |
| `auth.types.ts` | `Role` union type, `User` interface |
| `auth.service.ts` | `getCurrentUser`, `updateProfile` + its Zod schema |
| `auth.routes.ts` | Route handlers wired to Better Auth and service layer |

## Routes

All routes are prefixed with `/api/auth/`.

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `POST` | `/sign-up/email` | — | Better Auth handler; sends verification email |
| `POST` | `/sign-in/email` | — | Requires `emailVerified = true` |
| `POST` | `/phone-number/send-otp` | — | Dev: OTP logged to console, not sent via MSG91 |
| `POST` | `/phone-number/verify` | — | Sets cookie + returns `{ token }` for Bearer |
| `POST` | `/sign-out` | — | Better Auth handler |
| `GET` | `/get-session` | — | Better Auth handler |
| `POST` | `/request-password-reset` | — | Custom handler; registered *before* wildcard |
| `GET` | `/me` | `authenticate` | Returns current user row |
| `PATCH` | `/me` | `authenticate` | Update name/email; see constraints below |

The `POST /api/auth/*` wildcard catch-all delegates to `auth.handler()` from Better Auth. The password-reset route **must** stay registered before the wildcard or Fastify will never reach it.

## Key Constraints

**Phone-only accounts** use a synthetic email `{digits}@phone.gyanverse.app`. Two places guard against this leaking:
- `request-password-reset` silently skips addresses ending in `@phone.gyanverse.app`
- `updateProfile` rejects any submitted email ending with that domain

**Email change on `PATCH /me`**:
- Phone users (`emailVerified = false`) may supply an `email` field to add a real address; this resets `emailVerified` to `false` and triggers a verification email.
- Email users (`emailVerified = true`) cannot change their email — route returns `403`.

**`isProfileComplete`** is set to `true` on any successful `updateProfile` call.

## Schema Notes

Column names in `users` match Better Auth conventions exactly (e.g., `email_verified`, not `emailverified`) so no field mapping is needed in `src/config/auth.ts`.

Better Auth tables use singular names (`session`, `account`, `verification`) even though the Drizzle exports are plural (`sessions`, `accounts`, `verifications`). The mapping is done in `src/config/auth.ts` via `modelName`.

`generateId` is overridden in `src/config/auth.ts` to use `crypto.randomUUID()` because Better Auth's default nanoid generator produces non-UUID strings, incompatible with the `uuid` column type.

## Middleware (src/middleware/auth.middleware.ts)

- `authenticate` — reads session from cookie or `Authorization: Bearer <token>` header; attaches `{ id, role }` to `req.user`.
- `requireRole(...roles)` — checks `req.user.role` (global role on the `users` table). Must run after `authenticate`.
- `requireTenantRole(...roles)` — checks the `memberships` table for the resolved tenant. Must run after both `authenticate` and `tenantMiddleware`.

## Adding a New Auth Route

1. Add the handler in `auth.routes.ts`.
2. If it needs a DB query, add a function to `auth.service.ts` (keep routes thin).
3. Always validate request body with Zod before touching the DB.
4. Use `Errors.*` from `@shared/errors` — never construct raw HTTP responses with status codes in service functions.
