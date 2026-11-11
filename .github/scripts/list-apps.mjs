#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const APP_NAME_PATTERN = /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/
export const RESERVED_APP_NAMES = new Set([
  'auth',
  'www',
  'api',
  'admin',
  'app',
  'apps',
  'mail',
  'email',
  'cf-bounce',
  'gateway',
  'static',
  'assets',
  'status',
  'docs',
  'help',
  'support',
  // An app's secrets are named <APP>_*; these would collide with the platform's own settings (DESIGN.md §8.3).
  'cloudflare',
  'google',
  'turnstile',
  'github',
  'site',
  'suger',
  'actions',
  'runner',
])

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Discover publishable apps at the top level of a repository. */
export async function listApps(root = repositoryRoot) {
  const entries = await readdir(root, { withFileTypes: true })
  const apps = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    let packageText
    try {
      packageText = await readFile(join(directory, 'package.json'), 'utf8')
      await readFile(join(directory, 'src', 'api.ts'))
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      throw error
    }

    validateAppName(entry.name)

    let manifest
    try {
      manifest = JSON.parse(packageText)
    } catch {
      throw new Error(`App ${JSON.stringify(entry.name)} has an invalid package.json`)
    }

    const title = typeof manifest.displayName === 'string' && manifest.displayName.trim() ? manifest.displayName.trim() : entry.name
    const summary = typeof manifest.description === 'string' ? manifest.description.trim() : ''
    const permissions = readPermissions(entry.name, manifest.insulin?.permissions)
    const publicPaths = readPublicPaths(entry.name, manifest.insulin?.publicPaths)
    const scheduled = readScheduled(entry.name, manifest.insulin?.scheduled, publicPaths)
    const secrets = readSecretNames(entry.name, manifest.insulin?.secrets)
    const navigation = readNavigation(entry.name, manifest.insulin?.navigation)
    apps.push({ name: entry.name, title, summary, permissions, publicPaths, scheduled, navigation, secrets })
  }

  checkSecretNamespaces(apps)
  return apps
}

/**
 * Settings and secrets the platform's own workflows use: never an app's, whatever its name (the reserved app names
 * already keep app prefixes off them; this is the second lock).
 */
export const PLATFORM_SETTING_NAMES = new Set([
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY', 'EMAIL_FROM', 'SUPPORT_EMAIL', 'ORG_REQUEST_EMAIL', 'SITE_DOMAIN', 'GATEWAY_SECRET_KEY',
  'GITHUB_TOKEN',
])
const PLATFORM_SETTING_PREFIXES = ['SUGER_', 'GITHUB_', 'ACTIONS_', 'RUNNER_']

/**
 * One app's secret names never fall in another app's namespace: `esign` may not declare `ESIGN_PRO_KEY` when an app
 * `esign-pro` exists, since that name is the longer prefix's.
 */
export function checkSecretNamespaces(apps) {
  for (const app of apps) {
    for (const name of app.secrets ?? []) {
      const owner = apps.filter((other) => other !== app && name.startsWith(secretPrefix(other.name)) && secretPrefix(other.name).length > secretPrefix(app.name).length)[0]
      if (owner) throw new Error(`App ${JSON.stringify(app.name)}: insulin.secrets name ${name} belongs to app ${JSON.stringify(owner.name)}`)
    }
  }
}

const PERMISSION_KEY = /^[a-z][a-z0-9_.-]{0,63}$/
const PERMISSION_ROLES = new Set(['ADMIN', 'EDITOR', 'VIEWER'])

/**
 * An app's permission catalog, `insulin.permissions` in its package.json (.github/hosting/DESIGN.md §2.3): at most 50
 * entries of { key, label, description?, role }, where `role` is the least built-in role that has the permission. The
 * gateway checks it again and refuses to start with a malformed one, so a mistake fails here, before a deploy.
 */
