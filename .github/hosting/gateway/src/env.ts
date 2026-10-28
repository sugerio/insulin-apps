/**
 * What the Worker receives. The deploy pipeline generates the wrangler config from the binding table in the hosting brief
 * (section 3.1), so these names are a contract: keep them in step with `.github/hosting/README.md`. Everything is optional
 * here because `loadConfig` checks it at runtime and fails closed.
 */
export interface Env {
  /** The gateway's D1 database. */
  DB?: D1Database
  /** Cloudflare Email Service (`send_email`). Not needed when SITE_ENV=test, which captures mail in D1 instead. */
  EMAIL?: SendEmail
  /** Per-IP and per-email throttles on the auth endpoints. */
  RL_AUTH?: RateLimit
  /** Per-user throttle on proxied app requests. */
  RL_APP?: RateLimit

  SITE_DOMAIN?: string
  /** JSON: [{ name, title, summary, binding, source }]. A wrangler `vars` object arrives already parsed. */
  SITE_APPS?: unknown
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
  /** `Name <address>` or a bare address. */
  EMAIL_FROM?: string
  /** Optional contact address shown on the landing, privacy and terms pages. */
  SUPPORT_EMAIL?: string
  /** Local development and tests only (`test`); the deploy never sets it. */
  SITE_ENV?: string

  /** One service binding per app: APP_<NAME>. */
  [binding: `APP_${string}`]: Fetcher | undefined
}
