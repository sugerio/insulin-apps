// Reads and checks the Worker's configuration once per isolate. Anything required that is missing or malformed makes
// the whole gateway answer 503 (index.ts): it fails closed and never guesses.
import type { Env } from './env.ts'
import { log } from './log.ts'
import { isNavIconName, type NavIconName } from './nav-icons.ts'
import { parseCertificates } from './sso/saml.ts'
import { cleanText, normalizeEmail, truncate } from './validate.ts'

/** One entry of an app's permission catalog (its package.json `insulin.permissions`, DESIGN.md §2.3). */
export interface Permission {
  key: string
  label: string
  description: string
  /** The least built-in role that has it. */
  role: 'ADMIN' | 'EDITOR' | 'VIEWER'
}

/** A level-2 entry of an app's navigation manifest (`insulin.navigation`, DESIGN.md §3.2). */
export interface NavigationChild {
  key: string
  label: string
  icon: NavIconName
  /** A path on the app's host, with an optional query; never one of the gateway's paths. */
  path: string
  /** The heading shown above it, or null. */
  group: string | null
  /** The least app role that sees it. */
  role: 'ADMIN' | 'EDITOR' | 'VIEWER'
  /** The most app role that sees it (ADMIN unless the item is for lesser roles only, such as a holder's own pages). */
  maxRole: 'ADMIN' | 'EDITOR' | 'VIEWER'
}

/** A level-1 entry of an app's navigation manifest. */
export interface NavigationItem extends NavigationChild {
  children: NavigationChild[]
}

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
  /** The app's permission catalog; empty when it has none (it then has no custom roles). */
  permissions: Permission[]
  /**
   * Paths people without an account use (an Esign recipient, say), forwarded with no identity (DESIGN.md §8.1): the
   * app authenticates them with its own codes. Empty for most apps.
   */
  publicPaths: string[]
  /**
   * The path the gateway POSTs to every five minutes, with no identity (`x-suger-access-via: schedule`), so the app can
   * run its due work (DESIGN.md §8.5); null for an app that has none.
   */
  scheduled: string | null
  /**
   * The app's level 1 (DESIGN.md §3.2), which the gateway renders on the app's settings pages so they read as part of
   * the app; empty for an app without a manifest (or a SITE_APPS from before it existed).
   */
  navigation: NavigationItem[]
}

/**
 * The operator console at /super (DESIGN.md §11): the platform's own Google Workspace SAML app, the group whose members
 * may sign in, and the admins among them. Set together, or the console isn't there.
 */
export interface SuperConfig {
  idp: { entityId: string; ssoUrl: string; certificates: string[] }
  /**
   * The Google group the assertion's `groups` attribute must list, lower case: its name, which is what Google's group
   * membership mapping sends (not its address).
   */
  group: string
  /** Operators who may also suspend, disable, reinstate and create organizations: SUPER_ADMIN_EMAILS, lower case. */
  admins: ReadonlySet<string>
}

/** A read-only Cloudflare API token for the console's resource snapshot (DESIGN.md §11.5), with its account. */
export interface CloudflareConfig {
  accountId: string
  apiToken: string
}

export interface Config {
  domain: string
  /** `auth.<domain>`, where sign-in used to live: it now redirects every request to the apex. */
  authHost: string
  apps: HostedApp[]
  appsByHost: Map<string, HostedApp>
  google: { clientId: string; clientSecret: string } | null
  turnstile: { siteKey: string; secretKey: string }
  mailFrom: { email: string; name: string }
  /** SUPPORT_EMAIL, or null: the pages then point to the repository's issues. */
  supportEmail: string | null
  /**
   * ORG_REQUEST_EMAIL, or null: where requests for more organizations go (DESIGN.md §3.1). Without it, the page at the
   * limit points to the contact instead of offering the form.
   */
  orgRequestEmail: string | null
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
  /** The stricter per-IP limit on requests to public paths that change something (anything but GET and HEAD). */
  rlPublic: RateLimit
  /** GATEWAY_SECRET_KEY's 32 bytes, or null: features that encrypt or derive secrets then say they aren't set up. */
  secretKey: Uint8Array | null
  /** The operator console, or null when it isn't configured (its paths are then 404). */
  super: SuperConfig | null
  /** The console's Cloudflare snapshot, or null when it isn't configured (the console says so). */
  cloudflare: CloudflareConfig | null
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] }

