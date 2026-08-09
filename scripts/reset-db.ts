import { createInterface } from 'node:readline/promises'
import * as dotenv from 'dotenv'
import { Pool } from 'pg'

// Deliberately NOT importing `src/config/env.js`. That module hard-requires every
// runtime key (Resend, Razorpay, Cloudinary…) at import time, none of which a
// TRUNCATE needs — and because ESM hoists imports, its throw would beat the
// production guard below to the punch. Loading .env and reading the one variable
// we actually use keeps the guards first and the script runnable on a machine
// that has nothing but a database configured.
dotenv.config()

// ─────────────────────────────────────────────────────────────────────────────
// Wipes the development database so the next seed run starts from nothing.
//
//   npm run db:reset              # empty every table, keep the schema
//   npm run db:reset -- --yes     # ...without the confirmation prompt
//   npm run db:reset -- --hard    # drop the schema too; re-run db:migrate after
//
// Two modes, because they answer different questions:
//
//   soft (default)  TRUNCATE every table in `public`. The schema and the
//                   applied-migration journal survive, so `db:migrate` stays a
//                   no-op and you are ready to re-seed immediately. This is the
//                   one you want ~always.
//
//   hard (--hard)   DROP both the `public` and `drizzle` schemas. That discards
//                   the migration journal as well, so the next `db:migrate`
//                   replays all migrations from zero — which is how you find out
//                   whether they actually apply to an empty database. Slower,
//                   and USELESS ON ITS OWN: nothing works until you migrate.
//
// Safety: refuses under NODE_ENV=production, and refuses a non-local database
// host unless you pass --force. Dropping a colleague's staging data because a
// stale DATABASE_URL was exported is not a recoverable mistake.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  console.error('\n  ERROR: reset script is not allowed in production.\n')
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('\n  ERROR: DATABASE_URL is not set (checked the environment and backend/.env).\n')
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const hard = args.has('--hard')
const assumeYes = args.has('--yes') || args.has('-y')
const force = args.has('--force')

// ── Guard: is this actually a local database? ────────────────────────────────
// Parsed rather than string-matched so `...@prod-host/db?host=localhost` can't
// talk its way past the check.
const dbUrl = new URL(DATABASE_URL)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '', 'postgres', 'db', 'host.docker.internal'])
const isLocal = LOCAL_HOSTS.has(dbUrl.hostname)

if (!isLocal && !force) {
  console.error(`\n  ERROR: '${dbUrl.hostname}' is not a local database host.`)
  console.error('  Refusing to wipe it. Pass --force if you are certain.\n')
  process.exit(1)
}

const target = `${dbUrl.hostname}:${dbUrl.port || '5432'}${dbUrl.pathname}`

// ── Confirm ──────────────────────────────────────────────────────────────────
if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log(`\n  About to ${hard ? 'DROP THE SCHEMA OF' : 'DELETE ALL DATA IN'}  ${target}`)
  if (!isLocal) console.log('  WARNING: this host is NOT local, and --force was given.')
  const answer = await rl.question('  This cannot be undone. Type "yes" to continue: ')
  rl.close()
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('\n  Aborted. Nothing was changed.\n')
    process.exit(1)
  }
}

const pool = new Pool({ connectionString: DATABASE_URL })

// Row counts before the wipe, so the summary shows what was actually discarded
// rather than just claiming success.
async function tableCounts(): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  )
  const counts = new Map<string, number>()
  for (const { table_name } of rows) {
    const { rows: [r] } = await pool.query<{ n: string }>(`select count(*)::text as n from "${table_name}"`)
    counts.set(table_name, Number(r.n))
  }
  return counts
}

try {
  const before = await tableCounts()
  const totalRows = [...before.values()].reduce((a, b) => a + b, 0)

  if (before.size === 0) {
    console.log('\n  No tables in `public` — the database is already bare.')
    console.log('  Run `npm run db:migrate` to build the schema.\n')
    process.exit(0)
  }

  if (hard) {
    // `drizzle` holds the applied-migration journal; dropping it is the whole
    // point of --hard, otherwise db:migrate would think it had nothing to do.
    await pool.query('drop schema if exists public cascade')
    await pool.query('drop schema if exists drizzle cascade')
    await pool.query('create schema public')
    // Restore the grants a fresh Postgres database ships with, so the app role
    // can create tables again on the next migrate.
    await pool.query('grant all on schema public to public')
    await pool.query(`grant all on schema public to "${dbUrl.username || 'postgres'}"`)
  } else {
    // One statement so it is a single transaction: either every table empties or
    // none does. CASCADE handles the FK graph; RESTART IDENTITY resets sequences.
    const list = [...before.keys()].map((t) => `"${t}"`).join(', ')
    await pool.query(`truncate table ${list} restart identity cascade`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const divider = '─'.repeat(56)
  console.log(`\n${divider}`)
  console.log(`  Database reset (${hard ? 'hard — schema dropped' : 'soft — data truncated'})`)
  console.log(divider)
  console.log(`  target     ${target}`)
  console.log(`  tables     ${before.size}`)
  console.log(`  rows       ${totalRows} discarded`)

  const nonEmpty = [...before.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (nonEmpty.length) {
    console.log(divider)
    for (const [t, n] of nonEmpty) console.log(`  ${t.padEnd(28)} ${String(n).padStart(6)}`)
  }
  console.log(divider)
  console.log('  Next:')
  if (hard) console.log('    npm run db:migrate         (required — there is no schema yet)')
  console.log('    npm run db:seed            users, dev tenant, classes')
  console.log('    npm run db:seed:questions  question bank')
  console.log(`${divider}\n`)
} finally {
  await pool.end()
}

process.exit(0)
