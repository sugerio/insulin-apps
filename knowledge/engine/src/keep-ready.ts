// Keep-ready windows in the organization's time zone: one window on each chosen day, `hours` long from `start`.

import type { KeepReady } from './contract.ts'

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const DAY_MS = 24 * 60 * 60 * 1000

export function validTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  }
}

/** The UTC instant of a wall-clock time in a time zone (the earlier one when a clock change repeats it). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wanted
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone)
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    const delta = wanted - shown
    if (delta === 0) break
    guess += delta
  }
  return guess
}

function startOn(keepReady: KeepReady, year: number, month: number, day: number): number {
  const [hour, minute] = keepReady.start.split(':').map(Number)
  return zonedToUtc(year, month, day, hour, minute, keepReady.timeZone)
}

/** The window that contains `ms`, if any. */
export function windowAt(keepReady: KeepReady | null, ms: number): { start: number; end: number } | null {
  if (!keepReady || keepReady.paused || !keepReady.days.length) return null
  for (const offset of [0, -1]) {
    const p = zonedParts(ms + offset * DAY_MS, keepReady.timeZone)
    if (!keepReady.days.includes(p.weekday)) continue
    const start = startOn(keepReady, p.year, p.month, p.day)
    const end = start + keepReady.hours * 60 * 60 * 1000
    if (start <= ms && ms < end) return { start, end }
  }
  return null
}

/** The start of the next window after `ms`, within the next 8 days. */
export function nextWindowStart(keepReady: KeepReady | null, ms: number): number | null {
  if (!keepReady || keepReady.paused || !keepReady.days.length) return null
  for (let offset = 0; offset <= 8; offset++) {
    const p = zonedParts(ms + offset * DAY_MS, keepReady.timeZone)
    if (!keepReady.days.includes(p.weekday)) continue
    const start = startOn(keepReady, p.year, p.month, p.day)
    if (start > ms) return start
  }
  return null
}

export function validateKeepReady(value: unknown): KeepReady | null | string {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return 'keepReady must be an object or null.'
  const k = value as Partial<KeepReady>
  if (!validTimeZone(k.timeZone)) return 'keepReady.timeZone must be an IANA time zone, such as "Europe/Berlin".'
  if (!Array.isArray(k.days) || k.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return 'keepReady.days must list days from 0 (Sunday) to 6 (Saturday).'
  }
  if (typeof k.start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(k.start)) return 'keepReady.start must be a time such as "09:00".'
  if (!Number.isInteger(k.hours) || (k.hours as number) < 1 || (k.hours as number) > 3) return 'keepReady.hours must be 1, 2 or 3.'
  return { timeZone: k.timeZone, days: [...new Set(k.days)].sort(), start: k.start, hours: k.hours as number, paused: k.paused === true }
}
