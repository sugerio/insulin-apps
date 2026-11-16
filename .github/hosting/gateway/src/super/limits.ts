// What a console admin types into a limit's form (DESIGN.md §11.7): a value in the limit's unit, or "unlimited", and an
// optional last day for an organization's override. Pure, so the unit tests import it directly.
import type { LimitUnit } from '../db/limits.ts'

/** The largest value a limit may hold, as for usage metrics (§8.6). */
export const LIMIT_MAX = 1e15
const DAY_MS = 24 * 60 * 60 * 1000
// Sizes in binary units, as the console shows them (pages/super/parts.tsx bytes()).
const SIZE_UNITS: Record<string, number> = { b: 1, byte: 1, bytes: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

/**
 * A limit's value: a whole number (for bytes, a size like `25 MB` or `2 GB`, binary units), or null for "unlimited";
 * otherwise the problem to show.
 */
export function parseLimitValue(unit: LimitUnit, input: string): { value: number | null } | { problem: string } {
  const text = input.trim().toLowerCase().replaceAll(',', '')
  if (text === 'unlimited') return { value: null }
  if (unit === 'bytes') {
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)?$/.exec(text)
    const factor = match ? SIZE_UNITS[match[2] ?? 'b'] : undefined
    if (!match || factor === undefined) return { problem: 'Enter a size such as 25 MB or 2 GB, or unlimited.' }
    const value = Math.round(Number(match[1]) * factor)
    return Number.isSafeInteger(value) && value <= LIMIT_MAX ? { value } : { problem: 'That size is too large.' }
  }
  if (!/^\d{1,16}$/.test(text)) return { problem: 'Enter a whole number, or unlimited.' }
  const value = Number(text)
  return value <= LIMIT_MAX ? { value } : { problem: 'That number is too large.' }
}

/**
 * An override's last day (`YYYY-MM-DD`, UTC), as the moment it ends: the start of the next day. Empty means it doesn't
 * end. A day before today is refused, and so is one more than ten years ahead.
 */
export function parseEndDate(input: string, now: number): { until: number | null } | { problem: string } {
  const text = input.trim()
  if (!text) return { until: null }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const day = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
  // Date.UTC rolls an impossible date over (February 30): only a day that reads back as typed is one.
  if (!match || Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== text) return { problem: 'Enter the last day as a date, or leave it empty.' }
  const until = day + DAY_MS
  if (until <= now) return { problem: 'The last day can\'t be in the past.' }
  if (until > now + 10 * 365 * DAY_MS) return { problem: 'Choose a last day within ten years.' }
  return { until }
}
