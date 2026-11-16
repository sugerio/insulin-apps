// Where each app is used (DESIGN.md §8.9): the gateway's first request to an app for an organization, by a person, an
// AI agent or an API client, is written to `app_orgs`. An isolate remembers the pairs it has written, so this costs one
// D1 write per pair and isolate, not one per request. It is written before the request goes on, so an app never serves
// an organization the limits and member endpoints don't yet answer for.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { recordAppUse } from '../db/members.ts'
import { logError } from '../log.ts'

// Bounded: past this many pairs the memory starts over (the next request for each pair writes nothing new).
const REMEMBERED_LIMIT = 10_000
const remembered = new Set<string>()

export async function noteAppUse(ctx: Context, app: HostedApp, orgId: string): Promise<void> {
  const pair = `${app.name}\n${orgId}`
  if (remembered.has(pair)) return
  try {
    await recordAppUse(ctx.config.db, app.name, orgId, ctx.now)
  } catch (error) {
    // The request still goes on; the next one tries again.
    logError('app_use_failed', error, { app: app.name })
    return
  }
  if (remembered.size >= REMEMBERED_LIMIT) remembered.clear()
  remembered.add(pair)
}
