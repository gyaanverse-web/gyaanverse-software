import * as dotenv from 'dotenv'
dotenv.config()

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

function devOptional(key: string): string {
  if (process.env.NODE_ENV === 'production') return requireEnv(key)
  return process.env[key] ?? ''
}

const APP_DOMAIN = requireEnv('APP_DOMAIN')

// Base URL of the Next.js frontend.
//
// Every user-facing link we email out (email verification, password reset,
// teacher invites) MUST point at a page here — never at the API host, which
// serves JSON only and answers anything else with "Route GET:/ not found".
//
// dev:  the app runs on app.lvh.me:3000 (see auth.ts for why not localhost)
// prod: FRONTEND_URL is set explicitly per environment; APP_DOMAIN is the
//       fallback so a missing var degrades to the right domain, not localhost.
const FRONTEND_URL = (
  process.env.FRONTEND_URL ??
  (process.env.NODE_ENV === 'production' ? `https://${APP_DOMAIN}` : 'http://app.lvh.me:3000')
).replace(/\/+$/, '')

export const env = {
  DATABASE_URL: requireEnv('DATABASE_URL'),
  REDIS_URL: requireEnv('REDIS_URL'),
  BETTER_AUTH_SECRET: requireEnv('BETTER_AUTH_SECRET'),
  BETTER_AUTH_URL: requireEnv('BETTER_AUTH_URL'),
  CLOUDINARY_CLOUD_NAME: requireEnv('CLOUDINARY_CLOUD_NAME'),
  CLOUDINARY_API_KEY: requireEnv('CLOUDINARY_API_KEY'),
  CLOUDINARY_API_SECRET: requireEnv('CLOUDINARY_API_SECRET'),
  CLOUDINARY_UPLOAD_FOLDER: process.env.CLOUDINARY_UPLOAD_FOLDER ?? 'gyaanverse',
  STORAGE_MAX_UPLOAD_BYTES: parseInt(process.env.STORAGE_MAX_UPLOAD_BYTES ?? String(10 * 1024 * 1024), 10),
  RESEND_API_KEY: requireEnv('RESEND_API_KEY'),
  MSG91_AUTH_KEY: devOptional('MSG91_AUTH_KEY'),
  MSG91_TEMPLATE_ID: devOptional('MSG91_TEMPLATE_ID'),
  MSG91_SENDER_ID: devOptional('MSG91_SENDER_ID'),
  MAILPIT_HOST: process.env.MAILPIT_HOST ?? 'localhost',
  MAILPIT_PORT: parseInt(process.env.MAILPIT_PORT ?? '1025', 10),
  FRONTEND_URL,
  RAZORPAY_KEY_ID: requireEnv('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: requireEnv('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: requireEnv('RAZORPAY_WEBHOOK_SECRET'),
  APP_DOMAIN,

  // ── Internal ops panel (Phase 7) ─────────────────────────────────────────
  //
  // Origin of the separately-deployed operator panel. Today that is
  // `https://admin.<APP_DOMAIN>`, which the CORS subdomain regex in app.ts
  // already matches — so this is empty in practice and everything still works.
  //
  // It exists for the move the panel is *designed* for: the whole point of
  // deploying it separately is that a DNS or TLS failure in the main zone must
  // not take the ops surface down with it, and that only becomes true once it
  // lives on a domain we did not just break. On that day this variable is the
  // entire change on the backend — set it, and both the CORS allowlist and
  // better-auth's trustedOrigins pick the new origin up.
  //
  // Not `requireEnv`: an unset value is the correct state while the panel is on
  // a subdomain, and hard-failing boot over it would make the API depend on a
  // variable it does not yet need.
  OPS_ORIGIN: process.env.OPS_ORIGIN ?? '',

  // How long a session may be used against `/internal/*` before the operator has
  // to sign in again, independent of the (much longer) global session lifetime.
  //
  // These routes are cross-tenant and they write scores, so the blast radius of
  // a forgotten laptop is every coaching on the platform rather than one. 12h
  // keeps it to a single working day. See middleware/internal.ts.
  OPS_SESSION_MAX_AGE_MS: parseInt(
    process.env.OPS_SESSION_MAX_AGE_MS ?? String(12 * 60 * 60 * 1000),
    10,
  ),

  // ── Bull Board (/queues) ─────────────────────────────────────────────────
  //
  // The fallback ops surface. The panel covers evaluation and nothing else, and
  // it will stay that way for a long time — every other queue in this system
  // (email, SMS, bulk, lifecycle, reconciler) is observable from here or from
  // nowhere.
  //
  // **The password is the mount switch in production.** Unset means the board is
  // not registered at all, not that it is registered unguarded — see
  // config/bull-board.ts. A queue dashboard is not a read-only surface: it can
  // retry, promote and delete jobs across every tenant, which makes an
  // accidentally-public one strictly worse than an absent one.
  BULL_BOARD_USER: process.env.BULL_BOARD_USER ?? 'ops',
  BULL_BOARD_PASSWORD: process.env.BULL_BOARD_PASSWORD ?? '',

  // Optional comma-separated IP allowlist, checked before the password. Defence
  // in depth only: Railway terminates at its own edge, so `req.ip` is whatever
  // one hop of X-Forwarded-For says (see `trustProxy` in app.ts). Useful when
  // the operators sit behind a fixed office IP or a VPN; never the sole gate.
  BULL_BOARD_IPS: process.env.BULL_BOARD_IPS ?? '',

  // ── API docs (/docs, /openapi.json) ──────────────────────────────────────
  //
  // Same three variables, same fail-closed rule as the board above: unset
  // password in production means the reader is not mounted at all. Open in dev
  // and staging, where a browsable API is the point.
  //
  // A read-only surface, so the stakes are lower than the queue console — but it
  // is a complete machine-readable map of every route and its parameters, and it
  // is addressed to us, not to coachings (who integrate through the frontend).
  // See config/docs.ts.
  API_DOCS_USER: process.env.API_DOCS_USER ?? 'docs',
  API_DOCS_PASSWORD: process.env.API_DOCS_PASSWORD ?? '',
  API_DOCS_IPS: process.env.API_DOCS_IPS ?? '',

  // ── Review-queue digest (Phase 7) ────────────────────────────────────────
  //
  // A screen only helps someone who looks. `open` — answers waiting on a
  // Gyaanverse operator — is the number this whole plan says matters most, and
  // every one of them is a teacher who cannot press publish. So it gets pushed.
  //
  // Sent only when `open > 0`, deliberately: a daily "all clear" is how a daily
  // email becomes a filter rule. See evaluation.digest.ts.
  OPS_DIGEST_CRON: process.env.OPS_DIGEST_CRON ?? '0 8 * * *',
  OPS_DIGEST_TZ: process.env.OPS_DIGEST_TZ ?? 'Asia/Kolkata',

  // Extra recipients, comma-separated. Added to — never instead of — the
  // `super_admin` accounts, so pointing this at a shared alias cannot silently
  // unsubscribe the people who can actually clear the queue.
  OPS_DIGEST_EMAILS: process.env.OPS_DIGEST_EMAILS ?? '',

  EVAL_ENGINE_URL: process.env.EVAL_ENGINE_URL ?? 'http://localhost:5000/evaluation_engine',
  EVAL_ENGINE_TIMEOUT_MS: parseInt(process.env.EVAL_ENGINE_TIMEOUT_MS ?? '120000', 10),
  EVAL_DEFAULT_COLLECTION: process.env.EVAL_DEFAULT_COLLECTION ?? '',

  // ── Blank-page detector (pixel-only, no OCR/LLM) ─────────────────────────
  //
  // A separate, much smaller engine — `AI_Engines/engines/image_processing` —
  // answers one question locally with OpenCV: does this image have anything
  // written on it at all. It is not part of the grading engine's circuit
  // breaker: a call here is milliseconds, not tens of seconds, and its own
  // outage must never affect the AI engine's failure count. See
  // evaluation.blank-page.ts.
  BLANK_PAGE_ENGINE_URL: process.env.BLANK_PAGE_ENGINE_URL ?? 'http://localhost:5000/image_processing',
  BLANK_PAGE_ENGINE_TIMEOUT_MS: parseInt(process.env.BLANK_PAGE_ENGINE_TIMEOUT_MS ?? '10000', 10),

  // ── Evaluation throughput (Phase 5) ──────────────────────────────────────
  //
  // BullMQ's default worker concurrency is 1. With a 120s engine timeout that
  // serialises a 200-student exam into hours, which is the thing that makes a
  // silent pipeline dangerous: the teacher waits and nothing anywhere says why.
  // 5 is deliberately modest — the ceiling that actually matters is the engine's,
  // enforced by the limiter below, and raising concurrency past what the engine
  // can serve converts a capacity problem into a timeout problem.
  EVAL_WORKER_CONCURRENCY: parseInt(process.env.EVAL_WORKER_CONCURRENCY ?? '5', 10),

  // Queue-global rate limit (BullMQ enforces it in Redis, so it holds across
  // every replica, not per-process). Counts job *starts*, not engine calls —
  // see the note in worker.ts. Tune against the OpenAI/Gemini quota.
  EVAL_RATE_MAX: parseInt(process.env.EVAL_RATE_MAX ?? '30', 10),
  EVAL_RATE_DURATION_MS: parseInt(process.env.EVAL_RATE_DURATION_MS ?? '60000', 10),

  // ── Engine circuit breaker (Phase 5) ─────────────────────────────────────
  //
  // Consecutive unreachable/timeout results before the breaker opens, and how
  // long it stays open. While open, calls fail immediately instead of each one
  // paying the full EVAL_ENGINE_TIMEOUT_MS. See evaluation.engine.ts.
  EVAL_BREAKER_THRESHOLD: parseInt(process.env.EVAL_BREAKER_THRESHOLD ?? '5', 10),
  EVAL_BREAKER_OPEN_MS: parseInt(process.env.EVAL_BREAKER_OPEN_MS ?? '30000', 10),

  // Which set of queues this worker process consumes: `all` (default — one
  // process runs everything, right for local dev and a single-service deploy),
  // `evaluation` (the horizontally scalable half), or `general` (notifications
  // plus the control-plane ticks). See worker.ts.
  WORKER_ROLE: (process.env.WORKER_ROLE ?? 'all') as 'all' | 'evaluation' | 'general',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.PORT ?? '3000', 10),
}
