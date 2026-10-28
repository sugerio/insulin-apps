#!/usr/bin/env node
// Keeps private details out of this public repository. It reads every file Git tracks, and every tracked path, and
// fails on anything that looks like real data rather than the synthetic fixtures. Run it from anywhere in the
// repository; CI runs it, after its tests (check-public-content.test.mjs), before any app job:
//
//   node .github/scripts/check-public-content.mjs
//   node .github/scripts/check-public-content.mjs --deny-list ../private/deny-list.txt
//
// Generic rules (safe to publish):
//   email          an e-mail address outside the reserved example domains (example.com, example.org, example.net
//                  and their subdomains) and test top-level names (.test, .example, .invalid, .localhost); quoted
//                  local parts, Unicode (IDN) and punycode domains included
//   local-path     an absolute path into a Linux home directory
//   idp-id         a Google Workspace SAML identity-provider id (an idpid query parameter with its value)
//   cloudflare-id  a 32-hex or UUID value given to an account, database, zone or namespace id key (account_id = ...,
//                  "databaseId": ..., CLOUDFLARE_ACCOUNT_ID=...), on the same line or a following one
//   private-key    a PEM private-key block or a PuTTY private-key file; certificates and public keys pass
//   aws-key        an AWS access key id, long-term (AKIA) or temporary (ASIA)
//
// Organization-specific terms (people, companies, domains, ids, workspace and repository names, figures) never go in
// this public file. They belong in a deny list that the maintainer keeps OUTSIDE the repository and passes with
// --deny-list <file>: one literal per line, blank lines and lines starting with # ignored, matched ignoring case and
// Unicode compatibility forms (NFKC). The script refuses a deny list inside the repository.
//
// Output names only file:line, the rule and how to fix it: never the matched text, a deny-list entry or the deny
// list's path, so public CI logs repeat nothing. A path that itself matches is printed with that part masked.
//
// String literals joined with + ('ab' + "cd", on one line or across lines) are checked joined as well, with the
// generic rules and the deny list, so splitting a value into pieces doesn't hide it.
//
// Limits:
//   - It matches patterns. A value assembled any other way (template substitutions, arrays, variables, encodings) or
//     split across lines of prose is missed; the one exception is a Cloudflare id on a line after its key.
//   - E-mail addresses need a dotted domain: single-label hosts (user@intranet) and spelled-out addresses pass.
//   - It knows no other secret formats (API tokens, passwords, high-entropy strings), and no Cloudflare id under a
//     bare `id` key (as in KV namespace bindings). Use a dedicated secret scanner for those.
//   - Private domains, names and figures are found only through the deny list, and only as literal text.
//   - Binary files are skipped (the apps' sources are text-only by platform rule). A symlink is checked by the path
//     it points to, never followed.
//
// ALLOWED exempts legitimate content, pinned so that the exemption can't grow: a whole file by its SHA-256 (a verbatim
// platform file), or one line by its SHA-256, which must then occur exactly once in its file. An entry that no longer
// matches fails the check, so the list can only shrink.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ALLOWED = [
  {
    file: 'captable/src/suger-app-builder-runtime.tsx',
    sha256: '3725941405ce16f3d4a668ea28d34fcbe061265e55a42dc4eb97609cab9c7686',
    why: "The Insulin platform's preview bridge, byte-identical to the platform template: it names the console origins allowed to drive the preview.",
  },
  {
    file: 'LICENSE',
    lineSha256: '6143bedbcdbd3360b5c6ab43de172ea2cb873f73cd0fb27fcd6266a67edc55f9',
    why: 'The copyright line of the MIT license, which names the copyright holder.',
  },
]

// Reserved for documentation and testing (RFC 2606, RFC 6761), so they never reach a real mailbox.
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net']
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost']

// The patterns are spelled ([=], -{5}, \d+) so that neither this file nor its test matches them.
// A local part is capped at 64 characters (RFC 5321), which also keeps the scan linear on long runs of text.
const EMAIL =
  /(?:"[^"\r\n]{1,64}"|[\p{L}\p{N}!#$%&'*+\/=?^_`{|}~.-]{1,64})@((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59}))(?![\p{L}\p{N}-])/giu
