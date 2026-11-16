// Hiding sensitive information before anything is learned: the detectors the Knowledge app's "Try it" box runs
// (knowledge/src/app/server/hiding.ts, a byte-identical copy that a test keeps in step) and the in-memory engine
// applies to every file it reads. The real engine runs the same rules in the container (container/hide.py); both are
// tested against the shared fixtures (engine/test/fixtures/hiding-cases.json). They are best effort: they find the
// common formats, not every secret. Positions are UTF-16 code units, as JavaScript counts them.
//
// Pure TypeScript with no imports, so it runs in the app, the in-memory engine and tests alike.

export interface HidingRuleSet {
  emails: boolean
  phones: boolean
  cards: boolean
  apiKeys: boolean
  secrets: boolean
  words: string[]
}

export type HiddenKind = 'email' | 'phone' | 'card' | 'api_key' | 'secret' | 'word'

export interface HiddenRange {
  start: number
  end: number
  kind: HiddenKind
}

export interface HidingResult {
  /** The text with every hidden value replaced by "[hidden]". */
  text: string
  /** Where each "[hidden]" is in `text`. */
  hidden: HiddenRange[]
  /** Where each hidden value was in the original text. */
  found: HiddenRange[]
}

export const HIDDEN = '[hidden]'

export const DEFAULT_HIDING: HidingRuleSet = { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] }

// The detectors of container/hide.py, the same patterns in the same order: a test runs both against
// engine/test/fixtures/hiding-cases.json, so a change to one is a change to the other.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g
const API_KEYS = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, // GitHub
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe secret and restricted keys
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, // Google API keys
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, // OpenAI and Anthropic style
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JSON Web Tokens
  /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}[\s\S]*?-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY-{5}/g, // PEM private keys
]
const BEARER = /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g
// A label, then ":" or "=" (or "is" and something that looks like a secret), then the value.
const SECRET = new RegExp(
  '\\b(?:password|passwd|pwd|passphrase|passcode|pin code|secret(?:[ _-]?key)?|client[ _-]?secret|api[ _-]?key'
    + '|access[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|private[ _-]?key|token)\\b'
    + '(?<sep>\\s*(?::|=>|=)\\s*|\\s+is\\s+)["\'`]?(?<value>[^\\s"\'`<>]{4,200})',
  'gi',
)
const NOT_SECRETS = new Set(['none', 'null', 'required', 'optional', 'true', 'false', 'n/a', 'tbd', 'redacted', 'hidden', '[hidden]', 'unset', 'empty'])
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g
const PHONES = [
  /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])/g, // +49 30 1234 5678, +1 (555) 010-4477
  /(?<![\w(])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w])/g, // (555) 010-4477, 555-010-4477
]
const LABELLED_PHONE = /\b(?:phone|tel|telephone|mobile|cell|fax)\b\.?(?:\s*(?:number|no\.?))?\s*[:#]?\s*(?<value>\+?\d[\d ().-]{5,}\d)/gi
/** Earlier kinds win when two finds overlap at the same start. */
const ORDER: HiddenKind[] = ['api_key', 'secret', 'email', 'card', 'phone', 'word']

/** Whether a run of digits passes the Luhn checksum that card numbers carry. */
export function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48
    if (value < 0 || value > 9) return false
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

const digitsOf = (value: string) => value.replace(/\D/g, '')

/** A value after "… is" counts only when it looks like a secret: 6 characters or more, with a digit, a symbol or a capital. */
function looksSecret(value: string): boolean {
  const rest = value.slice(1)
  return value.length >= 6 && (/\d/.test(value) || /[^\p{L}\p{N}]/u.test(value) || rest !== rest.toLowerCase())
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type Found = [number, number]

function* apiKeys(text: string): Generator<Found> {
  for (const pattern of API_KEYS) for (const match of text.matchAll(pattern)) yield [match.index, match.index + match[0].length]
  for (const match of text.matchAll(BEARER)) {
    const start = match.index + match[0].length - match[1]!.length
    yield [start, start + match[1]!.length]
  }
}

function* secrets(text: string): Generator<Found> {
  for (const match of text.matchAll(SECRET)) {
    const raw = match.groups!.value!
    const value = raw.replace(/[.,;:)\]}]+$/, '')
    if (NOT_SECRETS.has(value.toLowerCase()) || value.includes(HIDDEN)) continue
    if (match.groups!.sep!.toLowerCase().includes('is') && !looksSecret(value)) continue
    const start = match.index + match[0].length - raw.length
    yield [start, start + value.length]
  }
}

function* emails(text: string): Generator<Found> {
  for (const match of text.matchAll(EMAIL)) yield [match.index, match.index + match[0].length]
}

function* cards(text: string): Generator<Found> {
  for (const match of text.matchAll(CARD)) {
    const digits = digitsOf(match[0])
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits) && new Set(digits).size > 1) yield [match.index, match.index + match[0].length]
  }
}

function* phones(text: string): Generator<Found> {
  for (const pattern of PHONES) {
    for (const match of text.matchAll(pattern)) {
      const count = digitsOf(match[0]).length
      if (count >= 8 && count <= 15) yield [match.index, match.index + match[0].length]
    }
  }
  for (const match of text.matchAll(LABELLED_PHONE)) {
    const value = match.groups!.value!
    const count = digitsOf(value).length
    const start = match.index + match[0].length - value.length
    if (count >= 7 && count <= 15) yield [start, start + value.length]
  }
}

/** The organization's own words, matched whole and ignoring case. */
function* words(text: string, list: string[]): Generator<Found> {
  for (const raw of list) {
    const word = raw.trim()
    if (!word) continue
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, 'giu'))) yield [match.index, match.index + match[0].length]
  }
}

/** Every value the rules find, in the original text, sorted; overlapping finds merged into the first one's kind. */
export function findHidden(text: string, rules: HidingRuleSet): HiddenRange[] {
  const found: HiddenRange[] = []
  const detectors: [HiddenKind, boolean, () => Iterable<Found>][] = [
    ['api_key', rules.apiKeys !== false, () => apiKeys(text)],
    ['secret', rules.secrets !== false, () => secrets(text)],
    ['email', rules.emails !== false, () => emails(text)],
    ['card', rules.cards !== false, () => cards(text)],
    ['phone', rules.phones !== false, () => phones(text)],
    ['word', true, () => words(text, rules.words ?? [])],
  ]
  for (const [kind, enabled, detect] of detectors) {
    if (!enabled) continue
    for (const [start, end] of detect()) if (end > start) found.push({ start, end, kind })
  }
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
  const merged: HiddenRange[] = []
  for (const range of found) {
    const last = merged.at(-1)
    if (last && range.start < last.end) {
      if (range.end > last.end) last.end = range.end
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/** The text with every value the rules find replaced by "[hidden]", and where each one is. */
export function applyHiding(text: string, rules: HidingRuleSet): HidingResult {
  const found = findHidden(text, rules)
  let out = ''
  let at = 0
  const hidden: HiddenRange[] = []
  for (const range of found) {
    out += text.slice(at, range.start)
    hidden.push({ start: out.length, end: out.length + HIDDEN.length, kind: range.kind })
    out += HIDDEN
    at = range.end
  }
  out += text.slice(at)
  return { text: out, hidden, found }
}
