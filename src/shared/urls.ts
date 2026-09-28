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

/**
 * Absolute URL of a page on a tenant's subdomain.
 *
 *   tenantUrl('niazi', '/coaching/teachers')
 *     dev  -> http://niazi.lvh.me:3000/coaching/teachers
 *     prod -> https://niazi.gyaanverse.com/coaching/teachers
 *
 * Mirrors the frontend's `buildTenantUrl` (frontend/src/lib/domain.ts) so a
 * link built here and the one a user copies from the dashboard UI are
 * byte-identical. FRONTEND_URL's host is the app/landing host (e.g.
 * `app.lvh.me`, or the bare apex in prod) — stripping a leading "app." label
 * recovers the shared root the same way the frontend derives it by stripping
 * the leftmost label off `window.location.hostname`.
 */
export function tenantUrl(slug: string, path = '/'): string {
  const { protocol, host } = new URL(env.FRONTEND_URL)
  const root = host.startsWith('app.') ? host.slice(4) : host
  return `${protocol}//${slug}.${root}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Turns a notification's `link` (stored as a bare frontend path, used as-is
 * for in-app navigation) into an absolute URL for the one channel that needs
 * one: email. Tenant-scoped notifications resolve onto that tenant's
 * subdomain via `tenantUrl`, matching what the dashboard UI would show for
 * the same destination; platform-level ones (no tenant) fall back to the app
 * host. Already-absolute links (e.g. an invite link built before the
 * notification is dispatched) pass through unchanged.
 */
export function notificationLinkUrl(link: string, tenantSlug: string | null): string {
  if (/^https?:\/\//i.test(link)) return link
  return tenantSlug ? tenantUrl(tenantSlug, link) : appUrl(link)
}