const LINE_RULES = [
  { rule: 'email', regex: EMAIL, accept: (match) => !isExampleDomain(match[1]) },
  { rule: 'local-path', regex: /(?<![\w.-])\/home\/[^\s'"`<>()[\]{},;]*/g },
  { rule: 'idp-id', regex: /idpid[=][\w-]*/gi },
  { rule: 'private-key', regex: /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}|PuTTY-User-Key-File-\d+:/g },
  { rule: 'aws-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
]
// Bound to its own key: only the value right after the key (and an optional quote and separator) counts, so an id
// that belongs to another field on the same line passes. `\s*` lets the value sit on a following line.
const CLOUDFLARE_PAIR =
  /(?:account|database|zone|namespace)[ _-]?id(?![a-z0-9])["'`]?\s*(?:=>|[:=])?\s*["'`]?([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/dgi
// One string literal: single- or double-quoted on one line, or a template literal without substitutions.
const PIECE = /'(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`/
// Two or more of them joined with +, with any whitespace (line breaks included) around each +.
const CHAIN = new RegExp(`(?:${PIECE.source})(?:\\s*\\+\\s*(?:${PIECE.source}))+`, 'g')

const FIXES = {
  email: 'use an address at example.com, example.org or example.net, or under .test',
  'local-path': 'use a path relative to the repository',
  'idp-id': 'remove the identity-provider id',
  'cloudflare-id': 'remove the Cloudflare id; the platform provisions its own resources',
  'private-key': 'remove the private key, and rotate it if it was ever real',
  'aws-key': 'remove the access key id, and rotate the key if it was ever real',
}

const USAGE = 'usage: node .github/scripts/check-public-content.mjs [--deny-list <file>]'

/**
 * Where the generic rules hit in a text: [{ rule, line, start, end, joined? }], start and end as offsets in the line.
 * A hit with `joined` spans string literals joined with +: start and end then mark the chain on its first line.
 */
export function findHits(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const { rule, regex, accept } of LINE_RULES) {
      for (const match of line.matchAll(regex)) {
        if (!accept || accept(match)) hits.push({ rule, line: index + 1, start: match.index, end: match.index + match[0].length })
      }
    }
  })
  for (const match of text.matchAll(CLOUDFLARE_PAIR)) {
    const [start, end] = match.indices[1]
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const line = text.slice(0, start).split('\n').length
    hits.push({ rule: 'cloudflare-id', line, start: start - lineStart, end: end - lineStart })
  }
  for (const chain of joinedStrings(text)) {
    for (const { rule, regex, accept } of LINE_RULES) {
      for (const match of chain.text.matchAll(regex)) {
        if ((!accept || accept(match)) && chain.spans(match.index, match.index + match[0].length)) hits.push({ rule, ...chain.where, joined: true })
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.start - b.start)
}

/** Lines of a text that contain a deny-list literal: [{ rule: 'deny-list', line, entry, joined? }]. */
export function findDenied(text, denyList) {
  if (!denyList.length) return []
  const hits = []
  text.split(/\r?\n/).forEach((line, index) => {
    const normalized = normalize(line)
    for (const { literal, lineNumber } of denyList) {
      if (normalized.includes(literal)) hits.push({ rule: 'deny-list', line: index + 1, entry: lineNumber })
    }
  })
  for (const chain of joinedStrings(text, normalize)) {
    for (const { literal, lineNumber } of denyList) {
      for (let at = chain.text.indexOf(literal); at !== -1; at = chain.text.indexOf(literal, at + 1)) {
        if (chain.spans(at, at + literal.length)) {
          hits.push({ rule: 'deny-list', line: chain.where.line, entry: lineNumber, joined: true })
          break
        }
      }
    }
  }
  return hits
}

/**
 * The string literals a text joins with +: [{ text, where: { line, start, end }, spans(start, end) }], where `text` is
 * their contents joined (each one passed through `map`), and `spans` says whether a range of it crosses from one literal
 * into the next. A match inside a single literal is left to the line rules, which see it on its own line.
 */
function joinedStrings(text, map = (piece) => piece) {
  if (!text.includes('+')) return []
  const chains = []
  for (const match of text.matchAll(CHAIN)) {
    const ends = []
    let joined = ''
    for (const piece of match[0].matchAll(new RegExp(PIECE.source, 'g'))) {
      joined += map(piece[0].slice(1, -1))
      ends.push(joined.length)
    }
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1
    const firstLineEnd = text.indexOf('\n', match.index)
    const chainEnd = match.index + match[0].length
    chains.push({
      text: joined,
      where: {
        line: text.slice(0, match.index).split('\n').length,
        start: match.index - lineStart,
        end: (firstLineEnd === -1 || firstLineEnd > chainEnd ? chainEnd : firstLineEnd) - lineStart,
      },
      spans: (start, end) => ends.some((boundary) => start < boundary && boundary < end),
    })
  }
  return chains
}

/** Deny-list entries from the file's text: [{ literal, lineNumber }]. */
export function parseDenyList(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ literal: normalize(line.trim()), lineNumber: index + 1 }))
    .filter(({ literal }) => literal && !literal.startsWith('#'))
}

