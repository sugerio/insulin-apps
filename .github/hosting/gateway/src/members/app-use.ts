// Where each app is used (DESIGN.md §8.9): the gateway's first request to an app for an organization, by a person, an
// AI agent or an API client, is written to `app_orgs`. An isolate remembers the pairs it has written, so this costs one
// D1 write per pair and isolate, not one per request. It is written before the request goes on, so an app never serves
// an organization the limits and member endpoints don't yet answer for: when it can't be written, the request doesn't
// go on (the caller answers 503), and the next one tries again. A usage report the app sends naming an organization
// records it too (db/metrics.ts storeReport), and migration 0012 recorded where apps were used before it.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { recordAppUse } from '../db/members.ts'
import { logError } from '../log.ts'

// Bounded: past this many pairs the memory starts over (the next request for each pair writes nothing new).
const REMEMBERED_LIMIT = 10_000
const remembered = new Set<string>()

/** Whether the app's use in the organization is written (or this isolate wrote it before); false when the write failed. */
export async function noteAppUse(ctx: Context, app: HostedApp, orgId: string): Promise<boolean> {
  const pair = `${app.name}\n${orgId}`
  if (remembered.has(pair)) return true
  try {
    await recordAppUse(ctx.config.db, app.name, orgId, ctx.now)
  } catch (error) {
    logError('app_use_failed', error, { app: app.name })
    return false
  }
  if (remembered.size >= REMEMBERED_LIMIT) remembered.clear()
  remembered.add(pair)
  return true
}

/** What a caller is told when the app's use couldn't be written: the app can't take the request just now. */
export function appUseProblem(app: HostedApp): string {
  return `${app.title} isn't available right now. Try again in a minute.`
}
