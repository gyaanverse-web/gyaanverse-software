import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers must never authorise on the ACCOUNT role.
//
// `req.user.role` is one global column. A user can own one coaching and be a
// student in another, so in the second coaching it still says `coaching_owner`.
// Handlers that branched on it handed that student the owner's view: every class,
// the full roster with emails and phone numbers, every attempt and report
// (multi-tenancy audit F-2). `requireTenantRole` publishes the role held in THIS
// tenant as `req.tenantRole`; that is the only role a route handler may use.
//
// This walks the route files rather than testing handlers one by one, so a new
// route that reintroduces the pattern fails here without anyone writing a test.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name.endsWith('.routes.ts') ? [full] : []
  })
}

// Comments may explain the rule by naming `req.user.role`; only code counts.
// Block comments keep their newlines so reported line numbers stay accurate.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '')
}

describe('route handlers — tenant role, not account role', () => {
  const files = routeFiles(SRC)

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('CRITICAL: no *.routes.ts reads user.role', () => {
    const offenders = files.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\buser\s*[!?]?\.\s*role\b/.test(line))
        .map(({ line, n }) => `${relative(SRC, file)}:${n}  ${line.trim()}`),
    )
    expect(offenders).toEqual([])
  })
})
