// What the member pages read and send: the app's own /api routes, on this origin, as the signed-in member (the
// platform's identity; no key of our own).

export type Permission = 'esign.manage' | 'esign.view'
export type Me = { organizationId: string; user?: { id: string; email: string | null; name: string | null }; role?: string; permissions: Permission[]; signingEnabled?: boolean }
/** The host's own labels for a template or envelope (server/esign/metadata.ts): kept, returned, never used. */
export type Metadata = Record<string, string>
/** Who usually signs as a template's role (server/esign/default-signers.ts): the send form fills them in. */
export type DefaultSigner = { name?: string; email?: string }
/**
 * Who owns a template or an envelope, the member's role in it and their own tags (server/esign/ownership.ts, tags.ts):
 * an owner is a person or an API client; nobody else's tags are shown.
 */
export type Owner = { id: string; kind: 'person' | 'client'; name?: string; email?: string }
export type DocumentRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type Owned = { owner?: Owner; myRole?: DocumentRole; tags?: string[] }
export type TemplateSummary = Owned & { id: string; name?: string; metadata?: Metadata; defaultSigners?: Record<string, DefaultSigner>; roles: string[]; fields: { type: string; role: string; page: number }[]; createdAt: number }
export type EnvelopeSummary = Owned & { id: string; templateId: string; status: string; createdAt: number; documentName?: string; metadata?: Metadata }
export type Share = { email: string; name?: string; role: Exclude<DocumentRole, 'owner'>; sharedAt: number }
export type Sharing = { id: string; myRole: DocumentRole; owner: Owner; shares: Share[] }
export type Task = { id: string; role: string; recipientName: string; recipientEmail: string; routingOrder: number; status: string; expiresAt?: string; openedAt?: string; delivery?: 'host' | 'email'; invitedAt?: string; message?: { subject?: string; body?: string } }
export type Envelope = Owned & { id: string; templateId: string; status: string; createdAt?: number; documentName?: string; metadata?: Metadata; message?: { subject?: string; body?: string }; tasks: Task[] }
/** A contact (server/esign/contacts.ts): someone the organization's envelopes named, or a member added. Never evidence. */
export type Contact = { id: string; email: string; name: string; title?: string; company?: string; envelopeCount: number; lastUsedAt?: number; createdAt: number; updatedAt: number }
export type ContactEnvelope = { id: string; status: string; createdAt: number; documentName?: string; role: string; taskStatus: string }
export type AuditEvent = { type: string; at: string; recipient?: { role: string; name: string; email: string }; ip?: string; userAgent?: string; detail?: Record<string, unknown> }

export class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code ? `${status} ${code}` : `HTTP ${status}`)
    this.status = status
    this.code = code
  }
}

/** One same-origin request; a non-2xx answer throws a RequestError with the API's error code. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin', headers: { ...(init.headers as Record<string, string> | undefined) } })
  if (!response.ok) {
    let code = ''
    try { code = ((await response.json()) as { error?: string }).error ?? '' } catch { /* not JSON */ }
    throw new RequestError(response.status, code)
  }
  return response
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await api(path, init)).json() as Promise<T>
}

/** What to tell the member when a request fails, in plain words. */
export function describeError(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.status === 401) return 'Sign in to use Esign.'
    if (error.status === 403 && error.code === 'origin_not_allowed') return 'Esign can\'t open the field editor on this page. Ask whoever runs Esign to check its ESIGN_FRAME_ANCESTORS setting.'
    if (error.status === 403) return 'Your role in Esign doesn\'t allow that.'
    if (error.status === 404 && error.code === 'signing_disabled') return 'Signing isn\'t set up on this deployment yet.'
    if (error.status === 404) return 'That isn\'t here any more, or belongs to another organization.'
    if (error.status === 409) return 'That changed meanwhile. Reload and try again.'
    if (error.status === 422 || error.status === 400) return `The request wasn't accepted (${error.code || 'invalid'}). Check the values and try again.`
    return `Request failed (${error.message}).`
  }
  return error instanceof Error ? error.message : 'Request failed.'
}

/** A page of contacts, most recently used first: those whose name or email contains `q`, after `cursor`. */
export function contactsPath(q: string, limit: number, cursor = ''): string {
  const query = new URLSearchParams({ limit: String(limit) })
  if (q.trim()) query.set('q', q.trim())
  if (cursor) query.set('cursor', cursor)
  return `/api/contacts?${query}`
}

/**
 * The default signers a template form gives, keyed by role: the name and email typed for each role, trimmed, leaving
 * out empty ones; null when there are none. An email that isn't one is the problem returned instead.
 */
export function defaultSignersOf(roles: string[], people: { name: string; email: string }[]): Record<string, DefaultSigner> | null | string {
  const entries: [string, DefaultSigner][] = []
  for (const [i, role] of roles.entries()) {
    const name = people[i]?.name.trim() ?? '', email = people[i]?.email.trim() ?? ''
    if (email && !EMAIL.test(email)) return `Enter a valid email address for ${role.trim() || `role ${i + 1}`}, or leave it empty.`
    if (name || email) entries.push([role.trim(), { ...(name ? { name } : {}), ...(email ? { email } : {}) }])
  }
  return entries.length ? Object.fromEntries(entries) : null
}

export const canManage = (me: Me | null) => !!me?.permissions.includes('esign.manage')

