// Owner domains (DESIGN.md §3.1) and the public mail providers no organization may claim (§7). Pure and free of the
// rest of the gateway: .github/hosting/scripts/allow-orgs.mjs imports this file too (Node strips the types), so the
// operator's command and the gateway write an owner domain the same way.
import { getDomain } from 'tldts'
import listedProviders from 'email-providers/all.json' with { type: 'json' }

/**
 * The providers the gateway listed before email-providers was added (migration 0007 copies them); kept, as that list
 * lacks a few of them.
 */
const OWN_PROVIDERS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com',
  'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com',
]

/** Names reserved for documentation (RFC 2606) that email-providers lists anyway: nobody's mail provider. */
const RESERVED = new Set(['example.com', 'example.net', 'example.org'])

/**
 * The part of an address after the @, which domain rules compare, in the form domains are stored: lower case and
 * punycode (so `bücher.example` and `xn--bcher-kva.example` are the same domain). Unparseable: returned as it is.
 */
export function domainOf(email: string): string {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  try {
    return new URL(`http://${domain}`).hostname
  } catch {
    return domain
  }
}

/**
 * Public mail providers: anyone can have an address there. Ours and email-providers' list (free and regional providers
 * such as hotmail.co.uk, web.de or naver.com), lower case and in punycode.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set(
  [...OWN_PROVIDERS, ...listedProviders]
    .filter((domain) => !domain.includes('@'))
    .map((domain) => (/^[\x21-\x7e]+$/.test(domain) ? domain.toLowerCase() : domainOf(`@${domain}`)))
    .filter((domain) => !RESERVED.has(domain)),
)

/**
 * The registrable domain (the public suffix and one label more, from the ICANN section of the Public Suffix List) of
 * a domain written as domainOf writes it: `one.example.co.uk` is `example.co.uk`. Null for an IP address or a public
 * suffix itself.
 */
export function registrableDomain(domain: string): string | null {
  return getDomain(domain, { extractHostname: false })
}

/** Whether `domain`, or its registrable domain, is a public mail provider. */
export function isPublicMailDomain(domain: string): boolean {
  if (PUBLIC_MAIL_DOMAINS.has(domain)) return true
  const registrable = registrableDomain(domain)
  return registrable !== null && PUBLIC_MAIL_DOMAINS.has(registrable)
}

const GMAIL = 'gmail.com'

/**
 * An address at a public mail provider as one person's owner domain: lower case, without a +tag; at Gmail, which
 * ignores dots and also answers at googlemail.com, without dots and at gmail.com (migration 0009 writes the same).
 */
function personalOwnerDomain(email: string, domain: string): string {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase()
  const plus = local.indexOf('+')
  const untagged = plus > 0 ? local.slice(0, plus) : local
  return domain === GMAIL || domain === 'googlemail.com' ? `${untagged.replaceAll('.', '')}@${GMAIL}` : `${untagged}@${domain}`
}

/**
 * The owner domain an organization created by `email` counts against: the registrable domain of the address's domain
 * (lower case, punycode), so every subdomain counts as its domain; at a public mail provider, the person's address
 * (personalOwnerDomain), so each person there counts on their own and the provider as a whole isn't limited.
 */
export function ownerDomainOf(email: string): string {
  const domain = domainOf(email)
  if (isPublicMailDomain(domain)) return personalOwnerDomain(email, domain)
  return registrableDomain(domain) ?? domain
}

/**
 * A LIKE pattern (escape character `\`) for the subdomains of owner domain `ownerDomain`, whose organizations count
 * with it: rows written before migration 0009 hold the creator's whole domain. Null for an address, or a domain that
 * isn't registrable (an IP address, a public suffix), which counts only as itself.
 */
export function subdomainPattern(ownerDomain: string): string | null {
  if (ownerDomain.includes('@') || registrableDomain(ownerDomain) !== ownerDomain) return null
  return `%.${ownerDomain.replace(/[\\%_]/g, '\\$&')}`
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const LOCAL_PART = /^[a-z0-9._-]{1,64}$/

/** A domain, lower case and in punycode, or null. Only letters, digits, dots and hyphens are accepted at all. */
function plainHostname(text: string): string | null {
  if (!text || /[^\p{L}\p{M}\p{N}.-]/u.test(text)) return null
  let host: string
  try {
    host = new URL(`http://${text}`).hostname
  } catch {
    return null
  }
  return HOSTNAME.test(host) && !/^[\d.]+$/.test(host) ? host : null
}

/**
 * The strict check of an owner domain someone writes, as `allow-orgs.mjs --domain` applies it: a registrable domain
 * that isn't a public mail provider, or an address at a public mail provider with only letters, digits, dots, hyphens
 * and underscores before the @ (no +tag). Lower case, punycode, a final dot and Gmail's form are applied, so the
 * result is the owner domain the gateway counts; anything else is refused, with the reason.
 */
export function checkOwnerDomain(input: unknown): { ownerDomain: string } | { problem: string } {
  const text = String(input ?? '').trim().toLowerCase().replace(/\.$/, '')
  const at = text.lastIndexOf('@')
  const host = plainHostname(at === -1 ? text : text.slice(at + 1))
  if (!host) return { problem: 'must be a domain such as example.com, or an address at a public mail provider' }
  if (at !== -1) {
    const local = text.slice(0, at)
    if (!LOCAL_PART.test(local)) {
      return { problem: 'an address must be the owner domain the request names, letters, digits, dots, hyphens and underscores before the @ (no +tag)' }
    }
    const owned = ownerDomainOf(`${local}@${host}`)
    if (!owned.includes('@')) return { problem: `${local}@${host} isn't at a public mail provider: its owner domain is ${owned}` }
    return { ownerDomain: owned }
  }
  if (isPublicMailDomain(host)) return { problem: `${host} is a public mail provider: give the person's address there instead` }
  const registrable = registrableDomain(host)
  if (registrable === null) return { problem: `${host} is a public suffix, not a domain someone owns` }
  if (registrable !== host) return { problem: `${host} counts as its registrable domain ${registrable}: give that instead` }
  return { ownerDomain: host }
}
