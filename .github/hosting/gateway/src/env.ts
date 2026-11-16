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
  /** Per-IP throttle on requests to an app's public paths that aren't GET or HEAD, on top of RL_APP's. */
  RL_PUBLIC?: RateLimit
  /**
   * Workers Static Assets: the docs' images (.github/hosting/docs/assets/), with run_worker_first so the gateway handles
   * every request and serves only /docs/assets/* from it (src/docs.ts). Without it the docs show no images.
   */
  DOCS_ASSETS?: Fetcher

  SITE_DOMAIN?: string
  /**
   * JSON: [{ name, title, summary, binding, source, permissions, publicPaths, scheduled }]. A wrangler `vars` object
   * arrives already parsed.
   */
  SITE_APPS?: unknown
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
  /** `Name <address>` or a bare address. */
  EMAIL_FROM?: string
  /** Optional contact address shown on the landing, privacy and terms pages. */
  SUPPORT_EMAIL?: string
  /**
   * Optional address of Insulin Apps support that receives requests for more organizations (DESIGN.md §3.1); an
   * e-mail address, or it is ignored.
   */
  ORG_REQUEST_EMAIL?: string
  /** Base64 of 32 random bytes: encrypts stored secrets and derives the apps' integration tokens. Optional. */
  GATEWAY_SECRET_KEY?: string
  /** Local development and tests only (`test`); the deploy never sets it. */
  SITE_ENV?: string

  /**
   * The operator console at /super (DESIGN.md §11): the platform's Google Workspace SAML app (its entity id, its
   * sign-in URL and its signing certificate, PEM), the Google group whose members may sign in, and the admins among
   * them (addresses separated by commas or whitespace). GitHub variables, never written in the repository.
   */
  SUPER_SAML_IDP_ENTITY_ID?: string
  SUPER_SAML_IDP_SSO_URL?: string
  SUPER_SAML_IDP_CERT?: string
  SUPER_GOOGLE_GROUP?: string
  SUPER_ADMIN_EMAILS?: string
  /** The console's read-only Cloudflare API token (a secret) and the account it reads (DESIGN.md §11.5). */
  SUPER_CLOUDFLARE_API_TOKEN?: string
  SUPER_CLOUDFLARE_ACCOUNT_ID?: string

  /** One service binding per app: APP_<NAME>. */
  [binding: `APP_${string}`]: Fetcher | undefined
}