export const RESERVED_APP_NAMES = new Set([
  'auth', 'www', 'api', 'admin', 'app', 'apps', 'mail', 'email', 'cf-bounce', 'gateway', 'static', 'assets',
  'status', 'docs', 'help', 'support',
  // An app's secrets are named <APP>_*; these would collide with the platform's own settings (DESIGN.md §8.3).
  'cloudflare', 'google', 'turnstile', 'github', 'site', 'suger', 'super', 'actions', 'runner',
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

const PERMISSION_KEY = /^[a-z][a-z0-9_.-]{0,63}$/
const PERMISSION_LIMIT = 50
const PUBLIC_PATH_LIMIT = 10
// Never public: the gateway's own paths on an app host and the platform's routes inside the app.
const RESERVED_PREFIXES = ['/__insulin', '/settings', '/mcp', '/.well-known', '/api/__suger']

/**
 * Paths on an app host that belong to the gateway: the app's settings addresses (People, Integrations, API access and
 * Connect AI), which redirect to the same page on the apex (router.ts).
 */
export function isGatewayAppPath(path: string): boolean {
  return /^\/settings\/(?:users|integrations|api|connect-ai)(?:\/|$)/.test(path)
}

/**
 * Why an entry of `insulin.publicPaths` is refused, or null. The same rule as .github/scripts/list-apps.mjs: a path
 * starting with `/`, without `..`, a query or a fragment, that neither is nor covers the API as a whole or a reserved
 * path (compared without regard to case).
 */
export function publicPathProblem(entry: unknown): string | null {
  if (typeof entry !== 'string' || !entry.startsWith('/') || entry.length > 200) return 'must be a path starting with /'
  if (/[?#%\\\s]/.test(entry) || entry.includes('//') || entry.split('/').some((segment) => segment === '..' || segment === '.')) {
    return 'must not hold a query, a fragment, a percent sign, a backslash, whitespace, an empty or a dot segment'
  }
  const lower = entry.toLowerCase()
  const bare = lower.replace(/\/+$/, '')
  if (bare === '' || bare === '/api') return 'must not cover every path or the whole API'
  for (const reserved of RESERVED_PREFIXES) {
    const insideReserved = bare === reserved || bare.startsWith(`${reserved}/`)
    const coversReserved = reserved.startsWith(`${bare}/`)
    if (insideReserved || coversReserved) return `must not reach ${reserved}`
  }
  return null
}

export function parsePublicPaths(raw: unknown, where: string, problems: string[]): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > PUBLIC_PATH_LIMIT) {
    problems.push(`${where} (expected an array of at most ${PUBLIC_PATH_LIMIT})`)
    return []
  }
  const paths: string[] = []
  for (const [index, entry] of raw.entries()) {
    if (publicPathProblem(entry) || paths.includes(entry as string)) {
      problems.push(`${where}[${index}]`)
      continue
    }
    paths.push(entry as string)
  }
  return paths
}

/**
 * Why an app's `insulin.scheduled` is refused, or null. The same rule as .github/scripts/list-apps.mjs: one path under
 * `/api/`, passing the rules of a public path (publicPathProblem), without a trailing slash, and neither one of the
 * app's public paths nor under one (whatever reaches it must come from the gateway's own tick).
 */
export function scheduledProblem(entry: unknown, publicPaths: string[]): string | null {
  if (typeof entry !== 'string' || !entry.startsWith('/api/') || entry.endsWith('/')) return 'must be a path under /api/, without a trailing slash'
  const problem = publicPathProblem(entry)
  if (problem) return problem
  // Compared without regard to case, so no spelling of the path is public.
  if (isPublicPath({ publicPaths: publicPaths.map((path) => path.toLowerCase()) }, entry.toLowerCase())) {
    return 'must not be one of the app\'s public paths or under one'
  }
  return null
}

export function parseScheduled(raw: unknown, publicPaths: string[], where: string, problems: string[]): string | null {
  if (raw === undefined || raw === null) return null
  if (scheduledProblem(raw, publicPaths)) {
    problems.push(where)
    return null
  }
  return raw as string
}

/**
 * Whether a request path is one of the app's public paths: equal to an entry, below an entry that ends in `/`, or
 * below `entry/`. Never a reserved path, whatever its case, and never a path whose segments hide a dot segment or a
 * slash in their encoding (such a request falls through to the normal checks).
 */
export function isPublicPath(app: Pick<HostedApp, 'publicPaths'>, path: string): boolean {
  if (!app.publicPaths.length) return false
  const lower = path.toLowerCase()
  if (RESERVED_PREFIXES.some((reserved) => lower === reserved || lower.startsWith(`${reserved}/`))) return false
  const hidden = path.split('/').some((segment) => {
    if (!segment.includes('%')) return false
    try {
      const decoded = decodeURIComponent(segment)
      return decoded === '.' || decoded === '..' || /[/\\]/.test(decoded)
    } catch {
      return true
    }
  })
  if (hidden) return false
  return app.publicPaths.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry || path.startsWith(`${entry}/`)))
}

