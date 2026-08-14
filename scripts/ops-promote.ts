import { createInterface } from 'node:readline/promises'
import * as dotenv from 'dotenv'
import { Pool } from 'pg'

// Deliberately NOT importing `src/config/env.js` — same reasoning as reset-db.ts.
// That module hard-requires every runtime key (Resend, Razorpay, Cloudinary…) at
// import time, and this script needs exactly one of them. Promoting the first
// operator on a fresh production database should not depend on the SMS provider
// being configured.
dotenv.config()

// ─────────────────────────────────────────────────────────────────────────────
// Mint a Gyanverse platform operator.
//
//   npm run ops:promote -- --list                 # who is a super_admin today
//   npm run ops:promote -- someone@gyanverse.com  # promote
//   npm run ops:promote -- someone@… --demote     # take it back
//   npm run ops:promote -- someone@… --yes        # skip the confirmation
//   npm run ops:promote -- someone@… --force      # override the safety refusals
//
// WHY THIS EXISTS
//
// Nothing else in the codebase ever writes `role = 'super_admin'`. Signup cannot
// produce one (auth.routes rejects a hostile signupIntent, and `role` is derived,
// never accepted from the client), and there is no endpoint for it — on purpose:
// a self-service route to a cross-tenant account is a permanent hole in exchange
// for a one-off convenience.
//
// The consequence, until this script existed, was that Phase 6 shipped a review
// queue, an override endpoint and a publish gate that depended on both, with no
// human able to reach any of them. An exam whose answer got flagged `needs_human`
// had a publish button nobody on Earth could unblock.
//
// This runs in production on purpose — that is the environment where the first
// operator has to be minted. So the guards are confirmation and blast-radius
// checks rather than a NODE_ENV refusal.
//
// DELIBERATELY CANNOT CREATE A USER. The person must already have signed up
// through the normal flow, which is what gives them a password row in `account`
// and a verified email. A script that could conjure a credentialled cross-tenant
// account out of an env var is a backdoor, however well-intentioned.
// ─────────────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('\n  ERROR: DATABASE_URL is not set (checked the environment and backend/.env).\n')
  process.exit(1)
}

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') || a === '-y'))
const positional = argv.filter((a) => !a.startsWith('-'))

const list = flags.has('--list')
const demote = flags.has('--demote')
const assumeYes = flags.has('--yes') || flags.has('-y')
const force = flags.has('--force')
const email = positional[0]?.trim().toLowerCase()

const dbUrl = new URL(DATABASE_URL)
const target = `${dbUrl.hostname}:${dbUrl.port || '5432'}${dbUrl.pathname}`
const pool = new Pool({ connectionString: DATABASE_URL })

interface UserRow {
  id: string
  name: string
  email: string
  role: string
  email_verified: boolean
  tenant_id: string | null
}

async function showOperators(): Promise<number> {
  const { rows } = await pool.query<UserRow>(
    `select id, name, email, role, email_verified, tenant_id
       from users where role = 'super_admin' order by created_at`,
  )
  if (rows.length === 0) {
    console.log('\n  No platform operators exist.')
    console.log('  Until one does, the /internal/* routes and the review queue are unreachable,')
    console.log('  and any exam with a flagged answer cannot be published by anyone.\n')
  } else {
    console.log(`\n  Platform operators (${rows.length}):\n`)
    for (const r of rows) console.log(`    ${r.email.padEnd(38)} ${r.name}`)
    console.log('')
  }
  return rows.length
}

