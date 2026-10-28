// Input rules for e-mail addresses, display names, organization names and passwords.

export const NAME_MAX = 100
export const ORG_NAME_MAX = 80
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 200
const EMAIL_MAX = 254

/** Trimmed and lower-cased, at most 254 characters, shaped like someone@example.com, without spaces or control characters. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const email = input.trim().toLowerCase()
  if (email.length > EMAIL_MAX) return null
  return /^[^\s@\p{Cc}]+@[^\s@\p{Cc}.]+(?:\.[^\s@\p{Cc}.]+)+$/u.test(email) ? email : null
}

/**
 * Text for display: well-formed, without control characters or bidirectional overrides, whitespace collapsed and
 * trimmed. Length rules are the caller's.
 */
export function cleanText(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input
    .toWellFormed()
    .replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function length(text: string): number {
  return [...text].length
}

export function truncate(text: string, max: number): string {
  const characters = [...text]
  return characters.length > max ? characters.slice(0, max).join('').trim() : text
}

/** A person's name: 1–100 characters after cleaning. Returns the name, or the problem to show. */
export function checkName(input: unknown): { name: string } | { problem: string } {
  const name = cleanText(input)
  if (!name) return { problem: 'Enter your name.' }
  if (length(name) > NAME_MAX) return { problem: `Use at most ${NAME_MAX} characters.` }
  return { name }
}

export function checkOrgName(input: unknown): { name: string } | { problem: string } {
  const name = cleanText(input)
  if (!name) return { problem: 'Enter a name for the organization.' }
  if (length(name) > ORG_NAME_MAX) return { problem: `Use at most ${ORG_NAME_MAX} characters.` }
  return { name }
}

/** 10–200 characters and no composition rules. Returns the problem to show, or null. */
export function passwordProblem(input: unknown): string | null {
  if (typeof input !== 'string' || input === '') return 'Enter a password.'
  const count = length(input)
  if (count < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`
  if (count > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`
  return null
}