const NAVIGATION_LIMIT = 12
const NAVIGATION_KEY = /^[a-z0-9-]{1,40}$/
const NAVIGATION_TEXT_MAX = 40
// The gateway's own paths on an app host: an app's navigation never links to them.
const NAVIGATION_RESERVED = ['/__insulin', '/settings', '/mcp', '/.well-known', '/api/__suger']

/**
 * Why a navigation item's `path` is refused, or null. The same rule as .github/scripts/list-apps.mjs: a path on the
 * app's own host, starting with a single `/`, at most 200 characters, without a backslash, whitespace, a control
 * character or a fragment; before its query, no percent sign, empty or dot segment; and not one of the gateway's paths,
 * compared without regard to case.
 */
export function navigationPathProblem(entry: unknown): string | null {
  if (typeof entry !== 'string' || !entry.startsWith('/') || entry.startsWith('//') || entry.length > 200) {
    return "must be a path on the app's host, starting with a single / (at most 200 characters)"
  }
  if (/[\\\s#\u0000-\u001f\u007f]/.test(entry)) return 'must not hold a backslash, whitespace, a control character or a fragment'
  const pathname = entry.split('?', 1)[0]!
  if (pathname.includes('%') || pathname.includes('//') || pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'must not hold a percent sign, an empty or a dot segment before its query'
  }
  const bare = pathname.toLowerCase().replace(/\/+$/, '')
  for (const reserved of NAVIGATION_RESERVED) {
    if (bare === reserved || bare.startsWith(`${reserved}/`)) return `must not be one of the gateway's paths (${reserved})`
  }
  return null
}

function navigationText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= NAVIGATION_TEXT_MAX ? text : null
}

const ROLE_ORDER = ['VIEWER', 'EDITOR', 'ADMIN'] as const

function navigationChild(raw: unknown, keys: Set<string>): NavigationChild | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const { key, icon, path } = item
  const role = item.role ?? 'VIEWER'
  const maxRole = item.maxRole ?? 'ADMIN'
  const label = navigationText(item.label)
  const group = item.group === undefined || item.group === null ? null : navigationText(item.group)
  if (typeof key !== 'string' || !NAVIGATION_KEY.test(key) || keys.has(key) || !label || !isNavIconName(icon)
    || navigationPathProblem(path) || (item.group !== undefined && item.group !== null && !group)
    || (role !== 'ADMIN' && role !== 'EDITOR' && role !== 'VIEWER') || (maxRole !== 'ADMIN' && maxRole !== 'EDITOR' && maxRole !== 'VIEWER')
    || ROLE_ORDER.indexOf(maxRole) < ROLE_ORDER.indexOf(role)) return null
  keys.add(key)
  return { key, label, icon, path: path as string, group, role, maxRole }
}

