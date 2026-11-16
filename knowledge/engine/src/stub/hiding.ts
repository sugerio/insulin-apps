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
// engine/test/fixtures/hiding-cases.json, so a change to one is a change to the other. Python's `re` is Unicode-aware
// on text: \d is any decimal digit (Nd), \w any letter, number or underscore, \s Python's whitespace, \b a boundary
// between them, and IGNORECASE folds case as Unicode does. The patterns below spell those out (the `u` flag; WORD,
// DIGIT and SPACE), so full-width, Arabic-Indic or Devanagari digits and accented letters are read the same here.

/** Python's \w: a letter, a number or an underscore. */
const WORD = '[\\p{L}\\p{N}_]'
/** Python's \d: a decimal digit of any script. */
const DIGIT = '\\p{Nd}'
/** Python's \s on text: str.isspace(). */
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
/** Python's \b before and after a word character. */
const START = `(?<!${WORD})`
const END = `(?!${WORD})`
const re = (source: string, flags = 'gu') => new RegExp(source, flags)

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/gu
const API_KEYS = [
  re(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}${END}`), // AWS access key ids
  re(`${START}(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})${END}`), // GitHub
  re(`${START}xox[abposr]-[A-Za-z0-9-]{10,}`), // Slack
  re(`${START}[sr]k_(?:live|test)_[A-Za-z0-9]{16,}${END}`), // Stripe secret and restricted keys
  re(`${START}AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`), // Google API keys
  re(`${START}sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])`), // OpenAI and Anthropic style
  re(`${START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`), // JSON Web Tokens
  re('-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}[\\s\\S]*?-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY-{5}'), // PEM private keys
]
const BEARER = re(`${START}[Bb]earer${SPACE}+([A-Za-z0-9._~+/-]{20,}=*)`)
// A label, then ":" or "=" (or "is" and something that looks like a secret), then the value.
const SECRET = re(
  `${START}(?:password|passwd|pwd|passphrase|passcode|pin code|secret(?:[ _-]?key)?|client[ _-]?secret|api[ _-]?key`
    + `|access[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|private[ _-]?key|token)${END}`
    + `(?<sep>${SPACE}*(?::|=>|=)${SPACE}*|${SPACE}+is${SPACE}+)["'\`]?(?<value>[^\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"'\`<>]{4,200})`,
  'giu',
)
const NOT_SECRETS = new Set(['none', 'null', 'required', 'optional', 'true', 'false', 'n/a', 'tbd', 'redacted', 'hidden', '[hidden]', 'unset', 'empty'])
const CARD = re(`(?<![${DIGIT}-])(?:${DIGIT}[ -]?){12,18}${DIGIT}(?![${DIGIT}-])`)
const PHONES = [
  re(`(?<![\\p{L}\\p{N}_+])\\+${DIGIT}{1,3}(?:[ .-]?\\(?${DIGIT}{1,4}\\)?){2,5}(?!${WORD})`), // +49 30 1234 5678, +1 (555) 010-4477
  re(`(?<![\\p{L}\\p{N}_(])\\(?${DIGIT}{3}\\)?[ .-]${DIGIT}{3}[ .-]${DIGIT}{4}(?!${WORD})`), // (555) 010-4477, 555-010-4477
]
const LABELLED_PHONE = re(
  `${START}(?:phone|tel|telephone|mobile|cell|fax)${END}\\.?(?:${SPACE}*(?:number|no\\.?))?${SPACE}*[:#]?${SPACE}*(?<value>\\+?${DIGIT}[${DIGIT} ().-]{5,}${DIGIT})`,
  'giu',
)
/** Earlier kinds win when two finds overlap at the same start. */
const ORDER: HiddenKind[] = ['api_key', 'secret', 'email', 'card', 'phone', 'word']
const IS_DIGIT_CHAR = /^\p{Nd}$/u

/** A decimal digit's value, in any script, as Python's int() reads it: digits come in runs of ten, 0 to 9. */
function digitValue(char: string): number {
  const code = char.codePointAt(0)!
  if (code >= 48 && code <= 57) return code - 48
  let start = code
  while (start > 0 && IS_DIGIT_CHAR.test(String.fromCodePoint(start - 1))) start -= 1
  return (code - start) % 10
}

/** Whether a run of digits (of any script) passes the Luhn checksum that card numbers carry. */
export function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  const list = [...digits]
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (!IS_DIGIT_CHAR.test(list[index]!)) return false
    let value = digitValue(list[index]!)
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

const digitsOf = (value: string) => value.replace(/\P{Nd}/gu, '')
/** Python's len(): code points, not UTF-16 units. */
const lengthOf = (value: string) => [...value].length
/** Python's str.isdigit(): decimal digits, and the superscript, subscript and circled digits. */
const IS_DIGIT = /[\p{Nd}\u00b2-\u00b3\u00b9\u1369-\u1371\u19da\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247c\u2488-\u2490\u24ea\u24f5-\u24fd\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]/u

/** A value after "… is" counts only when it looks like a secret: 6 characters or more, with a digit, a symbol or a capital. */
function looksSecret(value: string): boolean {
  const rest = [...value].slice(1).join('')
  return lengthOf(value) >= 6 && (IS_DIGIT.test(value) || /[^\p{L}\p{N}]/u.test(value) || rest !== rest.toLowerCase())
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
    const count = lengthOf(digits)
    if (count >= 13 && count <= 19 && luhn(digits) && new Set(digits).size > 1) yield [match.index, match.index + match[0].length]
  }
}

function* phones(text: string): Generator<Found> {
  for (const pattern of PHONES) {
    for (const match of text.matchAll(pattern)) {
      const count = lengthOf(digitsOf(match[0]))
      if (count >= 8 && count <= 15) yield [match.index, match.index + match[0].length]
    }
  }
  for (const match of text.matchAll(LABELLED_PHONE)) {
    const value = match.groups!.value!
    const count = lengthOf(digitsOf(value))
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
