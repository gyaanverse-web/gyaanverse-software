# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server with hot-reload (tsx watch src/server.ts)
npm run dev:worker   # Start background job worker with hot-reload
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled production server
npm run test         # Run Vitest test suite
npm run db:generate  # Generate Drizzle migrations from schema changes
npm run db:migrate   # Apply pending migrations
npm run db:studio    # Open Drizzle Studio (DB browser)
```

## Architecture

**Fastify 5** backend for a multi-tenant SaaS platform serving coaching institutes. Two entry points: `src/server.ts` (HTTP API) and `src/worker.ts` (BullMQ background jobs via Redis).

### Module Pattern

Every feature module under `src/modules/` follows the same four-file pattern:
- `{module}.schema.ts` — Drizzle table definitions
- `{module}.types.ts` — TypeScript interfaces
- `{module}.service.ts` — Business logic (no direct route handling)
- `{module}.routes.ts` — Fastify route handlers
- `index.ts` — Re-exports

All table definitions must be re-exported from `src/shared/schema.ts` so Drizzle Kit can pick them up for migrations.

### Path Aliases

Use these in all imports — never use relative paths across module boundaries:
- `@modules/*` → `src/modules/*`
- `@shared/*` → `src/shared/*`
- `@middleware/*` → `src/middleware/*`
- `@config/*` → `src/config/*`

### Multi-Tenancy

Tenant is resolved by subdomain (`sharma.yourapp.com` → slug `sharma`). In local dev, fall back to `?tenant=slug` query param. The `tenant.middleware.ts` attaches the resolved tenant to every request. Tenant-scoped routes are registered separately from global routes in `src/app.ts`.

### Authentication

**Better Auth** handles sessions. Two auth methods:
1. Email + password (email verification required before first login)
2. Phone OTP via MSG91 (`MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID` are optional in dev — falls back to console logging)

Middleware in `src/middleware/auth.middleware.ts`:
- `authenticate()` — verifies session token or cookie, attaches user to request
- `requireRole(...roles)` — checks `user.role` (global: `super_admin`, `coaching_owner`, `teacher`, `student`)
- `requireTenantRole(...roles)` — checks the membership row for the resolved tenant

### Plan & Feature Gating

Plans are defined in `src/config/plans.ts` (Free / Starter ₹999 / Growth ₹2499 / Pro ₹5999). Use `Errors.PLAN_LIMIT(limit)` and `Errors.FEATURE_GATED(feature)` from `src/shared/errors.ts` when enforcing limits in service layer. Never enforce limits inside route handlers.

### Error Handling

Throw `AppError` instances from the `Errors` factory in `src/shared/errors.ts`. Fastify's global error handler converts them to structured JSON responses. Common codes: `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`, `VALIDATION`, `PLAN_LIMIT`, `FEATURE_GATED`.

### Database

Drizzle ORM with PostgreSQL via `pg` pool. Connection in `src/shared/db.ts`. Use UUID primary keys (`crypto.randomUUID()`). All timestamps must use `{ withTimezone: true }`. Prefer transactions for multi-table writes.

### Background Jobs

BullMQ + Redis (`REDIS_URL`). Add new job processors in `src/worker.ts`. Job types are enqueued from service layer using the shared queue client.

## Environment Variables

Required: `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`, `RESEND_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `APP_DOMAIN`

Optional in dev: `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` (SMS OTP — logs to console if missing)

Defaults: `PORT=3000`, `FRONTEND_URL=http://localhost:5173`, `NODE_ENV=development`