/** Scans the tracked files of a Git checkout: { problems, stale, scanned, skipped }. */
export function scanRepository(root, { denyList = [], allowed = ALLOWED } = {}) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
  const tracked = new Set(files)
  const exemptFiles = new Set()
  const exemptLines = new Map()
  const stale = []
  for (const entry of allowed) {
    const content = tracked.has(entry.file) ? readTracked(join(root, entry.file)) : null
    if (!content || content.link) {
      stale.push({ file: entry.file, reason: 'is not a tracked file' })
    } else if (entry.sha256) {
      if (sha256(content.text.replace(/\r\n/g, '\n')) === entry.sha256) exemptFiles.add(entry.file)
      else stale.push({ file: entry.file, reason: 'has changed since its SHA-256 was pinned' })
    } else {
      const lines = content.text.split(/\r?\n/)
      const matching = lines.flatMap((line, index) => (sha256(line) === entry.lineSha256 ? [index + 1] : []))
      if (matching.length === 1) exemptLines.set(entry.file, new Set([...(exemptLines.get(entry.file) ?? []), matching[0]]))
      else stale.push({ file: entry.file, reason: `has its pinned line ${matching.length} times instead of once` })
    }
  }

  const problems = []
  let scanned = 0
  let skipped = 0
  for (const file of files) {
    if (exemptFiles.has(file)) {
      scanned += 1
      continue
    }
    const shown = displayPath(file, denyList)
    for (const hit of [...findHits(file), ...findDenied(file, denyList)]) problems.push({ ...hit, file, shown, line: 0 })
    const content = readTracked(join(root, file))
    if (!content) {
      skipped += 1
      continue
    }
    scanned += 1
    const exempt = exemptLines.get(file)
    for (const hit of [...findHits(content.text), ...findDenied(content.text, denyList)]) {
      if (!exempt?.has(hit.line)) problems.push({ ...hit, file, shown })
    }
  }
  return { problems, stale, scanned, skipped }
}

