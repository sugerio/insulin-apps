// Reads and checks the Worker's configuration once per isolate. Anything required that is missing or malformed makes
// the whole gateway answer 503 (index.ts): it fails closed and never guesses.
import type { Env } from './env.ts'
import { log } from './log.ts'
import { cleanText, normalizeEmail, truncate } from './validate.ts'

export interface HostedApp {
  /** Subdomain and app directory name, e.g. `captable`. */
  name: string
  title: string
  summary: string
  /** Source code link (https), or null. */
  source: string | null
  /** `APP_<NAME>` */
  binding: string
  /** `<name>.<SITE_DOMAIN>` */
  host: string
  /** `insulin-apps-<name>`, sent as x-suger-app-id. */
  appId: string
  /** The service binding, or null when the app is not deployed yet (its host then answers 503). */
  service: Fetcher | null
}

export interface Config {
  domain: string
  authHost: string
  apps: HostedApp[]
  appsByHost: Map<string, HostedApp>
  google: { clientId: string; clientSecret: string } | null
  turnstile: { siteKey: string; secretKey: string }
  mailFrom: { email: string; name: string }
  /** SUPPORT_EMAIL, or null: the pages then point to the repository's issues. */
  supportEmail: string | null
  /** `https://github.com/<owner>/<repo>/issues`, from the apps' source links, or null. */
  issuesUrl: string | null
  /** `https://github.com/<owner>/<repo>`, the repository those links point into, or null. */
  repositoryUrl: string | null
  /** SITE_ENV=test: capture mail in D1 and relax cookie rules on http://*.localhost. Never set by the deploy. */
  testMode: boolean
  db: D1Database
  /** Null in test mode, where mail goes to the `mail_capture` table instead. */
  email: SendEmail | null
  rlAuth: RateLimit
  rlApp: RateLimit
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] }

export const RESERVED_APP_NAMES = new Set([
  'auth', 'www', 'api', 'admin', 'app', 'apps', 'mail', 'email', 'cf-bounce', 'gateway', 'static', 'assets',
  'status', 'docs', 'help', 'support',
])

const DEFAULT_SENDER_NAME = 'Insulin Apps'
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export function isAppName(name: unknown): name is string {
  return typeof name === 'string' && /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/.test(name) && !RESERVED_APP_NAMES.has(name)
}

export function bindingName(app: string): string {
  return `APP_${app.toUpperCase().replaceAll('-', '_')}`
}

/** `Name <address>` or a bare address. */
export function parseSender(input: unknown): { email: string; name: string } | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  const named = /^(.*?)\s*<([^<>\s]+)>$/.exec(text)
  const email = normalizeEmail(named ? named[2] : text)
  if (!email) return null
  const name = named ? cleanText(named[1]!.replace(/^"(.*)"$/, '$1')) : ''
  return { email, name: name || DEFAULT_SENDER_NAME }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** The GitHub repository the apps' source links point into. */
export function repositoryUrlFrom(apps: HostedApp[]): string | null {
  for (const app of apps) {
    if (!app.source) continue
    const url = new URL(app.source)
    const [owner, repo] = url.pathname.split('/').filter(Boolean)
    if (url.hostname === 'github.com' && owner && repo) return `https://github.com/${owner}/${repo}`
  }
  return null
}

/** The issue tracker of that repository. */
export function issuesUrlFrom(apps: HostedApp[]): string | null {
  const repository = repositoryUrlFrom(apps)
  return repository ? `${repository}/issues` : null
}

function hasMethod(value: unknown, method: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[method] === 'function'
}

