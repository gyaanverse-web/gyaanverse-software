import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '@shared/db.js'
import { ocrImage } from './evaluation.engine.js'
import { ocrCache } from './evaluation.schema.js'
import type { EngineOcrStep } from './evaluation.types.js'

// ── READING THE STUDENT'S HANDWRITING (OCR) ───────────────────────────────
//
// OCR = turning a photo of handwriting into text. It is the expensive half of
// grading, and its answer never changes for the same photo.
//
// So: one OCR call per image, EVER. The result is saved in the `ocr_cache`
// table and reused. This is what makes 50 retries affordable — a job that dies
// during the grading step re-reads nothing when it comes back.
//
// Real example that led to this: one answer whose grading step kept failing
// billed 50 OCR calls for a page that had already been read perfectly the first
// time (observed live, 2026-08-12).

/**
 * Did OCR actually read anything?
 *
 * WATCH OUT: a blank or unreadable page does NOT come back as an empty list.
 * The real engine returns one step whose `text` is empty (verified against the
 * live engine, 2026-08-12).
 *
 * So checking "is the list empty?" would let an unreadable paper straight
 * through to the grader, which then scores it 0 — and once that 0 is saved it
 * looks identical to "the student answered and got everything wrong".
 *
 * That is why this checks the TEXT, not the length of the list.
 */
export function hasGradeableText(steps: EngineOcrStep[]): boolean {
  return steps.some((s) => (s.text ?? '').trim().length > 0)
}

function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

export interface CachedOcr {
  steps: EngineOcrStep[]
  /** True when we reused a saved read and did NOT call the AI engine. */
  cached: boolean
}

/**
 * Read an image, reusing a previous read of the same image when we have one.
 *
 * TWO RULES KEEP THIS HONEST:
 *
 * 1. **Only readable results are saved.** A read that came back blank might be
 *    a genuinely blank page — or the engine having a bad minute. Saving it
 *    would make that verdict permanent and quietly cancel the 3 re-reads
 *    (`UNGRADEABLE_ATTEMPTS`) that are supposed to tell those two apart.
 *
 * 2. **The cache can never break the job.** Every database touch here is wrapped
 *    in try/catch. A corrupted row or an unreachable `ocr_cache` table costs one
 *    extra AI call — never a failed evaluation.
 */
export async function ocrImageCached(source: string): Promise<CachedOcr> {
  const hash = sourceHash(source)

  try {
    const [hit] = await db
      .select({ id: ocrCache.id, ocrData: ocrCache.ocrData })
      .from(ocrCache)
      .where(eq(ocrCache.sourceHash, hash))
      .limit(1)

    if (hit) {
      const steps = parseSteps(hit.ocrData)
      // A saved row that no longer reads as valid JSON, or that somehow holds a
      // blank read, is treated as if it were not there at all. The fresh read
      // below then overwrites it.
      if (steps && hasGradeableText(steps)) {
        await db
          .update(ocrCache)
          .set({ hits: sql`${ocrCache.hits} + 1`, lastUsedAt: new Date() })
          .where(eq(ocrCache.id, hit.id))
        return { steps, cached: true }
      }
    }
  } catch (err) {
    console.error('[evaluation] OCR cache read failed, calling engine:', err)
  }

  const steps = await ocrImage(source)

  if (hasGradeableText(steps)) {
    try {
      await db
        .insert(ocrCache)
        .values({ sourceHash: hash, source, ocrData: JSON.stringify(steps) })
        .onConflictDoUpdate({
          target: ocrCache.sourceHash,
          set: { ocrData: JSON.stringify(steps), lastUsedAt: new Date() },
        })
    } catch (err) {
      console.error('[evaluation] OCR cache write failed (result still used):', err)
    }
  }

  return { steps, cached: false }
}

function parseSteps(raw: string): EngineOcrStep[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as EngineOcrStep[]) : null
  } catch {
    return null
  }
}
