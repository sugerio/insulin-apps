import { EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { logError } from './http.ts'

/**
 * The hard stop at 100% of the month's awake hours, enforced in the engine (POST /v1/orgs/:org/hold): while held,
 * nothing runs for the organization but removing a file for good and deleting; running work stops and waits. The
 * request that meets the stop and the tick hold it until the 1st; the tick lets go when a raised limit frees it or the
 * new month comes.
 *
 * What Knowledge wants the engine to have is written first, as a new version (table `org_holds`: `until`, 0 to let
 * go), then sent, and the version sent is recorded only while it is still the one wanted. A newer wish written while
 * an older one was on its way may have reached the engine first, so it is sent again after it; and the tick sends
 * again whenever the version wanted and the version the engine took differ. A late answer never records a hold the
 * engine no longer has.
 */
export async function holdOrganization(env: Bindings, org: string, until: number, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  await env.DB.prepare(
    `INSERT INTO org_holds (org_id, until, version, delivered, held_at) VALUES (?1, ?2, 1, 0, ?3)
     ON CONFLICT (org_id) DO UPDATE SET until = excluded.until, version = org_holds.version + 1, held_at = excluded.held_at WHERE org_holds.until < excluded.until`,
  ).bind(org, until, now).run()
  return deliverHold(env, org)
}

/** Lets go of an organization's hold: its limit was raised, or the month it was held for is over. */
export async function releaseOrganization(env: Bindings, org: string, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  await env.DB.prepare(`UPDATE org_holds SET until = 0, version = version + 1, held_at = ?2 WHERE org_id = ?1 AND until != 0`).bind(org, now).run()
  return deliverHold(env, org)
}

/** Sends the organization's wanted hold (or its lift), unless the engine took that version already; true once it has. */
export async function deliverHold(env: Bindings, org: string): Promise<boolean> {
  if (!env.ENGINE) return false
  const db = env.DB
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wanted = await db.prepare(`SELECT until, version, delivered FROM org_holds WHERE org_id = ?`).bind(org).first<{ until: number; version: number; delivered: number }>()
    if (!wanted || wanted.delivered === wanted.version) return true
    try {
      await new EngineClient(env.ENGINE, org, env.DEADLINE).hold(org, { until: wanted.until ? new Date(wanted.until).toISOString() : null })
    } catch (error) {
      logError('hold_failed', error, { org })
      return false
    }
    const acknowledged = await db.prepare(`UPDATE org_holds SET delivered = ?2 WHERE org_id = ?1 AND version = ?2`).bind(org, wanted.version).run()
    if (acknowledged.meta.changes === 1) return true
    // A newer wish was written meanwhile; this one may have reached the engine after it. Unknown until sent again.
    await db.prepare(`UPDATE org_holds SET delivered = -1 WHERE org_id = ?`).bind(org).run()
  }
  return false
}
