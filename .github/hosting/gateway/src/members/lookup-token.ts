// The member lookup header (DESIGN.md §8.9). Every browser request to an app carries x-suger-member-lookup: the
// organization, the person and an expiry five minutes ahead, signed for that app with a key derived from
// GATEWAY_SECRET_KEY. The app passes it back with GET /__insulin/members, so its own token alone reads no one: the
// gateway takes the organization and the person from the header, never from the app. No I/O but Web Crypto.
import { base64url, constantTimeEqual, isId, purposeKey, utf8 } from '../crypto.ts'

export const MEMBER_LOOKUP_HEADER = 'x-suger-member-lookup'
/** The HKDF purpose of the signing key: a value signed for one purpose never checks as another. */
export const MEMBER_LOOKUP_PURPOSE = 'member-lookup'
/** How long a header is good for, from the request it came with. */
export const MEMBER_LOOKUP_TTL_S = 5 * 60
// A clock a little ahead on the signing side is tolerated; anything further out was not made by this gateway.
const CLOCK_SKEW_S = 60
const VERSION = 'v1'
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/

/** What the signature covers: the version, the app, the organization, the person and the expiry. */
function signed(app: string, org: string, user: string, expires: number): string {
  return `${VERSION}|${app}|${org}|${user}|${expires}`
}

// Every browser request signs one, so an isolate derives the key once per GATEWAY_SECRET_KEY (config.ts reads it once).
const keys = new WeakMap<Uint8Array, Promise<CryptoKey>>()

/** HMAC-SHA256 with the key HKDF derives for this purpose: the same as crypto.ts derivedSecret, with the key kept. */
async function signature(master: Uint8Array, text: string): Promise<string> {
  let key = keys.get(master)
  if (!key) {
    key = purposeKey(master, MEMBER_LOOKUP_PURPOSE, 'HMAC')
    keys.set(master, key)
  }
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key, utf8(text) as Uint8Array<ArrayBuffer>)))
}

/** `v1.<organization>.<person>.<expiry, epoch seconds>.<HMAC-SHA256, base64url>`. */
export async function signMemberLookup(master: Uint8Array, app: string, org: string, user: string, now: number): Promise<string> {
  const expires = Math.floor(now / 1000) + MEMBER_LOOKUP_TTL_S
  return `${VERSION}.${org}.${user}.${expires}.${await signature(master, signed(app, org, user, expires))}`
}

export type MemberLookupCheck =
  | { org: string; user: string }
  | { problem: 'missing' | 'malformed' | 'expired' | 'invalid' }

/** The organization and person of a header signed for `app` that hasn't expired, or why not. */
export async function verifyMemberLookup(master: Uint8Array, app: string, value: string | null, now: number): Promise<MemberLookupCheck> {
  if (!value) return { problem: 'missing' }
  const parts = value.trim().split('.')
  if (parts.length !== 5) return { problem: 'malformed' }
  const [version, org, user, expiresText, given] = parts as [string, string, string, string, string]
  if (version !== VERSION || !isId(org) || !isId(user) || !/^\d{1,12}$/.test(expiresText) || !SIGNATURE.test(given)) return { problem: 'malformed' }
  const expires = Number(expiresText)
  const nowSeconds = Math.floor(now / 1000)
  if (!constantTimeEqual(given, await signature(master, signed(app, org, user, expires)))) return { problem: 'invalid' }
  if (expires < nowSeconds || expires > nowSeconds + MEMBER_LOOKUP_TTL_S + CLOCK_SKEW_S) return { problem: 'expired' }
  return { org, user }
}
