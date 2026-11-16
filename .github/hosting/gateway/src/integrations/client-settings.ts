// An app's section for each OAuth client on its API access page (DESIGN.md §5.3.1): an app that declares
// `insulin.clientSettings` (a path under /api/) keeps a few settings per OAuth client of its own, such as who sees what
// the client creates. The gateway reads them from `{path}/{service account id}` and saves them there, over the app's
// service binding, as the signed-in organization admin (the usual identity headers, `x-suger-access-via: browser`), and
// tells the app when the client is deleted. The app keeps the values; the gateway only shows and forwards them, never
// any HTML of the app's: every string is text, of a bounded length, and a field is one of the types below.
import type { HostedApp } from '../config.ts'
import { identityHeaders } from '../http/forward.ts'
import { log } from '../log.ts'
import type { AppMember } from '../orgs/app-users.ts'

/** People of the organization, chosen among its members: the value is their email addresses. */
export interface MembersField {
  name: string
  type: 'members'
  label: string
  hint: string | null
  value: string[]
}
export type ClientSettingsField = MembersField

export interface ClientSettingsSection {
  title: string
  description: string | null
  /** One line on where things stand, shown beside the title. */
  status: string | null
  fields: ClientSettingsField[]
}

/** A section, or that the app didn't answer as agreed (in time): the page says so, and the rest of it works. */
export type ClientSettingsLoad = { section: ClientSettingsSection } | { unavailable: true }

/** What saving did: saved (with the app's notice, if any), refused with what to fix, or not reached. */
export type ClientSettingsSave =
  | { ok: true; notice: string | null }
  | { ok: false; errors: Record<string, string>; message: string | null }

export const CLIENT_SETTINGS_TIMEOUT_MS = 2500
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,39}$/
const MAX_FIELDS = 5
export const MAX_MEMBERS = 50
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A string of at most `max` characters, trimmed, with no control characters; undefined when it isn't one. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return clean.length <= max ? clean : undefined
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The section an app answered, as agreed, or null. */
export function parseClientSettings(raw: unknown): ClientSettingsSection | null {
  if (!record(raw) || !Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > MAX_FIELDS) return null
  const title = text(raw.title, 80)
  const description = raw.description === undefined ? null : text(raw.description, 300)
  const status = raw.status === undefined ? null : text(raw.status, 200)
  if (!title || description === undefined || status === undefined) return null
  const fields: ClientSettingsField[] = []
  const names = new Set<string>()
  for (const item of raw.fields) {
    if (!record(item) || typeof item.name !== 'string' || !FIELD_NAME.test(item.name) || names.has(item.name)) return null
    names.add(item.name)
    const label = text(item.label, 80), hint = item.hint === undefined ? null : text(item.hint, 200)
    if (!label || hint === undefined) return null
    if (item.type === 'members') {
      if (!Array.isArray(item.value) || item.value.length > MAX_MEMBERS || item.value.some((email) => typeof email !== 'string' || email.length > 254 || !EMAIL.test(email))) return null
      fields.push({ name: item.name, type: 'members', label, hint, value: item.value as string[] })
    } else return null
  }
  return { title, description, status, fields }
}

/** A request to the app's client settings for one client, as the signed-in organization admin. */
function call(app: HostedApp, member: AppMember, accountId: string, init: { method: string; query?: string; body?: unknown }): Promise<Response> {
  const user = member.session.user
  const headers: Record<string, string> = identityHeaders({ id: user.id, email: user.email, name: user.name }, member.membership.org_id, app, member.access, 'browser')
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const url = `https://${app.host}${app.clientSettings}/${encodeURIComponent(accountId)}${init.query ?? ''}`
  return app.service!.fetch(new Request(url, {
    method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(CLIENT_SETTINGS_TIMEOUT_MS),
  }))
}

/** Whether the app has a section for its OAuth clients, and can be reached. */
export const hasClientSettings = (app: HostedApp): boolean => !!app.clientSettings && !!app.service

/** The app's section for one client (`name`, so that a client which hasn't called the app yet is named there too). */
export async function loadClientSettings(app: HostedApp, member: AppMember, account: { id: string; name: string }): Promise<ClientSettingsLoad> {
  try {
    const response = await call(app, member, account.id, { method: 'GET', query: `?name=${encodeURIComponent(account.name)}` })
    const section = response.ok ? parseClientSettings(await response.json()) : null
    if (section) return { section }
    log('client_settings_unavailable', { app: app.name, account: account.id, status: response.status })
  } catch (error) {
    log('client_settings_unavailable', { app: app.name, account: account.id, error: error instanceof Error ? error.name : 'error' })
  }
  return { unavailable: true }
}

/** Saves the values of the client's section: the app answers 200 ({notice?}) or 422 ({errors?, message?}). */
export async function saveClientSettings(app: HostedApp, member: AppMember, accountId: string, values: Record<string, unknown>): Promise<ClientSettingsSave> {
  try {
    const response = await call(app, member, accountId, { method: 'POST', body: { values } })
    const answer: unknown = await response.json().catch(() => ({}))
    if (response.ok) return { ok: true, notice: (record(answer) ? text(answer.notice, 300) : undefined) || null }
    if (response.status === 422 && record(answer)) {
      const errors: Record<string, string> = {}
      if (record(answer.errors)) for (const [name, message] of Object.entries(answer.errors)) { const clean = text(message, 300); if (FIELD_NAME.test(name) && clean) errors[name] = clean }
      return { ok: false, errors, message: text(answer.message, 300) || null }
    }
    log('client_settings_not_saved', { app: app.name, account: accountId, status: response.status })
  } catch (error) {
    log('client_settings_not_saved', { app: app.name, account: accountId, error: error instanceof Error ? error.name : 'error' })
  }
  return { ok: false, errors: {}, message: null }
}

/** Tells the app the client was deleted, so it can forget its settings; whatever happens, the deletion stands. */
export async function forgetClientSettings(app: HostedApp, member: AppMember, accountId: string): Promise<void> {
  if (!hasClientSettings(app)) return
  try {
    const response = await call(app, member, accountId, { method: 'DELETE' })
    if (!response.ok) log('client_settings_not_forgotten', { app: app.name, account: accountId, status: response.status })
  } catch (error) {
    log('client_settings_not_forgotten', { app: app.name, account: accountId, error: error instanceof Error ? error.name : 'error' })
  }
}

/**
 * The values a submitted form gives a section's fields, as the app is sent them: a members field keeps the addresses
 * picked that are the organization's members' (compared without regard to case, spelled as the member's), at most 50.
 */
export function formValues(section: ClientSettingsSection, form: URLSearchParams, memberEmails: readonly string[]): Record<string, unknown> {
  const known = new Map(memberEmails.map((email) => [email.toLowerCase(), email]))
  const values: Record<string, unknown> = {}
  for (const field of section.fields) {
    const picked = form.getAll(field.name).map((email) => known.get(email.trim().toLowerCase())).filter((email): email is string => !!email)
    values[field.name] = [...new Set(picked)].slice(0, MAX_MEMBERS)
  }
  return values
}
