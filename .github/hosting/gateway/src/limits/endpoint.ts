// GET /__insulin/limits?since=<cursor> (DESIGN.md §12.2): an app's limits as the console's admins set them, read on its
// tick with SUGER_APP_TOKEN over SUGER_GATEWAY. The answer holds every key's default in force and the organizations
// (where the app is used) whose overrides changed after the cursor, each with all its current overrides, so the app
// replaces that organization's overrides with them; without `since`, every organization with an override.
import type { Context } from '../context.ts'
import { limitsAfter, defaultInForce } from '../db/limits.ts'
import { appCaller, problem, readCursor } from '../http/app-caller.ts'
import { jsonResponse } from '../http/response.ts'
import { log } from '../log.ts'

/** Organizations in one page. */
export const ORGANIZATIONS_PER_PAGE = 500

type Override = { value: number | null; until: string | null }

export async function appLimits(ctx: Context): Promise<Response> {
  const app = await appCaller(ctx, 'GET', 'limits')
  if (app instanceof Response) return app
  const sinceText = ctx.url.searchParams.get('since')
  const since = sinceText === null ? 0 : readCursor(sinceText)
  if (since === null) return problem('invalid_request', 400)
  const page = await limitsAfter(ctx.config.db, app.name, since, ORGANIZATIONS_PER_PAGE, sinceText === null)
  const keys = new Set(page.catalog.map((row) => row.key))
  const set = new Map(page.defaults.map((row) => [row.key, row]))
  const defaults: Record<string, number | null> = {}
  for (const row of page.catalog) defaults[row.key] = defaultInForce(row, set.get(row.key))

  // Rows come one per override (or one with no key for an organization without any), oldest change first.
  const organizations: { id: string; seq: number; limits: Record<string, Override> }[] = []
  for (const row of page.changes) {
    let entry = organizations[organizations.length - 1]
    if (entry?.id !== row.org_id) {
      entry = { id: row.org_id, seq: row.seq, limits: {} }
      organizations.push(entry)
    }
    if (row.key !== null && keys.has(row.key)) entry.limits[row.key] = { value: row.value, until: row.until === null ? null : new Date(row.until).toISOString() }
  }
  const more = organizations.length > ORGANIZATIONS_PER_PAGE
  const listed = organizations.slice(0, ORGANIZATIONS_PER_PAGE)
  // A full page continues after its last organization's change; otherwise the app has every change up to now.
  const cursor = more ? listed[listed.length - 1]!.seq : Math.max(since, page.latest)
  log('app_limits_read', { app: app.name, organizations: listed.length, more })
  return jsonResponse({
    defaults,
    organizations: listed.map((entry) => ({ id: entry.id, limits: entry.limits })),
    cursor: String(cursor),
    more,
  }, 200, { 'Cache-Control': 'no-store' })
}
