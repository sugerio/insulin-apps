// Web Crypto helpers: random tokens and ids, SHA-256, PBKDF2 password hashes and constant-time comparison.

const encoder = new TextEncoder()

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return fromBase64(padded)
}

/** 32 random bytes as base64url (43 characters): session ids, e-mail tokens, OAuth state, verifier and nonce. */
export function randomToken(): string {
  return base64url(randomBytes(32))
}

/** True for strings shaped like `randomToken()` output, checked before any hashing or database lookup. */
export function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/**
 * An opaque, stable id for users, organizations and invitations: a random (version 4) UUID. User and organization ids
 * become x-suger-user-id and x-suger-organization-id, and apps expect UUIDs there.
 */
export function newId(): string {
  return crypto.randomUUID()
}

export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

export function isId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${UUID_PATTERN}$`).test(value)
}

export async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)))
}

export async function sha256Hex(text: string): Promise<string> {
  let hex = ''
  for (const byte of await sha256(text)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Compares two strings without an early exit on the first difference. Lengths are not secret here. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8(a)
  const right = utf8(b)
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

// PBKDF2-HMAC-SHA256 with workerd's maximum iteration count, a 16-byte salt and a 32-byte key, stored as
// pbkdf2_sha256$100000$<base64 salt>$<base64 hash>.
const ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256
const PREFIX = 'pbkdf2_sha256'

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS)
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt, ITERATIONS)
  return `${PREFIX}$${ITERATIONS}$${base64(salt)}$${base64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [prefix, iterationText, saltText, hashText] = stored.split('$')
  const iterations = Number(iterationText)
  const salt = saltText ? fromBase64(saltText) : null
  const expected = hashText ? fromBase64(hashText) : null
  if (prefix !== PREFIX || !Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS || !salt || !expected) {
    await burnPasswordCheck(password)
    return false
  }
  const actual = await derive(password, salt, iterations)
  if (actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expected[index]!
  return difference === 0
}

const BURN_SALT = new Uint8Array(SALT_BYTES)

/** One PBKDF2 run with nothing to compare, so a missing account or password costs the same time as a real check. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, BURN_SALT, ITERATIONS)
}

// Secrets the gateway must read back (TOTP seeds, stored credentials, OIDC client secrets) are sealed with AES-256-GCM
// under a key derived from GATEWAY_SECRET_KEY for one purpose (HKDF-SHA256, info = the purpose), and the purpose is
// also the additional data: a value sealed for one purpose never opens as another.
const SEALED_PREFIX = 'v1.'

async function purposeKey(master: Uint8Array, purpose: string, usage: 'AES-GCM' | 'HMAC'): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', master as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveKey'])
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(`insulin-apps:${purpose}`) as Uint8Array<ArrayBuffer> }
  return usage === 'AES-GCM'
    ? crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : crypto.subtle.deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
}

/** `v1.<iv>.<ciphertext>` (base64url). */
export async function seal(master: Uint8Array, purpose: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12)
  const key = await purposeKey(master, purpose, 'AES-GCM')
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(purpose) as Uint8Array<ArrayBuffer> }, key, utf8(plaintext) as Uint8Array<ArrayBuffer>)
  return `${SEALED_PREFIX}${base64url(iv)}.${base64url(new Uint8Array(sealed))}`
}

/** The plaintext, or null when the value is malformed, for another purpose, or sealed with another key. */
export async function unseal(master: Uint8Array, purpose: string, sealed: string): Promise<string | null> {
  if (!sealed.startsWith(SEALED_PREFIX)) return null
  const [ivText, dataText] = sealed.slice(SEALED_PREFIX.length).split('.')
  const iv = ivText ? fromBase64url(ivText) : null
  const data = dataText ? fromBase64url(dataText) : null
  if (!iv || iv.length !== 12 || !data) return null
  try {
    const key = await purposeKey(master, purpose, 'AES-GCM')
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(purpose) as Uint8Array<ArrayBuffer> }, key, data)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/** A stable secret for one purpose and subject (an app's integration token, say), derived from the master key. */
export async function derivedSecret(master: Uint8Array, purpose: string, subject: string): Promise<string> {
  const key = await purposeKey(master, purpose, 'HMAC')
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(subject) as Uint8Array<ArrayBuffer>)))
}
