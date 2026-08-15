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
 * Absolute URL of a frontend page carrying a one-time token.
 *
 *   appTokenUrl('/verify-email', tok) -> https://app.gyaanverse.com/verify-email?token=<tok>
 *
 * Every emailed link must be built this way and NOT point at the API, even
 * though only the API can consume the token — the landing page calls the API
 * itself. Better Auth hands us `<apiBase>/<action>?token=…&callbackURL=<url>`
 * and we deliberately throw that URL away, because mailing it got users a
 * full-page Google Safe Browsing "dangerous site" interstitial:
 *
 *   - a URL-encoded URL sitting in a query param is the open-redirect shape
 *     every credential-phishing kit uses, and classifiers weight it heavily
 *     without caring that both hosts are ours;
 *   - `api.gyaanverse.com` serves only JSON and 302s, so it reads as a bare
 *     redirector rather than a site;
 *   - the link domain didn't match the brand the user just signed up on.
 *
 * The warning was intermittent because verdicts are per-URL and every token
 * makes a new one — so this is not something a one-off review request fixes.
 */
export function appTokenUrl(path: string, token: string): string {
  return `${appUrl(path)}?token=${encodeURIComponent(token)}`
}
