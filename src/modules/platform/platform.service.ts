import { eq } from 'drizzle-orm'
import { db } from '../../shared/db.js'
import { platformSettings } from './platform.schema.js'

// ─────────────────────────────────────────────────────────────────────────────
// Platform switches.
//
// One switch today — `billing_enabled` — but the shape is the point. A switch
// here is global, operator-owned, and flipped at RUNTIME from the ops panel,
// which rules out the two things that would otherwise be reached for first:
//
//   * An env var. Flipping it needs a redeploy of api AND worker, and Railway
//     resolves `${{...}}` references at deploy time (see the stale-credentials
//     incident) — so "turn billing off" becomes a two-service coordinated
//     restart at exactly the moment someone wants it to be one click.
//   * Redis. A flush wipes it. This project has already lost a repeatable
//     schedule to a Redis flush once; a *billing* switch silently reverting to
//     its default is a worse version of that bug.
//
// So: Postgres, read through a short in-memory cache.
// ─────────────────────────────────────────────────────────────────────────────

export const PLATFORM_KEYS = ['billing_enabled'] as const
export type PlatformKey = (typeof PLATFORM_KEYS)[number]

export interface PlatformSettings {
  /**
   * Is the billing product live?
   *
   * `false` (the default, and the MVP posture) means: no plan limit is ever
   * enforced, no feature is ever gated on a plan, every billing route answers
   * 404, and the frontend hides plan/billing UI entirely. It does NOT mean
   * `tenants.plan` stops existing — the column keeps its value so that turning
   * billing on later restores each coaching to the plan it was already on.
   */
  billing_enabled: boolean
}

/**
 * What a fresh database answers.
 *
 * Defaults to billing OFF on purpose. A missing row is most likely a database
 * that has not been configured yet, and the safe failure for a young product is
 * "nobody gets charged and nothing is blocked", not "every coaching is suddenly
 * capped at the free tier".
 */
const DEFAULTS: PlatformSettings = {
  billing_enabled: false,
}

/**
 * A cache, not a cache-invalidation protocol.
 *
 * Three processes read these (api, worker, and any script), and only the api
 * writes them. Rather than a Redis pub/sub channel to push a flip to the
 * others — more moving parts than the feature deserves, and one more thing to
 * fail closed — every reader simply re-reads at most this often. The writer
 * clears its own copy synchronously, so the operator who flipped the switch
 * sees it immediately on the next request; everyone else converges within the
 * window.
 *
 * Fifteen seconds is chosen against the *worst* case: a coaching keeps
 * unlimited quotas for up to fifteen seconds after billing is switched on. That
 * is a rounding error against a monthly plan.
 */
const CACHE_TTL_MS = 15_000

let cache: { value: PlatformSettings; at: number } | null = null

async function load(): Promise<PlatformSettings> {
  const rows = await db.select().from(platformSettings)
  const settings = { ...DEFAULTS }

  for (const row of rows) {
    if (!(PLATFORM_KEYS as readonly string[]).includes(row.key)) continue
    // The column is jsonb, so a hand-edited row can hold anything. A malformed
    // value falls back to the default rather than propagating `undefined` into
    // an `if` somewhere downstream, where it would read as "off" by accident
    // rather than by decision.
    if (row.key === 'billing_enabled' && typeof row.value === 'boolean') {
      settings.billing_enabled = row.value
    }
  }

  return settings
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  try {
    const value = await load()
    cache = { value, at: Date.now() }
    return value
  } catch (err) {
    // Fail to the last known good answer, then to the defaults. A blip on this
    // table must not take down every route that checks a quota — which, via
    // `resolveEntitlements`, is most of the write surface.
    console.error('[platform] failed to read settings; using last known value', err)
    return cache?.value ?? DEFAULTS
  }
}

export async function isBillingEnabled(): Promise<boolean> {
  return (await getPlatformSettings()).billing_enabled
}

export async function setPlatformSetting(
  key: PlatformKey,
  value: boolean,
  actorId: string,
): Promise<PlatformSettings> {
  await db
    .insert(platformSettings)
    .values({ key, value, updatedBy: actorId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, updatedBy: actorId, updatedAt: new Date() },
    })

  cache = null
  return getPlatformSettings()
}

/** Test seam. Nothing in `src/` should need this. */
export function __clearPlatformCache(): void {
  cache = null
}