/**
 * An app's navigation manifest (DESIGN.md §3.2), as list-apps.mjs checked it: at most 12 items, each with at most 12
 * children that have no children of their own. A malformed one is a configuration problem, like the other fields.
 */
export function parseNavigation(raw: unknown, where: string, problems: string[]): NavigationItem[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > NAVIGATION_LIMIT) {
    problems.push(`${where} (expected an array of at most ${NAVIGATION_LIMIT})`)
    return []
  }
  const keys = new Set<string>()
  const items: NavigationItem[] = []
  for (const [index, entry] of raw.entries()) {
    const item = navigationChild(entry, keys)
    if (!item) {
      problems.push(`${where}[${index}]`)
      continue
    }
    const children = (entry as Record<string, unknown>).children ?? []
    if (!Array.isArray(children) || children.length > NAVIGATION_LIMIT) {
      problems.push(`${where}[${index}].children (expected an array of at most ${NAVIGATION_LIMIT})`)
      continue
    }
    const parsed: NavigationChild[] = []
    for (const [childIndex, child] of children.entries()) {
      const nested = typeof child === 'object' && child !== null && 'children' in child
      const value = nested ? null : navigationChild(child, keys)
      if (value) parsed.push(value)
      else problems.push(`${where}[${index}].children[${childIndex}]`)
    }
    items.push({ ...item, children: parsed })
  }
  return items
}

/** An app's permission catalog; a malformed one is a configuration problem (custom roles would mean the wrong thing). */
export function parsePermissions(raw: unknown, where: string, problems: string[]): Permission[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > PERMISSION_LIMIT) {
    problems.push(`${where} (expected an array of at most ${PERMISSION_LIMIT})`)
    return []
  }
  const permissions: Permission[] = []
  for (const [index, entry] of raw.entries()) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const key = item.key
    const role = item.role
    const label = truncate(cleanText(item.label), 80)
    if (typeof key !== 'string' || !PERMISSION_KEY.test(key) || permissions.some((permission) => permission.key === key)
      || (role !== 'ADMIN' && role !== 'EDITOR' && role !== 'VIEWER') || !label) {
      problems.push(`${where}[${index}]`)
      continue
    }
    permissions.push({ key, label, description: truncate(cleanText(item.description), 300), role })
  }
  return permissions
}

/** GATEWAY_SECRET_KEY: base64 of exactly 32 bytes. */
export function parseSecretKey(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const bytes = Uint8Array.from(atob(value.trim()), (char) => char.charCodeAt(0))
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
}

/**
 * The operator console's settings (DESIGN.md §11): all four SAML and group settings, or none. Set in part, or with a
 * value that can't be used, the console stays off and the names are logged; the rest of the site is unaffected, since
 * nothing a customer uses depends on it. SUPER_ADMIN_EMAILS is a list of addresses (commas or whitespace); an entry
 * that isn't one is ignored and logged.
 */