async function main(): Promise<void> {
  if (list) {
    await showOperators()
    return
  }

  if (!email) {
    console.error('\n  Usage: npm run ops:promote -- <email> [--demote] [--yes] [--force]')
    console.error('         npm run ops:promote -- --list\n')
    process.exitCode = 1
    return
  }

  const { rows } = await pool.query<UserRow>(
    `select id, name, email, role, email_verified, tenant_id from users where lower(email) = $1`,
    [email],
  )
  const user = rows[0]

  if (!user) {
    console.error(`\n  ERROR: no user with email '${email}' on ${target}.`)
    console.error('  They must sign up through the app first — this script promotes an existing')
    console.error('  account, it never creates one.\n')
    process.exitCode = 1
    return
  }

  const nextRole = demote ? 'student' : 'super_admin'
  if (user.role === nextRole) {
    console.log(`\n  Nothing to do — ${user.email} is already '${nextRole}'.\n`)
    return
  }

  // ── Blast-radius guards (promotion only) ──────────────────────────────────
  if (!demote) {
    // An unverified email means nobody has proven they control the address. That
    // is an acceptable risk for a student account and not for one that can read
    // and rewrite every coaching's marks.
    if (!user.email_verified && !force) {
      console.error(`\n  ERROR: ${user.email} has not verified their email address.`)
      console.error('  Refusing to grant cross-tenant access to an unproven address. Use --force to override.\n')
      process.exitCode = 1
      return
    }

    // Someone who runs a coaching AND operates the platform can silently rewrite
    // scores inside their own coaching through a cross-tenant endpoint their
    // teachers cannot see. Separately, `role` is what the frontend navigates on,
    // so overwriting 'coaching_owner' changes which app they land in.
    const { rows: owned } = await pool.query<{ n: string }>(
      `select count(*)::text as n from tenants where owner_id = $1`,
      [user.id],
    )
    const { rows: member } = await pool.query<{ n: string }>(
      `select count(*)::text as n from memberships where user_id = $1`,
      [user.id],
    )
    const ownedCount = parseInt(owned[0]?.n ?? '0', 10)
    const memberCount = parseInt(member[0]?.n ?? '0', 10)

    if ((ownedCount > 0 || memberCount > 0) && !force) {
      console.error(`\n  ERROR: ${user.email} belongs to a coaching (owns ${ownedCount}, member of ${memberCount}).`)
      console.error('  A platform operator who is also inside a tenant can override marks in their own')
      console.error("  coaching through a cross-tenant route, and promoting them overwrites the account")
      console.error('  role their app navigation depends on.')
      console.error('  Use a dedicated Gyanverse staff account, or --force if you accept both.\n')
      process.exitCode = 1
      return
    }
  }

  if (!assumeYes) {
    const verb = demote ? 'DEMOTE' : 'PROMOTE TO PLATFORM OPERATOR'
    console.log(`\n  About to ${verb}`)
    console.log(`      ${user.name} <${user.email}>`)
    console.log(`      role: ${user.role} → ${nextRole}`)
    console.log(`      db:   ${target}`)
    if (!demote) {
      console.log('\n  A platform operator reads and rewrites scores across EVERY coaching.')
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('  Type "yes" to continue: ')
    rl.close()
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('\n  Aborted. Nothing was changed.\n')
      process.exitCode = 1
      return
    }
  }

  await pool.query(`update users set role = $1, updated_at = now() where id = $2`, [nextRole, user.id])

  // The role change is the security event; recording it here means the trail
  // starts at the moment the account gained its power, not at its first override.
  // actor_id is the subject's own id — a CLI run has no authenticated actor, and
  // inventing a null one would break the column's not-null contract.
  await pool.query(
    `insert into audit_logs (actor_id, tenant_id, action, target_id, metadata)
     values ($1, null, $2, $3, $4)`,
    [
      user.id,
      demote ? 'ops.demote' : 'ops.promote',
      user.id,
      JSON.stringify({ email: user.email, from: user.role, to: nextRole, via: 'ops-promote script', forced: force }),
    ],
  )

  console.log(`\n  ✓ ${user.email} is now '${nextRole}'.\n`)

  if (!demote) {
    console.log('  They can now sign in at the ops panel. No signup, no self-service —')
    console.log('  every future operator comes through this script.')
    console.log(`  Sessions older than OPS_SESSION_MAX_AGE_MS are rejected on /internal/*.\n`)
  }
}

try {
  await main()
} catch (err) {
  console.error('\n  ERROR:', err instanceof Error ? err.message : err, '\n')
  process.exitCode = 1
} finally {
  await pool.end()
}
