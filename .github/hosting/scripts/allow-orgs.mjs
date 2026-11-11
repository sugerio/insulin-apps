#!/usr/bin/env node
// Lets an owner domain have more organizations than the default two, or fewer (.github/hosting/DESIGN.md §3.1). An
// operator runs it after Insulin Apps support agrees to a request; the person then creates the organization themselves.
//
//   node .github/hosting/scripts/allow-orgs.mjs --domain example.com --max 5 [--note "Approved request"] [--remote]
//
// --domain  the owner domain as the request names it: a domain (example.com), or for someone at a public mail provider
//           their address without a +tag. Lower case and punycode are applied; anything else unusual is refused.
// --max     how many organizations it may have: a whole number from 0 to 1000.
// --note    optional, at most 200 characters: why (letters, digits, spaces and . , : ( ) # & ' + _ @ ! ? / -).
// --remote  the production database. Without it, the local one `npm run dev` uses (.github/hosting/gateway/.dev/state).
//
// It runs the gateway's pinned wrangler (`npm ci --prefix .github/hosting/gateway` first): `wrangler d1 execute
// insulin-apps-gateway --command "<upsert>"`. Remote needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or a
// `wrangler login`). wrangler takes no bound parameters on the command line, so every value is validated strictly
// and then quoted; nothing unchecked reaches the SQL.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DATABASE = 'insulin-apps-gateway'
export const MAX_ORGS = 1000
export const NOTE_MAX = 200
export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'gateway')

const USAGE = 'Usage: node .github/hosting/scripts/allow-orgs.mjs --domain example.com --max 5 [--note "…"] [--remote]'
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const LOCAL_PART = /^[a-z0-9._-]{1,64}$/
const NOTE = /^[\p{L}\p{N} .,:()#&'+_@!?/-]+$/u

export class UsageError extends Error {}

/** A domain, lower case and in punycode, or null. Only letters, digits, dots and hyphens are accepted at all. */
function hostname(text) {
  if (!text || /[^\p{L}\p{M}\p{N}.-]/u.test(text)) return null
  let host
  try {
    host = new URL(`http://${text}`).hostname
  } catch {
    return null
  }
  return HOSTNAME.test(host) && !/^[\d.]+$/.test(host) ? host : null
}

/**
 * The owner domain to allow: a domain, or an address (at a public mail provider) without a +tag, as the gateway
 * writes them (db/orgs.ts ownerDomainOf).
 */
export function parseOwnerDomain(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/\.$/, '')
  const at = text.lastIndexOf('@')
  const host = hostname(at === -1 ? text : text.slice(at + 1))
  if (!host) throw new UsageError('--domain must be a domain such as example.com, or an address at a public mail provider')
  if (at === -1) return host
  const local = text.slice(0, at)
  if (!LOCAL_PART.test(local)) {
    throw new UsageError('--domain: an address must be the owner domain the request names, letters, digits, dots, hyphens and underscores before the @ (no +tag)')
  }
  return `${local}@${host}`
}

export function parseMax(input) {
  const text = String(input ?? '').trim()
  const value = /^\d{1,4}$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(value) || value < 0 || value > MAX_ORGS) throw new UsageError(`--max must be a whole number from 0 to ${MAX_ORGS}`)
  return value
}

export function parseNote(input) {
  if (input === undefined) return null
  const text = String(input).trim().replace(/ {2,}/g, ' ')
  if (!text) return null
  if ([...text].length > NOTE_MAX || !NOTE.test(text) || text.includes('--')) {
    throw new UsageError(`--note must be at most ${NOTE_MAX} characters: letters, digits, spaces and . , : ( ) # & ' + _ @ ! ? / - (no "--")`)
  }
  return text
}

/** The options from the command line, or a UsageError. */
export function parseArgs(argv) {
  const options = { domain: undefined, max: undefined, note: undefined, remote: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--remote') options.remote = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--domain' || arg === '--max' || arg === '--note') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      const key = arg.slice(2)
      if (options[key] !== undefined) throw new UsageError(`${arg} given twice`)
      options[key] = value
      i += 1
    } else throw new UsageError(`Unknown argument ${JSON.stringify(arg)}`)
  }
  if (options.help) return { help: true }
  if (options.domain === undefined || options.max === undefined) throw new UsageError('--domain and --max are required')
  return { domain: parseOwnerDomain(options.domain), max: parseMax(options.max), note: parseNote(options.note), remote: options.remote }
}

/** A SQL string literal; the values reaching it are validated already, and a quote is still doubled. */
function quote(text) {
  return `'${text.replaceAll("'", "''")}'`
}

/** The upsert: a new allowance, or a new number (and note, if one is given) for an existing one. */
export function allowanceSql({ domain, max, note, now }) {
  if (!Number.isInteger(max) || !Number.isInteger(now)) throw new UsageError('max and now must be integers')
  return `INSERT INTO org_domain_allowances (owner_domain, max_orgs, note, created_at) VALUES (${quote(parseOwnerDomain(domain))}, ${parseMax(String(max))}, ${note === null ? 'NULL' : quote(parseNote(note))}, ${now}) ON CONFLICT (owner_domain) DO UPDATE SET max_orgs = excluded.max_orgs, note = COALESCE(excluded.note, org_domain_allowances.note)`
}

/** wrangler's arguments: the production database by name, or the local development one. */
export function wranglerArgs({ remote, sql }) {
  const target = remote
    ? ['--remote']
    : ['--local', '--config', join(gatewayDir, 'wrangler.local.jsonc'), '--persist-to', join(gatewayDir, '.dev', 'state')]
  return ['d1', 'execute', DATABASE, ...target, '--command', sql]
}

export function wranglerPath() {
  return join(gatewayDir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
}

/** Runs the command line; returns the exit code. `spawn`, `now` and the output streams can be replaced in tests. */
export function main(argv, { spawn = spawnSync, now = Date.now(), out = console.log, err = console.error } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    err(`${error.message}\n${USAGE}`)
    return 2
  }
  if (options.help) {
    out(USAGE)
    return 0
  }
  const sql = allowanceSql({ ...options, now })
  out(`Allowing ${options.domain} ${options.max} organization${options.max === 1 ? '' : 's'} in the ${options.remote ? 'production' : 'local'} database.`)
  const result = spawn(wranglerPath(), wranglerArgs({ remote: options.remote, sql }), { cwd: gatewayDir, stdio: 'inherit' })
  if (result.error) {
    err(`Couldn't run wrangler (${result.error.code ?? 'error'}). Run npm ci --prefix .github/hosting/gateway first.`)
    return 1
  }
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
