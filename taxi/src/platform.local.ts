import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from 'drizzle-orm/d1/migrator'
import { type LocalD1, type LocalD1Database, openLocalD1 } from './local-d1.ts'

/**
 * The AppBuilder preview and local runs: process.env, and a D1-compatible SQLite
 * file under .suger/data. Worker builds use platform.worker.ts instead (the
 * `#platform` alias in vite.config.ts). A published app's bindings and secrets
 * do not exist here, so the Suger helpers report that the app must be published.
 */
export function readAppEnv(name: string): string | undefined {
  const value = process.env[name]
  return typeof value === 'string' ? value : undefined
}

let current: { journal: string; database: Promise<LocalD1> } | undefined

/**
 * The preview database, brought up to date with the app's Drizzle migrations
 * when it opens and again whenever drizzle-kit's journal changes, so a new
 * migration applies without restarting the dev server.
 */
export function openAppD1(): Promise<LocalD1Database> {
  const migrationsFolder =
    process.env.SUGER_APP_MIGRATIONS_DIR ?? resolve('src/app/db/migrations')
  const journal = readJournal(migrationsFolder)
  if (current?.journal !== journal) {
    const entry = {
      journal,
      database: migrated(current?.database, journal ? migrationsFolder : null),
    }
    current = entry
    entry.database.catch(() => {
      if (current === entry) current = undefined
    })
  }
  return current.database
}

function readJournal(migrationsFolder: string): string {
  try {
    return readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * The file is a throwaway, per-browser copy. When it holds tables that Drizzle's
 * `__drizzle_migrations` ledger does not record (the migrations were
 * regenerated), they cannot run on top of it, so it starts over instead of
 * failing the preview.
 */
async function migrated(
  previous: Promise<LocalD1> | undefined,
  migrationsFolder: string | null,
): Promise<LocalD1> {
  const path = resolve(process.env.SUGER_APP_DATA_DIR ?? resolve('.suger/data'), 'app.sqlite')
  const database = (await previous?.catch(() => undefined)) ?? (await openLocalD1(path))
  if (!migrationsFolder) return database
  try {
    await migrate(drizzle(database), { migrationsFolder })
    return database
  } catch (error) {
    if (!isLeftoverSchemaError(error)) throw error
    console.warn(
      `[suger] The preview database's tables are out of step with the app's migrations; starting it over (${String(error)})`,
    )
    database.close()
    rmSync(path, { force: true })
    const fresh = await openLocalD1(path)
    await migrate(drizzle(fresh), { migrationsFolder })
    return fresh
  }
}

/** A migration tripped over a table or index the ledger did not know about. */
function isLeftoverSchemaError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (/already exists/i.test(current.message)) return true
  }
  return false
}
