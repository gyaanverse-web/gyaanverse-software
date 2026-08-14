import { describe, it, expect } from 'vitest'
import { checkSurfaceAccess, parseIpAllowlist } from '@config/ops-surface.js'

// ─────────────────────────────────────────────────────────────────────────────
// The guard on every operator surface — `/queues` today, `/docs` alongside it.
//
// Bull Board is a WRITE surface: the UI retries, promotes and deletes jobs,
// across every tenant, with no audit trail. Mounting it in production is worth
// doing — it is the only window onto the five queues the operator panel does
// not cover — but only behind a gate that is worth testing rather than eyeballed.
// The API reader is read-only, but it is the same gate, so one set of tests
// covers both.
//
// `checkSurfaceAccess` is a pure function precisely so these cases can be
// asserted directly instead of through HTTP fixtures. The interesting ones are
// all edge cases: a colon in a password, an IPv6-mapped address, a right
// password with the wrong username.
// ─────────────────────────────────────────────────────────────────────────────

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

const defaults = {
  ip: '203.0.113.9',
  user: 'ops',
  password: 'correct-horse',
  allowedIps: [] as string[],
}

const check = (overrides: Partial<Parameters<typeof checkSurfaceAccess>[0]> = {}) =>
  checkSurfaceAccess({ authorization: undefined, ...defaults, ...overrides })

describe('checkSurfaceAccess — credentials', () => {
  it('admits the configured user and password', () => {
    expect(check({ authorization: basic('ops', 'correct-horse') })).toEqual({ ok: true })
  })

  it('rejects a missing Authorization header with 401', () => {
    expect(check()).toEqual({ ok: false, status: 401 })
  })

  it('rejects the wrong password', () => {
    expect(check({ authorization: basic('ops', 'wrong') })).toEqual({ ok: false, status: 401 })
  })

  it('rejects the right password under the wrong username', () => {
    expect(check({ authorization: basic('admin', 'correct-horse') })).toEqual({
      ok: false,
      status: 401,
    })
  })

  it('rejects a non-Basic scheme', () => {
    expect(check({ authorization: 'Bearer correct-horse' })).toEqual({ ok: false, status: 401 })
  })

  it('rejects a credential with no colon in it', () => {
    const authorization = `Basic ${Buffer.from('justausername').toString('base64')}`
    expect(check({ authorization })).toEqual({ ok: false, status: 401 })
  })

  it('accepts a password containing colons', () => {
    // `split(':')` would truncate this to `a` and admit the wrong secret.
    const password = 'a:b:c'
    expect(check({ password, authorization: basic('ops', password) })).toEqual({ ok: true })
    expect(check({ password, authorization: basic('ops', 'a') })).toEqual({
      ok: false,
      status: 401,
    })
  })

  it('skips the credential check when no password is configured', () => {
    // Dev, where the surface is unguarded. Production never reaches here —
    // `mountOpsSurface` refuses to mount at all without a password.
    expect(check({ password: '' })).toEqual({ ok: true })
  })
})

describe('checkSurfaceAccess — IP allowlist', () => {
  it('is inert when empty', () => {
    expect(check({ allowedIps: [], authorization: basic('ops', 'correct-horse') })).toEqual({
      ok: true,
    })
  })

  it('admits a listed address', () => {
    expect(
      check({ allowedIps: ['203.0.113.9'], authorization: basic('ops', 'correct-horse') }),
    ).toEqual({ ok: true })
  })

  it('gives an unlisted address 404, not 403, even with valid credentials', () => {
    // There is no reason to tell an address that already failed the allowlist
    // that a queue console lives at this path.
    expect(
      check({
        ip: '198.51.100.4',
        allowedIps: ['203.0.113.9'],
        authorization: basic('ops', 'correct-horse'),
      }),
    ).toEqual({ ok: false, status: 404 })
  })

  it('matches an IPv4-mapped IPv6 address against an IPv4 allowlist entry', () => {
    // Node reports `::ffff:203.0.113.9` on a dual-stack socket; nobody writes an
    // allowlist that way, and the mismatch would lock out the office IP.
    expect(
      check({
        ip: '::ffff:203.0.113.9',
        allowedIps: ['203.0.113.9'],
        authorization: basic('ops', 'correct-horse'),
      }),
    ).toEqual({ ok: true })
  })

  it('checks the address before the password, so a blocked host learns nothing', () => {
    expect(check({ ip: '198.51.100.4', allowedIps: ['203.0.113.9'] })).toEqual({
      ok: false,
      status: 404,
    })
  })
})

describe('parseIpAllowlist', () => {
  it('treats an unset variable as no allowlist at all, not as one empty entry', () => {
    // The failure this guards: `''.split(',')` is `['']`, a one-entry allowlist
    // that matches nothing — which locks every operator out of a surface that
    // was meant to be open.
    expect(parseIpAllowlist('')).toEqual([])
  })

  it('tolerates spaces and a trailing comma', () => {
    expect(parseIpAllowlist(' 203.0.113.9, 198.51.100.4 ,')).toEqual([
      '203.0.113.9',
      '198.51.100.4',
    ])
  })
})