function parseApps(env: Env, domain: string, problems: string[]): HostedApp[] {
  let raw = env.SITE_APPS
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      problems.push('SITE_APPS (not valid JSON)')
      return []
    }
  }
  if (!Array.isArray(raw)) {
    problems.push('SITE_APPS (expected a JSON array)')
    return []
  }
  const apps: HostedApp[] = []
  raw.forEach((entry: unknown, index) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const name = item.name
    if (!isAppName(name)) {
      problems.push(`SITE_APPS[${index}].name`)
      return
    }
    if (apps.some((app) => app.name === name)) {
      problems.push(`SITE_APPS[${index}].name (duplicate)`)
      return
    }
    const binding = bindingName(name)
    if (item.binding !== undefined && item.binding !== binding) {
      problems.push(`SITE_APPS[${index}].binding (expected ${binding})`)
      return
    }
    const service = env[binding as `APP_${string}`]
    if (!hasMethod(service, 'fetch')) log('config_app_binding_missing', { app: name, binding })
    apps.push({
      name,
      title: truncate(cleanText(item.title), 80) || name,
      summary: truncate(cleanText(item.summary), 300),
      source: httpsUrl(item.source),
      binding,
      host: `${name}.${domain}`,
      appId: `insulin-apps-${name}`,
      service: hasMethod(service, 'fetch') ? (service as Fetcher) : null,
    })
  })
  return apps
}

export function readConfig(env: Env): ConfigResult {
  const problems: string[] = []

  const domain = text(env.SITE_DOMAIN).toLowerCase()
  if (!HOSTNAME.test(domain)) problems.push('SITE_DOMAIN')

  // Test mode captures mail, skips Turnstile's hostname check and relaxes cookies, so it is refused anywhere but a
  // local development domain: a stray SITE_ENV (a leftover secret, say) on a real domain fails closed.
  const siteEnv = text(env.SITE_ENV)
  const testMode = siteEnv === 'test' && domain.endsWith('.localhost')
  if (siteEnv && !testMode) problems.push('SITE_ENV (only "test", and only with a .localhost SITE_DOMAIN)')
  const apps = HOSTNAME.test(domain) ? parseApps(env, domain, problems) : []

  const googleClientId = text(env.GOOGLE_CLIENT_ID)
  const googleClientSecret = text(env.GOOGLE_CLIENT_SECRET)
  if (googleClientId && !googleClientSecret) problems.push('GOOGLE_CLIENT_SECRET (required when GOOGLE_CLIENT_ID is set)')

  const siteKey = text(env.TURNSTILE_SITE_KEY)
  const secretKey = text(env.TURNSTILE_SECRET_KEY)
  if (!siteKey) problems.push('TURNSTILE_SITE_KEY')
  if (!secretKey) problems.push('TURNSTILE_SECRET_KEY')

  const mailFrom = parseSender(env.EMAIL_FROM)
  if (!mailFrom) problems.push('EMAIL_FROM')

  // Optional: an unusable value is ignored (and logged) rather than taking the site down.
  const supportEmail = text(env.SUPPORT_EMAIL) ? normalizeEmail(env.SUPPORT_EMAIL) : null
  if (text(env.SUPPORT_EMAIL) && !supportEmail) log('config_support_email_ignored')

  if (!hasMethod(env.DB, 'prepare')) problems.push('DB')
  if (!testMode && !hasMethod(env.EMAIL, 'send')) problems.push('EMAIL')
  if (!hasMethod(env.RL_AUTH, 'limit')) problems.push('RL_AUTH')
  if (!hasMethod(env.RL_APP, 'limit')) problems.push('RL_APP')

  if (problems.length || !mailFrom) return { ok: false, problems }
  return {
    ok: true,
    config: {
      domain,
      authHost: `auth.${domain}`,
      apps,
      appsByHost: new Map(apps.map((app) => [app.host, app])),
      google: googleClientId ? { clientId: googleClientId, clientSecret: googleClientSecret } : null,
      turnstile: { siteKey, secretKey },
      mailFrom,
      supportEmail,
      issuesUrl: issuesUrlFrom(apps),
      repositoryUrl: repositoryUrlFrom(apps),
      testMode,
      db: env.DB!,
      email: testMode ? null : env.EMAIL!,
      rlAuth: env.RL_AUTH!,
      rlApp: env.RL_APP!,
    },
  }
}

const cache = new WeakMap<object, ConfigResult>()

/** The configuration for this isolate's env, read once; problems are logged once, by name only. */
export function loadConfig(env: Env): ConfigResult {
  let result = cache.get(env)
  if (!result) {
    result = readConfig(env)
    cache.set(env, result)
    if (!result.ok) log('config_invalid', { problems: result.problems.join(', ') })
  }
  return result
}
