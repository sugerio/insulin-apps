// Cookie parsing and serialization (RFC 6265 shapes, no dependencies).

export interface CookieOptions {
  domain?: string
  path: string
  maxAge: number
  secure: boolean
  httpOnly: boolean
  sameSite: 'Lax' | 'Strict'
}

function pairs(header: string | null): string[] {
  return header ? header.split(';').map((part) => part.trim()).filter(Boolean) : []
}

function nameOf(pair: string): string {
  const at = pair.indexOf('=')
  return (at === -1 ? '' : pair.slice(0, at)).trim()
}

/** Every value sent for `name` (browsers may send several, e.g. a host-only and a domain cookie). */
export function cookieValues(header: string | null, name: string): string[] {
  const values: string[] = []
  for (const pair of pairs(header)) {
    if (nameOf(pair) !== name) continue
    let value = pair.slice(pair.indexOf('=') + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    values.push(value)
  }
  return values
}

/** The Cookie header without the named cookies (compared ignoring case), or null when nothing is left. */
export function withoutCookies(header: string | null, names: ReadonlySet<string>): string | null {
  const kept = pairs(header).filter((pair) => !names.has(nameOf(pair).toLowerCase()))
  return kept.length ? kept.join('; ') : null
}

/** The cookie name a Set-Cookie header value sets, lower-cased. */
export function setCookieName(value: string): string {
  const first = value.split(';', 1)[0] ?? ''
  return nameOf(first.includes('=') ? first : `=${first}`).toLowerCase()
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`]
  if (options.domain) parts.push(`Domain=${options.domain}`)
  parts.push(`Path=${options.path}`)
  parts.push(`Max-Age=${options.maxAge}`)
  if (options.secure) parts.push('Secure')
  if (options.httpOnly) parts.push('HttpOnly')
  parts.push(`SameSite=${options.sameSite}`)
  return parts.join('; ')
}
