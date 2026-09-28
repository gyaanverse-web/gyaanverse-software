/**
 * Tenant slug rules — the single source of truth.
 *
 * A tenant slug becomes a DNS label (`<slug>.gyaanverse.com`), so it is bound
 * by two separate constraints that used to live in three places and disagree:
 *
 *   1. It must be a legal hostname label.
 *   2. It must not collide with a subdomain the platform itself uses, or one an
 *      attacker could use to look like the platform.
 *
 * Both the registration guard (`tenant.service.ts`) and the host→tenant
 * resolver (`tenant.middleware.ts`) import from here, so a name that cannot be
 * registered can also never resolve. `frontend/src/lib/domain.ts` mirrors
 * RESERVED_SLUGS for client-side host resolution — keep the two in step.
 */

export const SLUG_MIN_LENGTH = 3
/** DNS labels are capped at 63 octets. */
export const SLUG_MAX_LENGTH = 63

/**
 * Hostname-label shape: lowercase alphanumerics and inner hyphens only.
 * Deliberately stricter than the old `^[a-z0-9-]+$`, which accepted `-abc`,
 * `abc-` and a bare `-` — all of which are invalid DNS labels and would have
 * produced a tenant that could never be reached.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Platform hosts and environments. `staging`/`preview` are kept reserved even
  // though those environments are gone — the names should stay unavailable.
  'app', 'api', 'www', 'admin', 'ops', 'internal', 'auth', 'login', 'logout',
  'signin', 'signup', 'register', 'account', 'accounts', 'dashboard', 'portal',
  'staging', 'preview', 'production', 'prod', 'dev', 'development', 'test',
  'testing', 'demo', 'sandbox', 'local', 'localhost', 'beta', 'alpha',

  // Infrastructure and asset hosts.
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'uploads',
  'download', 'downloads', 'storage', 'db', 'database', 'redis', 'queue',
  'queues', 'worker', 'cache', 'proxy', 'gateway', 'router',

  // Mail and DNS — registering these would break or hijack real delivery.
  'mail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'webmail', 'send',
  'bounce', 'bounces', 'noreply', 'no-reply', 'postmaster', 'hostmaster',
  'abuse', 'ns', 'ns1', 'ns2', 'ns3', 'ns4', 'dns', 'ftp', 'sftp', 'vpn',

  // Phishing-adjacent names. A tenant at `secure.gyaanverse.com` or
  // `verify.gyaanverse.com` would carry the platform's own domain authority.
  'secure', 'security', 'ssl', 'tls', 'verify', 'verification', 'validate',
  'confirm', 'update', 'billing', 'payment', 'payments', 'pay', 'checkout',
  'invoice', 'invoices', 'refund', 'wallet', 'bank', 'my', 'me', 'user',
  'users', 'profile', 'password', 'reset', 'token', 'oauth', 'sso', 'saml',

  // Marketing and content surfaces we may want to claim later.
  'blog', 'news', 'help', 'support', 'docs', 'doc', 'documentation', 'status',
  'about', 'contact', 'careers', 'jobs', 'legal', 'privacy', 'terms', 'press',
  'partners', 'pricing', 'plans', 'store', 'shop', 'community', 'forum',
  'events', 'webinar', 'academy', 'learn', 'courses',

  // Observability and tooling.
  'metrics', 'monitor', 'monitoring', 'health', 'healthz', 'grafana', 'kibana',
  'sentry', 'logs', 'log', 'trace', 'debug', 'ci', 'cd', 'build', 'git',
  'jenkins', 'runner', 'webhook', 'webhooks', 'callback', 'callbacks',

  // Generic/system words that read as platform routes rather than a coaching.
  'root', 'system', 'sys', 'config', 'settings', 'setup', 'onboarding', 'new',
  'edit', 'create', 'delete', 'remove', 'null', 'undefined', 'none', 'true',
  'false', 'example', 'sample', 'default', 'public', 'private', 'index',

  // Brand names, including the common misspelling of our own domain.
  'gyaanverse', 'gyanverse', 'gyaan', 'gyan',
])

/**
 * Returns a human-readable reason the slug is unusable, or `null` when it is
 * acceptable. Callers map the reason onto their own error type.
 */
export function slugRejectionReason(slug: string): string | null {
  if (slug.length < SLUG_MIN_LENGTH) {
    return `Slug must be at least ${SLUG_MIN_LENGTH} characters`
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    return `Slug must be at most ${SLUG_MAX_LENGTH} characters`
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'Slug must be lowercase letters, numbers, and inner hyphens only, and cannot start or end with a hyphen'
  }
  // `xn--` is the IDN/punycode prefix; a literal one lets a slug render as
  // arbitrary Unicode in the address bar, which is a homograph-spoofing vector.
  if (slug.startsWith('xn--')) {
    return 'Slug cannot start with "xn--"'
  }
  if (RESERVED_SLUGS.has(slug)) {
    return 'That slug is reserved'
  }
  return null
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug)
}
