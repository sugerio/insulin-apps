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
 * go), then sent with its version; the engine ignores a version older than the one it has, so a late delivery never
 * undoes a newer one. The version is recorded as taken only when the engine's answer is what it asks for and it is
 * still the one wanted; a failed or unanswered send (the engine may have it or not) leaves it unknown, and the tick
 * sends the newest again whenever the version wanted and the version taken differ.
 */
export async function holdOrganization(env: Bindings, org: string, until: number, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  // Versions only grow, even for an organization deleted and made again: a new row starts from the time.
  await env.DB.prepare(
    `INSERT INTO org_holds (org_id, until, version, delivered, held_at) VALUES (?1, ?2, ?3, 0, ?3)
     ON CONFLICT (org_id) DO UPDATE SET until = excluded.until, version = org_holds.version + 1, held_at = excluded.held_at WHERE org_holds.until < excluded.until`,
  ).bind(org, until, now).run()
  return deliverHold(env, org, now)
}

/** Lets go of an organization's hold: its limit was raised, or the month it was held for is over. */
export async function releaseOrganization(env: Bindings, org: string, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  await env.DB.prepare(`UPDATE org_holds SET until = 0, version = version + 1, held_at = ?2 WHERE org_id = ?1 AND until != 0`).bind(org, now).run()
  return deliverHold(env, org, now)
}

/** Sends the organization's wanted hold (or its lift) with its version, unless the engine took it already; true once it has. */
export async function deliverHold(env: Bindings, org: string, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  const db = env.DB
  const unknown = () => db.prepare(`UPDATE org_holds SET delivered = -1 WHERE org_id = ?`).bind(org).run()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wanted = await db.prepare(`SELECT until, version, delivered FROM org_holds WHERE org_id = ?`).bind(org).first<{ until: number; version: number; delivered: number }>()
    if (!wanted || wanted.delivered === wanted.version) return true
    let answer: { held: boolean; until: string | null }
    try {
      answer = await new EngineClient(env.ENGINE, org, env.DEADLINE).hold(org, { until: wanted.until ? new Date(wanted.until).toISOString() : null, version: wanted.version })
    } catch (error) {
      // It may have reached the engine (an answer lost, a timeout): what the engine has is unknown until sent again.
      await unknown()
      logError('hold_failed', error, { org })
      return false
    }
    if (reflects(answer, wanted.until, now)) {
      const acknowledged = await db.prepare(`UPDATE org_holds SET delivered = ?2 WHERE org_id = ?1 AND version = ?2`).bind(org, wanted.version).run()
      if (acknowledged.meta.changes === 1) return true
    }
    // A newer wish was written meanwhile, or the engine answered with another state: sent again.
    await unknown()
  }
  return false
}

/** Whether the engine's answer is what the hold asks for: held until its time, or not held (let go, or over already). */
function reflects(answer: { held: boolean; until: string | null }, until: number, now: number): boolean {
  if (answer.held) return until > 0 && answer.until !== null && Date.parse(answer.until) === until
  return until === 0 || until <= now
}
