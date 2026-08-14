import * as dotenv from 'dotenv'

// ─────────────────────────────────────────────────────────────────────────────
// Import this BEFORE ../src/config/env.js. ESM evaluates imported modules in
// source order, so being a separate module is what lets this run first.
//
// Why it needs to run first: this machine carries a user-level
// NODE_ENV=production. `dotenv.config()` never overwrites a variable that is
// already set, so the .env line saying `development` loses, and every dev
// script dies inside config/env.ts on a var that is only required in
// production (`Missing required env var: MSG91_AUTH_KEY`) — an error that says
// nothing about the actual cause.
//
// Overriding NODE_ENV would be a bad guard to remove if it were the only one,
// so it isn't: `assertLocalDatabase` below is the real protection, and it is
// stricter than NODE_ENV ever was. NODE_ENV describes the shell; the database
// URL describes what a mistake would actually destroy.
// ─────────────────────────────────────────────────────────────────────────────

dotenv.config()

/** True when we had to override a production NODE_ENV inherited from the shell. */
export const overrodeProductionEnv = process.env.NODE_ENV === 'production'
if (overrodeProductionEnv) process.env.NODE_ENV = 'development'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'])

/**
 * Refuse to run a seeding tool against anything but a local database.
 *
 * Returns a `user@host:port/db` summary for the banner — printing what you are
 * about to write to is half the guard.
 */
export function assertLocalDatabase(allowRemote: boolean): string {
  const raw = process.env.DATABASE_URL
  if (!raw) {
    console.error('\n  ERROR: DATABASE_URL is not set. Is backend/.env present?\n')
    process.exit(1)
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    console.error('\n  ERROR: DATABASE_URL is not a valid URL.\n')
    process.exit(1)
  }

  const summary = `${parsed.username}@${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`

  if (!LOCAL_HOSTS.has(parsed.hostname) && !allowRemote) {
    console.error(`\n  ERROR: DATABASE_URL points at a remote host (${parsed.hostname}).`)
    console.error('  This tool creates users, classes and exam sessions in bulk and is')
    console.error('  meant for a local development database only.\n')
    console.error('  If you genuinely mean to seed a remote database, re-run with --allow-remote.\n')
    process.exit(1)
  }

  return summary
}
