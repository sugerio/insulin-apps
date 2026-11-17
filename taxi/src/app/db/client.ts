import { drizzle } from 'drizzle-orm/d1'
import { openAppD1 } from '#platform'
import * as schema from './schema'

/**
 * The app's own SQLite database with the Cloudflare D1 interface: the D1
 * binding when published (migrated by the deployment pipeline), a
 * D1-compatible file in the preview (migrated as it opens). Called per use:
 * Workers allow no I/O while modules load.
 */
export async function getDatabase() {
  return drizzle(await openAppD1(), { schema })
}
