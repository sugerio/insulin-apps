import type { AppRole, CollectionRole, CollectionSummary } from './types.ts'

// Numbers, dates, roles and states in the words the screens use (design sections 06 and 10).

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
  if (bytes >= 1024 ** 2) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

export const formatNumber = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 })

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "Today, 9:16 AM", "Yesterday, 4:03 PM", "Nov 12, 11:20 AM", "Nov 12, 2025". */
export function formatWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '–'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '–'
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (sameDay(date, now)) return `Today, ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return `Yesterday, ${time}`
  if (date.getFullYear() === now.getFullYear()) return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** formatWhen inside a sentence: "the version from today, 9:16 AM". */
export const formatWhenInline = (iso: string | null | undefined, now = new Date()) => formatWhen(iso, now).replace(/^(Today|Yesterday)/, (word) => word.toLowerCase())

/** "Nov 12, 2026": a day only. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '–'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '–' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "December 1" for a limit's reset. */
export function formatResetDay(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** "about 2 minutes left", "under a minute left". */
export function timeLeft(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null
  if (seconds < 50) return 'under a minute left'
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `about ${plural(minutes, 'minute')} left`
}

/** "in about 4 minutes", "in under a minute". */
export function startsIn(seconds: number | null | undefined): string {
  if (!seconds || seconds < 50) return 'in under a minute'
  return `in about ${plural(Math.max(1, Math.round(seconds / 60)), 'minute')}`
}

export const ROLE_LABEL: Record<CollectionRole, string> = { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' }
export const APP_ROLE_LABEL: Record<AppRole, string> = { ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' }
export const ORG_ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer', APPS: 'Specific apps' }

export function appRoleLabel(role: string | null | undefined): string {
  return role && role in APP_ROLE_LABEL ? APP_ROLE_LABEL[role as AppRole] : 'No role'
}

/** "Private", "Everyone: Viewer · 2 people", as the lists say how a collection is shared. */
export function sharingSummary(sharing: CollectionSummary['sharing']): string {
  const parts: string[] = []
  if (sharing.general) parts.push(`Everyone: ${ROLE_LABEL[sharing.general]}`)
  if (sharing.people) parts.push(plural(sharing.people, 'person', 'people'))
  if (sharing.clients) parts.push(plural(sharing.clients, 'API client'))
  return parts.length ? parts.join(' · ') : 'Private'
}

export type Tone = 'green' | 'red' | 'blue' | 'amber' | 'grey'

/**
 * A collection's state for a list: the last state Knowledge heard from the engine. One that has learned something but
 * was last heard of before it did ("empty") is shown as asleep: the first question wakes it.
 */
export function listState(collection: Pick<CollectionSummary, 'state' | 'documents'>): string {
  return collection.state === 'empty' && collection.documents > 0 ? 'asleep' : collection.state
}

/** A collection's state as a short label and its tone (design section 10, "Shown as"). */
export function stateLabel(state: string): { label: string; tone: Tone } {
  switch (state) {
    case 'ready': return { label: 'Ready', tone: 'green' }
    case 'asleep': return { label: 'Asleep', tone: 'grey' }
    case 'waking': return { label: 'Waking up', tone: 'blue' }
    case 'waking_from_backup': return { label: 'Coming back from its backup', tone: 'blue' }
    case 'learning': return { label: 'Learning', tone: 'blue' }
    case 'saving': return { label: 'Saving a restore point', tone: 'blue' }
    case 'going_back': return { label: 'Going back to an earlier version', tone: 'blue' }
    case 'repairing': return { label: 'Repairing', tone: 'amber' }
    case 'deleting': return { label: 'Being deleted', tone: 'red' }
    case 'deleted': return { label: 'Deleted', tone: 'red' }
    case 'empty': return { label: 'Nothing learned yet', tone: 'grey' }
    default: return { label: 'Asleep', tone: 'grey' }
  }
}

/** The one message each state has (design section 10, "Copy"). */
export function stateMessage(state: string, name: string): string {
  switch (state) {
    case 'ready': return 'Ready · answers in a few seconds.'
    case 'asleep': return 'Asleep · your first question wakes it up (about a minute).'
    case 'waking': return `Waking up ${name}. This takes about a minute.`
    case 'waking_from_backup': return `${name} wasn't used for over 30 days, so it's coming back from its backup. This takes a few minutes.`
    case 'learning': return `${name} is learning. Questions to ${name} wait until it finishes.`
    case 'saving': return 'Saving a restore point so you can always come back to this version.'
    case 'going_back': return 'Going back to an earlier version. About a minute; questions wait for a moment.'
    case 'repairing': return `${name} couldn't open its latest restore point, so it's answering from an earlier version while Insulin repairs it.`
    case 'deleting': return `${name} is being deleted.`
    case 'empty': return 'Nothing learned yet. Add files, a web page or a note in Sources.'
    default: return 'Asleep · your first question wakes it up (about a minute).'
  }
}

/** The kind of a source as people say it. */
export function sourceKind(document: { kind: 'file' | 'note'; type: string }): 'File' | 'Web page' | 'Note' {
  if (document.kind === 'note') return 'Note'
  return document.type === 'text/html' ? 'Web page' : 'File'
}

/** Why a restore point can't be brought back, in plain words. */
export function notRestorableReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'removed_for_good': return 'This version can\'t be brought back: a file it held was removed for good after it.'
    case 'expired': return 'This version can\'t be brought back: restore points last 30 days, and this one has expired.'
    case 'engine_changed': return 'This version can\'t be brought back: Insulin Knowledge was upgraded since it was saved.'
    case 'newly_hidden': return 'This version can\'t be brought back: it holds text that a newer hiding rule hides.'
    case 'damaged': return 'This version can\'t be brought back: it was found damaged when Insulin checked it, twice.'
    default: return 'This version can\'t be brought back.'
  }
}

/** The address in a limit message ("…contact Insulin Apps support at …"), for "Copy the address". */
export function supportAddress(message: string): string | null {
  return /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(message)?.[0] ?? null
}

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** "9:00–11:00 on working days", from a keep-ready window. */
export function keepReadyLabel(window: { days: number[]; start: string; hours: number }): string {
  const [h, m] = window.start.split(':').map(Number)
  const end = `${String(((h ?? 0) + window.hours) % 24).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`
  const days = [...window.days].sort()
  const which = days.join(',') === '1,2,3,4,5' ? 'working days' : days.length === 7 ? 'every day' : days.map((day) => DAYS[day]!.slice(0, 3)).join(', ')
  return `${window.start}–${end} on ${which}`
}
