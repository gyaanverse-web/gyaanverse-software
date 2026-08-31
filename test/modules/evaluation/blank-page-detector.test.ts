import { describe, it, expect, vi, afterEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// `isConfirmedBlankPage` (evaluation.blank-page.ts) is a thin fetch client with
// one contract: only `true` on an explicit, successful `contains_text: false`.
// Every other outcome — network error, non-200, bad JSON, a missing field — is
// `false`. Getting that wrong either auto-zeroes a real answer (false positive)
// or just falls back to the existing OCR-retry path (false negative, safe), so
// every failure mode gets its own assertion.
//
// This file never mocks `evaluation.blank-page.js` itself — it exercises the
// real implementation against a stubbed `fetch`. (Kept separate from the
// `processJob` wiring tests, which mock this module wholesale — `vi.mock` is
// hoisted file-wide, so the two approaches cannot share a file.)
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
})

async function callWith(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock)
  const { isConfirmedBlankPage } = await import('@modules/evaluation/evaluation.blank-page.js')
  return isConfirmedBlankPage('https://cdn.test/answers/a1.jpg')
}

describe('isConfirmedBlankPage', () => {
  it('true only on an explicit contains_text: false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ contains_text: false }),
    })
    expect(await callWith(fetchMock)).toBe(true)
  })

  it('false when the detector finds text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ contains_text: true }),
    })
    expect(await callWith(fetchMock)).toBe(false)
  })

  it('CRITICAL: false, never throws, when the engine is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5000'))
    expect(await callWith(fetchMock)).toBe(false)
  })

  it('CRITICAL: false on a non-200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    expect(await callWith(fetchMock)).toBe(false)
  })

  it('CRITICAL: false on a malformed or missing contains_text field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oops: true }) })
    expect(await callWith(fetchMock)).toBe(false)
  })

  it('CRITICAL: false if the response body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })
    expect(await callWith(fetchMock)).toBe(false)
  })
})
