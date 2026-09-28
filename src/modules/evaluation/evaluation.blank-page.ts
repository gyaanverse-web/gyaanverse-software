import { env } from '@config/env.js'

/**
 * Written to `question_results.auto_zero_reason` whenever this detector is the
 * reason a row got its score. The one value the blank-page audit queries filter
 * on — see evaluation.blank-page-audit.ts.
 */
export const BLANK_PAGE_AUTO_ZERO_REASON = 'blank_page_detector'

// ── THE BLANK-PAGE DETECTOR — pixel-only, no OCR, no AI call ──────────────
//
// A separate, much smaller engine (`AI_Engines/engines/image_processing`)
// answers exactly one question with OpenCV, locally, in milliseconds: does
// this image have anything written on it at all. It runs no OCR and calls no
// LLM, so it costs nothing and cannot be slow the way the grading engine can.
//
// WHY THIS EXISTS: before this, "is this page blank?" was only ever answered
// the expensive way — three full OCR calls coming back empty
// (`UNGRADEABLE_ATTEMPTS` in evaluation.retry.ts) before the paper was even
// suspected of being blank. This lets `processJob` (evaluation.service.ts)
// resolve a genuinely blank page immediately, with a real score of 0, instead
// of burning three OCR round-trips first.
//
// THE ONE RULE THAT MAKES THIS SAFE TO AUTO-SCORE:
// `isConfirmedBlankPage` only ever returns `true` on an explicit, successful
// `contains_text: false` from the detector. Every other outcome — a network
// error, a timeout, a malformed response, the engine being down — returns
// `false`. A failure here must never manufacture a 0; it just means "we don't
// know", and the caller falls back to the existing OCR-retry → needs_human →
// backstop path, which was already safe. This function is not allowed to make
// grading *less* safe, only faster in the one case it can prove.

async function callBlankPageEngine(source: string): Promise<boolean | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.BLANK_PAGE_ENGINE_TIMEOUT_MS)

  try {
    const res = await fetch(`${env.BLANK_PAGE_ENGINE_URL}/contains_text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_source: source }),
      signal: controller.signal,
    })
    if (!res.ok) return null

    const parsed: unknown = await res.json()
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'contains_text' in parsed &&
      typeof (parsed as { contains_text: unknown }).contains_text === 'boolean'
    ) {
      return (parsed as { contains_text: boolean }).contains_text
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * True only when the pixel detector explicitly confirms there is nothing
 * written on the page. Never throws — see the file header for why every
 * failure mode returns `false` instead.
 */
export async function isConfirmedBlankPage(source: string): Promise<boolean> {
  const containsText = await callBlankPageEngine(source)
  return containsText === false
}
