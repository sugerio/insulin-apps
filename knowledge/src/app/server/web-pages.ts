import { ApiError } from './http.ts'

/**
 * Web pages are fetched by the app, then learned like an HTML file. Only public pages: http or https on the usual
 * ports, a host name that isn't local or private and no private or reserved IP address (redirects are followed by
 * hand, at most 3, each checked the same way), HTML or plain text, at most 5 MB. Errors are plain words; the raw
 * error goes to the log.
 */
export const WEB_PAGE_MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 10_000

function privateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}

function privateIPv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!bare.includes(':')) return false
  if (bare === '::' || bare === '::1') return true
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return privateIPv4(mapped[1]!)
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(bare) || bare.startsWith('64:ff9b:') || bare.startsWith('2001:db8')
}

/** Why an address can't be fetched, or null when it may be. */
export function webAddressProblem(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "That isn't a web address. Copy it from your browser's address bar, starting with https://."
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only web pages (http or https) can be added.'
  if (url.username || url.password) return "Addresses with a user name or password can't be added."
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || /\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host) || host === 'localhost') {
    return "Only public web pages can be added. This address isn't on the public internet."
  }
  if (privateIPv4(host) || privateIPv6(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return "Only public web pages can be added. This address isn't on the public internet."
  }
  if (url.port && url.port !== '80' && url.port !== '443') return 'Only pages on the usual web ports can be added.'
  return null
}

export interface FetchedPage {
  url: string
  title: string
  html: Uint8Array<ArrayBuffer>
  type: string
}

/** Fetches a public web page within the size cap, following at most 3 redirects, each checked. */
export async function fetchWebPage(raw: string, send: typeof fetch = fetch): Promise<FetchedPage> {
  let address = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const problem = webAddressProblem(address)
    if (problem) throw new ApiError('bad_request', problem)
    let response: Response
    try {
      response = await send(address, { redirect: 'manual', headers: { accept: 'text/html, text/plain;q=0.8', 'user-agent': 'Insulin Knowledge (reads pages people add)' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new ApiError('unreachable', "Couldn't reach that page. Check the address, or try again later.")
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new ApiError('unreachable', "That page sends visitors elsewhere without saying where, so it can't be added.")
      address = new URL(location, address).toString()
      continue
    }
    if (response.status === 401 || response.status === 403) throw new ApiError('unreachable', 'That page needs a sign-in, so Insulin can\'t read it. Save it as a file and add the file instead.')
    if (response.status === 404 || response.status === 410) throw new ApiError('unreachable', "That page doesn't exist. Check the address.")
    if (!response.ok) throw new ApiError('unreachable', "Couldn't read that page right now. Try again later.")
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type && type !== 'text/html' && type !== 'text/plain' && type !== 'application/xhtml+xml') {
      throw new ApiError('unsupported_type', "That address isn't a web page. If it is a file, download it and add the file instead.")
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > WEB_PAGE_MAX_BYTES) throw new ApiError('payload_too_large', 'That page is too large to add (more than 5 MB).')
    const bytes = await readCapped(response, WEB_PAGE_MAX_BYTES)
    const text = new TextDecoder().decode(bytes)
    const title = text.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() || new URL(address).hostname
    return { url: address, title, html: bytes, type: type === 'text/plain' ? 'text/plain' : 'text/html' }
  }
  throw new ApiError('unreachable', 'That page redirects too many times, so it can\'t be added.')
}

async function readCapped(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new ApiError('payload_too_large', 'That page is too large to add (more than 5 MB).')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
