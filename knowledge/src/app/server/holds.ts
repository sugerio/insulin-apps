import { EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { logError } from './http.ts'

/**
 * The hard stop at 100% of the month's awake hours, enforced in the engine (POST /v1/orgs/:org/hold): while held,
 * nothing runs for the organization but removing a file for good and deleting; running work stops and waits. The
 * request that meets the stop and the tick hold it until the 1st; the tick lets go when a raised limit frees it or the
 * new month comes (table `org_holds`).
 */
export async function holdOrganization(env: Bindings, org: string, until: number, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  const db = env.DB
  const known = await db.prepare(`SELECT until FROM org_holds WHERE org_id = ?`).bind(org).first<{ until: number }>()
  if (known && known.until >= until) return true
  try {
    await new EngineClient(env.ENGINE, org, env.DEADLINE).hold(org, { until: new Date(until).toISOString() })
  } catch (error) {
    logError('hold_failed', error, { org })
    return false
  }
  await db.prepare(`INSERT INTO org_holds (org_id, until, held_at) VALUES (?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET until = excluded.until, held_at = excluded.held_at`)
    .bind(org, until, now).run()
  return true
}

/** Lets go of an organization's hold: its limit was raised, or the month it was held for is over. */
export async function releaseOrganization(env: Bindings, org: string): Promise<boolean> {
  if (!env.ENGINE) return false
  try {
    await new EngineClient(env.ENGINE, org, env.DEADLINE).hold(org, { until: null })
  } catch (error) {
    logError('release_failed', error, { org })
    return false
  }
  await env.DB.prepare(`DELETE FROM org_holds WHERE org_id = ?`).bind(org).run()
  return true
}
