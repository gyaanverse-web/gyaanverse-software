import { env } from '../config/env.js'

/**
 * Absolute URL of a page on the frontend.
 *
 *   appUrl('/verify-email')  dev  -> http://app.lvh.me:3000/verify-email
 *                            prod -> https://gyaanverse.com/verify-email
 *
 * Use this for every link that ends up in an email or SMS. Relative paths are
 * resolved by the browser against whatever origin served the redirect — which
 * for Better Auth callbacks is the API host, where no such page exists.
 */
export function appUrl(path = '/'): string {
  return `${env.FRONTEND_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Better Auth builds its own verification / reset links as
 * `<apiBase>/<action>?...&callbackURL=<x>` and defaults `callbackURL` to the
 * relative "/". After consuming the token it 302s the browser straight to that
 * value, so a relative default lands the user on the API root (404 JSON).
 *
 * We can't configure that default away, so we rewrite the query param on the
 * URL Better Auth hands us, pinning it to an absolute frontend page.
 *
 * Note: the target must be inside `trustedOrigins` (see config/auth.ts) or
 * Better Auth's originCheck rejects the callback with INVALID_CALLBACK_URL.
 */
export function withFrontendCallback(betterAuthUrl: string, path: string): string {
  const url = new URL(betterAuthUrl)
  url.searchParams.set('callbackURL', appUrl(path))
  return url.toString()
}
