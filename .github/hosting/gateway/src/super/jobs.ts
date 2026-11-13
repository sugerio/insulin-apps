// The operator console's hourly work, on the gateway's five-minute tick (scheduled.ts): the first tick of each hour
// that claims the hour's run takes the Cloudflare snapshot (DESIGN.md §11.5). A tick that finds the hour claimed does
// nothing, so a missed or failed tick is made up by the next one, and two ticks never both run it.
import type { Config } from '../config.ts'
import { HOUR_MS } from '../db/metrics.ts'
import { log, logError } from '../log.ts'
import { takeSnapshot } from './cloudflare.ts'
import { claimJob, finishJob, insertSnapshot } from './db.ts'

export const CLOUDFLARE_JOB = 'cloudflare'

/** Takes this hour's Cloudflare snapshot if no tick has yet; quiet when the console's token isn't configured. */
export async function runHourlyJobs(config: Pick<Config, 'db' | 'cloudflare'>, now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const cloudflare = config.cloudflare
  if (!cloudflare) return
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS
  if (!(await claimJob(config.db, CLOUDFLARE_JOB, hour, now))) return
  try {
    const snapshot = await takeSnapshot(cloudflare, now, fetchImpl)
    await insertSnapshot(config.db, now, snapshot)
    const outcome = snapshot.problems.length ? 'partial' : 'ok'
    await finishJob(config.db, CLOUDFLARE_JOB, hour, outcome, Date.now())
    log('cloudflare_snapshot', { outcome })
  } catch (error) {
    logError('cloudflare_snapshot_failed', error)
    await finishJob(config.db, CLOUDFLARE_JOB, hour, 'failed', Date.now()).catch(() => {})
  }
}