export function readPermissions(app, raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 50) throw new Error(`App ${JSON.stringify(app)}: insulin.permissions must be an array of at most 50`)
  const keys = new Set()
  return raw.map((entry, index) => {
    const where = `App ${JSON.stringify(app)}: insulin.permissions[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`)
    const { key, label, description = '', role } = entry
    if (typeof key !== 'string' || !PERMISSION_KEY.test(key)) throw new Error(`${where}.key must match ${PERMISSION_KEY.source}`)
    if (keys.has(key)) throw new Error(`${where}.key ${JSON.stringify(key)} is listed twice`)
    keys.add(key)
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error(`${where}.label must be 1-80 characters`)
    if (typeof description !== 'string' || description.length > 300) throw new Error(`${where}.description must be at most 300 characters`)
    if (!PERMISSION_ROLES.has(role)) throw new Error(`${where}.role must be ADMIN, EDITOR or VIEWER`)
    return { key, label: label.trim(), description: description.trim(), role }
  })
}

// Never public: the gateway's own paths on an app host and the platform's routes inside the app (DESIGN.md §8.1).
const RESERVED_PREFIXES = ['/__insulin', '/settings', '/mcp', '/.well-known', '/api/__suger']

/**
 * Why an entry of `insulin.publicPaths` is refused, or null: a path starting with `/`, without `..`, a query or a
 * fragment, that neither is nor covers the API as a whole or a reserved path (compared without regard to case). The
 * gateway applies the same rule (publicPathProblem in its src/config.ts) and refuses to start otherwise.
 */
export function publicPathProblem(entry) {
  if (typeof entry !== 'string' || !entry.startsWith('/') || entry.length > 200) return 'must be a path starting with /'
  if (/[?#%\\\s]/.test(entry) || entry.includes('//') || entry.split('/').some((segment) => segment === '..' || segment === '.')) {
    return 'must not hold a query, a fragment, a percent sign, a backslash, whitespace, an empty or a dot segment'
  }
  const bare = entry.toLowerCase().replace(/\/+$/, '')
  if (bare === '' || bare === '/api') return 'must not cover every path or the whole API'
  for (const reserved of RESERVED_PREFIXES) {
    if (bare === reserved || bare.startsWith(`${reserved}/`) || reserved.startsWith(`${bare}/`)) return `must not reach ${reserved}`
  }
  return null
}

/**
 * The paths an app opens to people without an account, `insulin.publicPaths` in its package.json (DESIGN.md §8.1):
 * at most 10, each passing `publicPathProblem`. The gateway forwards them with no identity at all.
 */
export function readPublicPaths(app, raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 10) throw new Error(`App ${JSON.stringify(app)}: insulin.publicPaths must be an array of at most 10`)
  const seen = new Set()
  return raw.map((entry, index) => {
    const problem = publicPathProblem(entry)
    if (problem) throw new Error(`App ${JSON.stringify(app)}: insulin.publicPaths[${index}] ${problem}`)
    if (seen.has(entry)) throw new Error(`App ${JSON.stringify(app)}: insulin.publicPaths[${index}] is listed twice`)
    seen.add(entry)
    return entry
  })
}

/**
 * Why an app's `insulin.scheduled` is refused, or null: one path under `/api/`, passing `publicPathProblem`, without a
 * trailing slash, and neither one of the app's public paths nor under one, compared without regard to case. The
 * gateway applies the same rule (scheduledProblem in its src/config.ts) and refuses to start otherwise.
 */
export function scheduledProblem(entry, publicPaths = []) {
  if (typeof entry !== 'string' || !entry.startsWith('/api/') || entry.endsWith('/')) return 'must be a path under /api/, without a trailing slash'
  const problem = publicPathProblem(entry)
  if (problem) return problem
  const path = entry.toLowerCase()
  const covered = publicPaths.some((raw) => {
    const publicPath = raw.toLowerCase()
    return publicPath.endsWith('/') ? path.startsWith(publicPath) : path === publicPath || path.startsWith(`${publicPath}/`)
  })
  return covered ? "must not be one of the app's public paths or under one" : null
}

/**
 * The path the gateway POSTs to every five minutes with no identity (`x-suger-access-via: schedule`), so the app can
 * run its due work: `insulin.scheduled` in its package.json (DESIGN.md §8.5), or null when it has none.
 */
export function readScheduled(app, raw, publicPaths = []) {
  if (raw === undefined || raw === null) return null
  const problem = scheduledProblem(raw, publicPaths)
  if (problem) throw new Error(`App ${JSON.stringify(app)}: insulin.scheduled ${problem}`)
  return raw
}