/** The command line, without printing: { code, out, err } with the lines for stdout and stderr. */
export function run(args, { root = repositoryRoot(), allowed = ALLOWED } = {}) {
  const out = []
  const err = []
  let denyListPath = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return { code: 0, out: [USAGE], err }
    } else if (arg === '--deny-list' && args[index + 1]) {
      denyListPath = args[(index += 1)]
    } else if (arg.startsWith('--deny-list=') && arg.length > '--deny-list='.length) {
      denyListPath = arg.slice('--deny-list='.length)
    } else {
      // Never echo an argument's value: a stray one may well be the deny list's path.
      const option = arg.startsWith('-') ? arg.split('=')[0] : null
      const what = option === '--deny-list' ? '--deny-list needs a file' : option ? `unknown option ${option}` : 'unexpected argument'
      return { code: 2, out, err: [`check-public-content: ${what}`, USAGE] }
    }
  }
  if (!root) return { code: 2, out, err: ['check-public-content: run it inside a Git checkout of the repository', USAGE] }

  let denyList = []
  if (denyListPath) {
    let full
    try {
      full = realpathSync(resolve(denyListPath))
      const inside = relative(realpathSync(root), full)
      if (!inside.startsWith('..') && !isAbsolute(inside)) {
        return { code: 2, out, err: ['check-public-content: the --deny-list file is inside the repository; keep it outside, where it cannot be committed'] }
      }
      denyList = parseDenyList(readFileSync(full, 'utf8'))
    } catch {
      return { code: 2, out, err: ['check-public-content: cannot read the --deny-list file'] }
    }
  }

  let result
  try {
    result = scanRepository(root, { denyList, allowed })
  } catch {
    return { code: 2, out, err: ['check-public-content: git ls-files failed; run it inside a Git checkout of the repository'] }
  }
  const { problems, stale, scanned, skipped } = result
  for (const hit of problems) {
    const where = hit.line ? `${hit.shown}:${hit.line}` : `${hit.shown} (its path)`
    const fix = hit.rule === 'deny-list' ? `remove the text that matches line ${hit.entry} of the deny list` : FIXES[hit.rule]
    err.push(`${where}: ${hit.rule}: ${fix}${hit.joined ? ' (it is split into strings joined with +)' : ''}`)
  }
  for (const entry of stale) {
    err.push(`${entry.file}: allow-list: it ${entry.reason}; review it, then update or remove its ALLOWED entry in .github/scripts/check-public-content.mjs`)
  }
  const counts = `${scanned} files scanned${skipped ? `, ${skipped} binary or unreadable skipped` : ''}${denyList.length ? `, ${denyList.length} deny-list entries` : ''}`
  if (problems.length || stale.length) {
    const fileCount = new Set(problems.map((hit) => hit.file)).size
    const staleNote = stale.length ? `, ${stale.length} stale allow-list entr${stale.length === 1 ? 'y' : 'ies'}` : ''
    err.push(`check-public-content: ${problems.length} problem(s) in ${fileCount} file(s)${staleNote} (${counts})`)
    return { code: 1, out, err }
  }
  out.push(`check-public-content: ok (${counts})`)
  return { code: 0, out, err }
}

function isExampleDomain(domain) {
  const lower = domain.toLowerCase()
  if (EXAMPLE_DOMAINS.some((example) => lower === example || lower.endsWith(`.${example}`))) return true
  return RESERVED_TLDS.includes(lower.slice(lower.lastIndexOf('.') + 1))
}

function normalize(text) {
  return text.normalize('NFKC').toLowerCase()
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** The path as it may be printed: any segment that matches a rule is masked. */
function displayPath(path, denyList) {
  const matches = (text) => findHits(text).length > 0 || findDenied(text, denyList).length > 0
  if (!matches(path)) return path
  const masked = path.split('/').map((segment) => (matches(segment) ? '…' : segment)).join('/')
  return matches(masked) ? '(a tracked path; find it with git ls-files)' : masked
}

/** A tracked file's text, or a link's target path; null for binary, missing and special files. */
function readTracked(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return null // deleted in the working tree but not yet in the index
  }
  if (stat.isSymbolicLink()) return { text: readlinkSync(path), link: true }
  if (!stat.isFile()) return null // a submodule
  const bytes = readFileSync(path)
  if (bytes.includes(0)) return null
  try {
    // ignoreBOM keeps a byte-order mark in the text, so a file's hash is the hash of its bytes.
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), link: false }
  } catch {
    return null
  }
}

function repositoryRoot() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function invokedDirectly() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

// Run only as a command, not when the test imports this module.
if (invokedDirectly()) {
  const { code, out, err } = run(process.argv.slice(2))
  for (const line of out) console.log(line)
  for (const line of err) console.error(line)
  process.exitCode = code
}