export function readSuperConfig(env: Env): SuperConfig | null {
  const entityId = text(env.SUPER_SAML_IDP_ENTITY_ID)
  const ssoUrl = httpsUrl(text(env.SUPER_SAML_IDP_SSO_URL))
  const certificates = parseCertificates(text(env.SUPER_SAML_IDP_CERT))
  // A group's name as Google sends it, compared without regard to case (super/auth.ts).
  const group = truncate(cleanText(env.SUPER_GOOGLE_GROUP), 200).toLowerCase()
  const given = [env.SUPER_SAML_IDP_ENTITY_ID, env.SUPER_SAML_IDP_SSO_URL, env.SUPER_SAML_IDP_CERT, env.SUPER_GOOGLE_GROUP].some((value) => text(value))
  if (!given) return null
  const problems = [
    entityId && entityId.length <= 1024 ? null : 'SUPER_SAML_IDP_ENTITY_ID',
    ssoUrl ? null : 'SUPER_SAML_IDP_SSO_URL',
    certificates ? null : 'SUPER_SAML_IDP_CERT',
    group ? null : 'SUPER_GOOGLE_GROUP',
  ].filter((name): name is string => name !== null)
  if (problems.length) {
    log('config_super_off', { problems: problems.join(', ') })
    return null
  }
  const admins = new Set<string>()
  for (const entry of text(env.SUPER_ADMIN_EMAILS).split(/[\s,]+/).filter(Boolean)) {
    const email = normalizeEmail(entry)
    if (email) admins.add(email)
    else log('config_super_admin_ignored')
  }
  return { idp: { entityId, ssoUrl: ssoUrl!, certificates: certificates! }, group, admins }
}

/** The console's Cloudflare token and account: both, or neither (set in part, it is off and logged). */
export function readCloudflareConfig(env: Env): CloudflareConfig | null {
  const accountId = text(env.SUPER_CLOUDFLARE_ACCOUNT_ID).toLowerCase()
  const apiToken = text(env.SUPER_CLOUDFLARE_API_TOKEN)
  if (!accountId && !apiToken) return null
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[\x21-\x7e]{20,200}$/.test(apiToken)) {
    log('config_cloudflare_off')
    return null
  }
  return { accountId, apiToken }
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
    const publicPaths = parsePublicPaths(item.publicPaths, `SITE_APPS[${index}].publicPaths`, problems)
    apps.push({
      name,
      title: truncate(cleanText(item.title), 80) || name,
      summary: truncate(cleanText(item.summary), 300),
      source: httpsUrl(item.source),
      binding,
      host: `${name}.${domain}`,
      appId: `insulin-apps-${name}`,
      service: hasMethod(service, 'fetch') ? (service as Fetcher) : null,
      permissions: parsePermissions(item.permissions, `SITE_APPS[${index}].permissions`, problems),
      publicPaths,
      scheduled: parseScheduled(item.scheduled, publicPaths, `SITE_APPS[${index}].scheduled`, problems),
      navigation: parseNavigation(item.navigation, `SITE_APPS[${index}].navigation`, problems),
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
  const orgRequestEmail = text(env.ORG_REQUEST_EMAIL) ? normalizeEmail(env.ORG_REQUEST_EMAIL) : null
  if (text(env.ORG_REQUEST_EMAIL) && !orgRequestEmail) log('config_org_request_email_ignored')

  if (!hasMethod(env.DB, 'prepare')) problems.push('DB')
  if (!testMode && !hasMethod(env.EMAIL, 'send')) problems.push('EMAIL')
  if (!hasMethod(env.RL_AUTH, 'limit')) problems.push('RL_AUTH')
  if (!hasMethod(env.RL_APP, 'limit')) problems.push('RL_APP')
  if (!hasMethod(env.RL_PUBLIC, 'limit')) problems.push('RL_PUBLIC')

  // Optional, but a value that is set must be usable: a wrong key would encrypt with something nobody can recover.
  const gatewayKey = parseSecretKey(env.GATEWAY_SECRET_KEY)
  if (text(env.GATEWAY_SECRET_KEY) && !gatewayKey) problems.push('GATEWAY_SECRET_KEY (base64 of 32 bytes)')

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
      orgRequestEmail,
      issuesUrl: issuesUrlFrom(apps),
      repositoryUrl: repositoryUrlFrom(apps),
      testMode,
      db: env.DB!,
      email: testMode ? null : env.EMAIL!,
      rlAuth: env.RL_AUTH!,
      rlApp: env.RL_APP!,
      rlPublic: env.RL_PUBLIC!,
      secretKey: gatewayKey,
      super: readSuperConfig(env),
      cloudflare: readCloudflareConfig(env),
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