/**
 * The Lucide icons an app's navigation may name (DESIGN.md §3.2). The gateway bundles exactly these (its
 * src/nav-icons.ts lists the same names, and a test keeps the two in step), so an app's level 1 looks the same on the
 * gateway's settings pages as in the app. `home` and `check-circle` are Lucide's older names for `house` and
 * `circle-check`; both spellings are accepted.
 */
export const NAVIGATION_ICONS = Object.freeze([
  'activity', 'archive', 'award', 'banknote', 'bell', 'book-open', 'bot', 'briefcase', 'building', 'calendar',
  'chart-bar', 'chart-pie', 'check-circle', 'circle-check', 'clipboard-list', 'clock', 'download', 'file-pen',
  'file-text', 'files', 'folder', 'gauge', 'heart', 'history', 'home', 'house', 'inbox', 'key', 'landmark', 'layers',
  'layout-dashboard', 'layout-grid', 'list', 'mail', 'percent', 'plug', 'receipt', 'scale', 'search', 'send',
  'settings', 'shield', 'signature', 'table', 'trending-up', 'upload', 'user', 'users', 'wallet',
])
const NAVIGATION_ICON_SET = new Set(NAVIGATION_ICONS)
/** At most this many items, and this many children per item. */
export const NAVIGATION_LIMIT = 12
const NAVIGATION_KEY = /^[a-z0-9-]{1,40}$/
const NAVIGATION_TEXT_MAX = 40
const NAVIGATION_ROLES = new Set(['VIEWER', 'EDITOR', 'ADMIN'])
const NAVIGATION_FIELDS = new Set(['key', 'label', 'icon', 'path', 'group', 'role', 'children'])
// The gateway's own paths on an app host (DESIGN.md §1, §3.2): an app's navigation never links to them.
const NAVIGATION_RESERVED = ['/__insulin', '/settings', '/mcp', '/.well-known', '/api/__suger']

/**
 * Why a navigation item's `path` is refused, or null: a path on the app's own host, starting with a single `/`, at
 * most 200 characters, without a backslash, whitespace, a control character or a fragment; before its query (which
 * may hold anything else), no percent sign, empty or dot segment; and not one of the gateway's paths, compared without
 * regard to case. The gateway applies the same rule (navigationPathProblem in its src/config.ts).
 */