const RANK: Record<DocumentRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 }
/** Whether a role in a document allows what `needed` may do (server/esign/ownership.ts). */
export const allows = (role: DocumentRole | undefined, needed: DocumentRole) => !!role && RANK[role] >= RANK[needed]
export const ROLE_NAMES: Record<DocumentRole, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }
/** How an owner is named: their name, else their email; an API client by its name. */
export const ownerName = (owner: Owner | undefined, me?: Me | null) =>
  !owner ? '' : owner.id === me?.user?.id ? 'You' : owner.name ?? owner.email ?? (owner.kind === 'client' ? 'An API client' : 'Someone')

/** Which documents a list shows: all the member sees, theirs, or those shared with them. */
export type Scope = '' | 'mine' | 'shared'
/** A list's address: `/api/templates` or `/api/envelopes` with the filters given, and nothing else when there are none. */
export function listPath(base: string, filters: { status?: string; scope?: Scope; tags?: string[] }): string {
  const query = new URLSearchParams()
  if (filters.status) query.set('status', filters.status)
  if (filters.scope) query.set('scope', filters.scope)
  for (const tag of filters.tags ?? []) query.append('tag', tag)
  const text = query.toString()
  return text ? `${base}?${text}` : base
}
/** Tags as typed: separated by commas, trimmed, each once (compared case-insensitively). */
export function tagsOf(text: string): string[] {
  const seen = new Set<string>()
  return text.split(',').map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
}

/** A signer as the send form collects them: the facts a host may give about a signer, each optional but name and email. */
/**
 * `delivery` 'email': Esign emails them an invitation; otherwise ('host', the default) the page is opened for them.
 * `subject` and `body`: a message to this signer alone, instead of the envelope's.
 * `fromTemplate`: the name and email are still the template's default signer's, untouched.
 */
export type Signer = { name: string; email: string; title: string; company: string; after: string; delivery?: 'host' | 'email'; subject?: string; body?: string; fromTemplate?: boolean }
/** The sender's message to the signers: an invitation's subject, and a body shown in it and on the signing page. */
export type EnvelopeMessage = { subject: string; body: string }
/** What the sender says about the document and who sent it. */
export type DocumentFacts = { name: string; version: string; published: string; senderName: string; senderCompany: string }

/** The end of a sign-by day (YYYY-MM-DD) in the member's time zone, as an ISO time; '' when there is none. */
export function signByTime(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) return ''
  const end = new Date(`${day.trim()}T23:59:59`)
  return Number.isNaN(end.getTime()) ? '' : end.toISOString()
}

/** The body of POST /api/envelopes: one recipient per role, in order, leaving out what is empty. A sign-by day applies to every signer. */
export function envelopeRequest(templateId: string, roles: string[], people: Signer[], doc: DocumentFacts, signBy = '', message: EnvelopeMessage = { subject: '', body: '' }) {
  const text = (v: string) => v.trim()
  const deadline = signByTime(signBy)
  const published = text(doc.published) && !Number.isNaN(Date.parse(text(doc.published))) ? new Date(text(doc.published)).toISOString() : ''
  return {
    templateId,
    recipients: people.map((s, i) => {
      const after = s.after.split('\n').map(text).filter(Boolean)
      return {
        role: roles[i], name: text(s.name), email: text(s.email),
        ...(deadline ? { expiresAt: deadline } : {}),
        ...(text(s.title) ? { title: text(s.title) } : {}),
        ...(text(s.company) ? { onBehalfOf: text(s.company) } : {}),
        ...(after.length ? { afterSigning: after } : {}),
        ...(s.delivery === 'email' ? { delivery: 'email' } : {}),
        ...(text(s.subject ?? '') || text(s.body ?? '') ? { message: { ...(text(s.subject ?? '') ? { subject: text(s.subject ?? '') } : {}), ...(text(s.body ?? '') ? { body: text(s.body ?? '') } : {}) } } : {}),
      }
    }),
    ...(text(doc.name) ? { documentName: text(doc.name) } : {}),
    ...(text(doc.version) ? { documentVersion: { label: text(doc.version), ...(published ? { publishedAt: published } : {}) } } : {}),
    ...(text(doc.senderName) ? { sender: { name: text(doc.senderName), ...(text(doc.senderCompany) ? { organization: text(doc.senderCompany) } : {}) } } : {}),
    ...(text(message.subject) || text(message.body) ? { message: { ...(text(message.subject) ? { subject: text(message.subject) } : {}), ...(text(message.body) ? { body: text(message.body) } : {}) } } : {}),
  }
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MAX_PDF_BYTES = 5 * 1024 * 1024

/** Envelope statuses in plain words, and how a badge shows them. */
export const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: 'Out for signature', FINALIZING: 'Finishing', COMPLETED: 'Completed', VOIDED: 'Voided', DECLINED: 'Declined', EXPIRED: 'Expired',
}
export const TASK_LABELS: Record<string, string> = {
  PENDING: 'Waiting for an earlier signer', ACTIVE: 'Asked to sign', SIGNED: 'Signed', DECLINED: 'Declined', EXPIRED: 'Expired', VOIDED: 'Voided',
}
export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status

/** The status an Envelopes address filters by (`?status=completed` is COMPLETED), or '' for every envelope. */
export function statusFilter(search: string): string {
  const value = (new URLSearchParams(search).get('status') ?? '').toUpperCase()
  return Object.hasOwn(STATUS_LABELS, value) ? value : ''
}

/** The Envelopes address for a status ('' for every envelope), as the navigation's items name them. */
export const envelopesPath = (status: string) => status ? `/envelopes?status=${status.toLowerCase()}` : '/envelopes'
export const taskLabel = (status: string) => TASK_LABELS[status] ?? status

export const dateTime = (value: number | string | undefined) => {
  if (value === undefined) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
