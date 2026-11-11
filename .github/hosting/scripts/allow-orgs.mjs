#!/usr/bin/env node
// Lets an owner domain have more organizations than the default two, or fewer (.github/hosting/DESIGN.md §3.1). An
// operator runs it after Insulin Apps support agrees to a request; the person then creates the organization themselves.
//
//   node .github/hosting/scripts/allow-orgs.mjs --domain example.com --max 5 [--note "Approved request"] [--remote]
//
// --domain  the owner domain as the request names it: a registrable domain (example.com, not eu.example.com), or for
//           someone at a public mail provider their address without a +tag. Lower case, punycode and Gmail's form
//           (no dots, gmail.com) are applied; anything else unusual is refused.
// --max     how many organizations it may have: a whole number from 0 to 1000.
// --note    optional, at most 200 characters: why (letters, digits, spaces and . , : ( ) # & ' + _ @ ! ? / -).
// --remote  the production database. Without it, the local one `npm run dev` uses (.github/hosting/gateway/.dev/state).
//
// It runs the gateway's pinned wrangler (`npm ci --prefix .github/hosting/gateway` first, which also installs what the
// owner-domain rules in gateway/src/owner-domain.ts need): `node <wrangler.js> d1 execute insulin-apps-gateway
// --command "<upsert>"`, without a shell, so it runs the same on Windows. Remote needs CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID (or a `wrangler login`). wrangler takes no bound parameters on the command line, so every value
// is validated strictly and then quoted; nothing unchecked reaches the SQL.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkOwnerDomain } from '../gateway/src/owner-domain.ts'

export const DATABASE = 'insulin-apps-gateway'
export const MAX_ORGS = 1000
export const NOTE_MAX = 200
export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'gateway')

const USAGE = 'Usage: node .github/hosting/scripts/allow-orgs.mjs --domain example.com --max 5 [--note "…"] [--remote]'
const NOTE = /^[\p{L}\p{N} .,:()#&'+_@!?/-]+$/u

export class UsageError extends Error {}

/**
 * The owner domain to allow, as the gateway counts it (gateway/src/owner-domain.ts checkOwnerDomain, the same check
 * the request to support applies before it names the domain in its command).
 */
export function parseOwnerDomain(input) {
  const checked = checkOwnerDomain(input)
  if ('problem' in checked) throw new UsageError(`--domain: ${checked.problem}`)
  return checked.ownerDomain
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

/**
 * wrangler's JavaScript entry (bin/wrangler.js), resolved from the gateway package: Node runs it directly, as
 * node_modules/.bin/wrangler.cmd can't be run without a shell on Windows. Throws when wrangler isn't installed.
 */
export function wranglerEntry() {
  const manifest = createRequire(join(gatewayDir, 'package.json')).resolve('wrangler/package.json')
  return join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.wrangler)
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
  let entry
  try {
    entry = wranglerEntry()
  } catch {
    err('wrangler isn\'t installed. Run npm ci --prefix .github/hosting/gateway first.')
    return 1
  }
  out(`Allowing ${options.domain} ${options.max} organization${options.max === 1 ? '' : 's'} in the ${options.remote ? 'production' : 'local'} database.`)
  // No shell: the arguments reach wrangler as they are, the SQL among them.
  const result = spawn(process.execPath, [entry, ...wranglerArgs({ remote: options.remote, sql })], { cwd: gatewayDir, stdio: 'inherit' })
  if (result.error) {
    err(`Couldn't run wrangler (${result.error.code ?? 'error'}). Run npm ci --prefix .github/hosting/gateway first.`)
    return 1
  }
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
