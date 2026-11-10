// One-time codes from an authenticator app (RFC 6238 TOTP over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30-second steps.
// Pure functions on Web Crypto, so the unit tests import them directly with the RFC's test vectors.
import { constantTimeEqual, randomBytes } from '../crypto.ts'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** Steps either side of now that still count, for clocks that drift: ±1 (30 seconds). */
export const TOTP_WINDOW = 1
export const TOTP_SECRET_BYTES = 20

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, upper case, without padding (what authenticator apps expect in `secret=`). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Base32 to bytes, ignoring case, spaces and padding; null for any other character. */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text.replace(/[\s=]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES))
}

/** The 30-second step a moment falls in. */
export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS)
}

/** RFC 4226 HOTP: HMAC-SHA1 of the 8-byte big-endian counter, dynamically truncated to `digits` digits. */
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const message = new Uint8Array(8)
  const view = new DataView(message.buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  const key = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = mac[mac.length - 1]! & 0x0f
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** Whether `input` looks like a one-time code (6 digits, spaces allowed), and the digits. */
export function codeDigits(input: string): string | null {
  const digits = input.replace(/\s/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}

/**
 * The step whose code `code` is, within ±TOTP_WINDOW of now, or null. The caller still has to record the step as used
 * (atomically) before accepting it, so a code works once.
 */
export async function matchTotp(secretBase32: string, code: string, nowMs: number): Promise<number | null> {
  const secret = base32Decode(secretBase32)
  if (!secret || !secret.length) return null
  const now = timeStep(nowMs)
  let matched: number | null = null
  // Every candidate is computed and compared, so the time taken doesn't say which step matched.
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step += 1) {
    if (constantTimeEqual(await hotp(secret, step), code) && matched === null) matched = step
  }
  return matched
}

/** The URI an authenticator app reads from the QR code. */
export function otpauthUri(secretBase32: string, account: string, issuer = 'Insulin Apps'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const query = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) })
  return `otpauth://totp/${label}?${query.toString().replaceAll('+', '%20')}`
}

/** The key in groups of four, easier to type. */
export function groupedSecret(secretBase32: string): string {
  return secretBase32.match(/.{1,4}/g)?.join(' ') ?? secretBase32
}

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
export const RECOVERY_CODE_COUNT = 10

/** A recovery code: 16 random base32 characters (80 bits) in four groups, `abcd-efgh-ijkm-nopq`. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(16)
  let code = ''
  for (const byte of bytes) code += RECOVERY_ALPHABET[byte & 31]
  return code.match(/.{4}/g)!.join('-')
}

/** A typed recovery code in its stored form (lower case, without spaces or dashes), or null if it can't be one. */
export function normalizeRecoveryCode(input: string): string | null {
  const code = input.toLowerCase().replace(/[\s-]/g, '')
  return /^[a-z2-7]{16}$/.test(code) ? code : null
}