export function navigationPathProblem(entry) {
  if (typeof entry !== 'string' || !entry.startsWith('/') || entry.startsWith('//') || entry.length > 200) {
    return "must be a path on the app's host, starting with a single / (at most 200 characters)"
  }
  if (/[\\\s#\u0000-\u001f\u007f]/.test(entry)) return 'must not hold a backslash, whitespace, a control character or a fragment'
  const pathname = entry.split('?', 1)[0]
  if (pathname.includes('%') || pathname.includes('//') || pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'must not hold a percent sign, an empty or a dot segment before its query'
  }
  const bare = pathname.toLowerCase().replace(/\/+$/, '')
  for (const reserved of NAVIGATION_RESERVED) {
    if (bare === reserved || bare.startsWith(`${reserved}/`)) return `must not be one of the gateway's paths (${reserved})`
  }
  return null
}

function navigationItem(app, entry, where, keys, level) {
  const at = `App ${JSON.stringify(app)}: ${where}`
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object`)
  if (level === 2 && 'children' in entry) throw new Error(`${at} must not have children: the navigation has two levels`)
  for (const field of Object.keys(entry)) {
    if (!NAVIGATION_FIELDS.has(field)) throw new Error(`${at}.${field} is not a navigation field (key, label, icon, path, group, role, children)`)
  }
  const { key, label, icon, path, group, role = 'VIEWER', children } = entry
  if (typeof key !== 'string' || !NAVIGATION_KEY.test(key)) throw new Error(`${at}.key must match ${NAVIGATION_KEY.source}`)
  if (keys.has(key)) throw new Error(`${at}.key ${JSON.stringify(key)} is listed twice`)
  keys.add(key)
  if (typeof label !== 'string' || !label.trim() || label.trim().length > NAVIGATION_TEXT_MAX) {
    throw new Error(`${at}.label must be 1-${NAVIGATION_TEXT_MAX} characters`)
  }
  if (typeof icon !== 'string' || !NAVIGATION_ICON_SET.has(icon)) throw new Error(`${at}.icon must be one of list-apps.mjs's NAVIGATION_ICONS`)
  const problem = navigationPathProblem(path)
  if (problem) throw new Error(`${at}.path ${problem}`)
  if (group !== undefined && (typeof group !== 'string' || !group.trim() || group.trim().length > NAVIGATION_TEXT_MAX)) {
    throw new Error(`${at}.group must be 1-${NAVIGATION_TEXT_MAX} characters`)
  }
  if (!NAVIGATION_ROLES.has(role)) throw new Error(`${at}.role must be VIEWER, EDITOR or ADMIN`)
  const item = { key, label: label.trim(), icon, path, group: group === undefined ? null : group.trim(), role }
  if (level === 2) return item
  if (children !== undefined && (!Array.isArray(children) || children.length > NAVIGATION_LIMIT)) {
    throw new Error(`${at}.children must be an array of at most ${NAVIGATION_LIMIT}`)
  }
  return { ...item, children: (children ?? []).map((child, index) => navigationItem(app, child, `${where}.children[${index}]`, keys, 2)) }
}

/**
 * An app's level-1 navigation, `insulin.navigation` in its package.json (DESIGN.md §3.2): at most 12 items of { key,
 * label, icon, path, group?, role?, children? }, each child the same without `children`, at most 12 per item. `role`
 * is the least app role that sees the item (VIEWER by default) and `group` a heading shown above it; keys are unique
 * across items and children. The result spells out every field: `group` null when there is none, `children` [] on an
 * item without any. The gateway checks it again and refuses to start with a malformed one, so a mistake fails here,
 * before a deploy.
 */
export function readNavigation(app, raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > NAVIGATION_LIMIT) {
    throw new Error(`App ${JSON.stringify(app)}: insulin.navigation must be an array of at most ${NAVIGATION_LIMIT}`)
  }
  const keys = new Set()
  return raw.map((entry, index) => navigationItem(app, entry, `insulin.navigation[${index}]`, keys, 1))
}

/** The prefix an app's secret names must carry: its name upper-cased, with `-` as `_`. */
export function secretPrefix(app) {
  return `${app.toUpperCase().replaceAll('-', '_')}_`
}

/**
 * The secrets an app needs at runtime, `insulin.secrets` in its package.json (DESIGN.md §8.3): at most 30 names, each
 * `<APP>_…` in upper case. The deploy copies each from the GitHub environment, when present, as a Worker secret.
 */
export function readSecretNames(app, raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 30) throw new Error(`App ${JSON.stringify(app)}: insulin.secrets must be an array of at most 30`)
  const pattern = new RegExp(`^${secretPrefix(app)}[A-Z0-9_]{1,60}$`)
  const seen = new Set()
  return raw.map((name, index) => {
    if (typeof name !== 'string' || !pattern.test(name)) {
      throw new Error(`App ${JSON.stringify(app)}: insulin.secrets[${index}] must match ${pattern.source}`)
    }
    if (PLATFORM_SETTING_NAMES.has(name) || PLATFORM_SETTING_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error(`App ${JSON.stringify(app)}: insulin.secrets[${index}] names a setting of the platform itself`)
    }
    if (seen.has(name)) throw new Error(`App ${JSON.stringify(app)}: insulin.secrets[${index}] is listed twice`)
    seen.add(name)
    return name
  })
}

export function validateAppName(name) {
  if (!APP_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid app directory name ${JSON.stringify(name)}; use a lower-case name matching ${APP_NAME_PATTERN.source}`,
    )
  }
  if (RESERVED_APP_NAMES.has(name)) {
    throw new Error(`App directory name ${JSON.stringify(name)} is reserved for the hosting gateway`)
  }
}

async function main(args) {
  if (args.some((arg) => arg !== '--json')) {
    throw new Error('usage: node .github/scripts/list-apps.mjs [--json]')
  }
  const apps = await listApps()
  const output = args.includes('--json') ? apps.map(({ name }) => name) : apps
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`list-apps: ${error.message}\n`)
    process.exitCode = 1
  })
}
