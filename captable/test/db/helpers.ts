import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from 'drizzle-orm/d1/migrator'
import { type LocalD1, openLocalD1 } from '../../src/local-d1.ts'

/** The app's Drizzle Kit migrations (src/app/db/migrations). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../src/app/db/migrations', import.meta.url))

/**
 * A fresh, empty app database for one test: in-memory SQLite behind the preview's D1 stand-in (src/local-d1.ts:
 * foreign keys enforced, SQL transactions refused, `batch()` atomic), with every migration applied by Drizzle's D1
 * migrator, the way src/platform.local.ts brings up the preview database. Each call returns an independent database;
 * close it when the test is done. Creating the schema takes SQLite tens of milliseconds, so tests that don't interfere
 * can share one database per file (beforeAll).
 *
 *   const db = await openMigratedDatabase()
 *   await db.prepare('SELECT count(*) AS n FROM transaction_types').first('n') // 49
 *   db.close()
 */
export async function openMigratedDatabase(): Promise<LocalD1> {
  const database = await openLocalD1(':memory:')
  await migrate(drizzle(database), { migrationsFolder: MIGRATIONS_FOLDER })
  return database
}

/** Every migration's SQL, in the order drizzle-kit's journal applies them. */
export function readMigrations(): { tag: string; sql: string }[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[]
  }
  return journal.entries.map(({ tag }) => ({ tag, sql: readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8') }))
}
