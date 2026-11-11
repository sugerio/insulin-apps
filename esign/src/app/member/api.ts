// What the member pages read and send: the app's own /api routes, on this origin, as the signed-in member (the
// platform's identity; no key of our own).

export type Permission = 'esign.manage' | 'esign.view'
export type Me = { organizationId: string; user?: { id: string; email: string | null; name: string | null }; role?: string; permissions: Permission[]; signingEnabled?: boolean }
/** The host's own labels for a template or envelope (server/esign/metadata.ts): kept, returned, never used. */
export type Metadata = Record<string, string>
export type TemplateSummary = { id: string; name?: string; metadata?: Metadata; roles: string[]; fields: { type: string; role: string; page: number }[]; createdAt: number }
export type EnvelopeSummary = { id: string; templateId: string; status: string; createdAt: number; documentName?: string; metadata?: Metadata }
export type Task = { id: string; role: string; recipientName: string; recipientEmail: string; routingOrder: number; status: string; expiresAt?: string; openedAt?: string }
export type Envelope = { id: string; templateId: string; status: string; createdAt?: number; documentName?: string; metadata?: Metadata; tasks: Task[] }
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
    if (error.status === 401) return 'Sign in to use E-sign.'
    if (error.status === 403 && error.code === 'origin_not_allowed') return 'E-sign can\'t open the field editor on this page. Ask whoever runs E-sign to check its ESIGN_FRAME_ANCESTORS setting.'
    if (error.status === 403) return 'Your role in E-sign doesn\'t allow that.'
    if (error.status === 404 && error.code === 'signing_disabled') return 'Signing isn\'t set up on this deployment yet.'
    if (error.status === 404) return 'That isn\'t here any more, or belongs to another organization.'
    if (error.status === 409) return 'That changed meanwhile. Reload and try again.'
    if (error.status === 422 || error.status === 400) return `The request wasn't accepted (${error.code || 'invalid'}). Check the values and try again.`
    return `Request failed (${error.message}).`
  }
  return error instanceof Error ? error.message : 'Request failed.'
}

export const canManage = (me: Me | null) => !!me?.permissions.includes('esign.manage')

/** A signer as the send form collects them: the facts a host may give about a signer, each optional but name and email. */
export type Signer = { name: string; email: string; title: string; company: string; after: string }
/** What the sender says about the document and who sent it. */
export type DocumentFacts = { name: string; version: string; published: string; senderName: string; senderCompany: string }

/** The end of a sign-by day (YYYY-MM-DD) in the member's time zone, as an ISO time; '' when there is none. */
export function signByTime(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.trim())) return ''
  const end = new Date(`${day.trim()}T23:59:59`)
  return Number.isNaN(end.getTime()) ? '' : end.toISOString()
}

/** The body of POST /api/envelopes: one recipient per role, in order, leaving out what is empty. A sign-by day applies to every signer. */
export function envelopeRequest(templateId: string, roles: string[], people: Signer[], doc: DocumentFacts, signBy = '') {
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
      }
    }),
    ...(text(doc.name) ? { documentName: text(doc.name) } : {}),
    ...(text(doc.version) ? { documentVersion: { label: text(doc.version), ...(published ? { publishedAt: published } : {}) } } : {}),
    ...(text(doc.senderName) ? { sender: { name: text(doc.senderName), ...(text(doc.senderCompany) ? { organization: text(doc.senderCompany) } : {}) } } : {}),
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
export const taskLabel = (status: string) => TASK_LABELS[status] ?? status

export const dateTime = (value: number | string | undefined) => {
  if (value === undefined) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
