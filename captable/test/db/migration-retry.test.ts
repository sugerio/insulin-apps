import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import { type LocalD1, openLocalD1 } from '../../src/local-d1.ts'
import { MIGRATIONS_FOLDER, openMigratedDatabase, readMigrations } from './helpers.ts'

// Publishing applies migrations with `drizzle-kit migrate` over D1's HTTP API: one request per statement, and a
// migration is recorded only after all of its statements ran. A failure midway leaves the earlier statements applied
// and the migration unrecorded, so the next publish runs it again from its first statement. The custom migration must
// survive that; the generated init migration can't (see src/app/db/README.md for the recovery).

const BREAKPOINT = '--> statement-breakpoint'
const MIGRATIONS = readMigrations()
const CUSTOM = MIGRATIONS.findIndex((migration) => migration.tag.endsWith('_ledger_triggers'))
const statementsOf = (sql: string) => sql.split(BREAKPOINT)
/** Requests sent before the custom migration's first statement: earlier statements plus one record per migration. */
const BEFORE_CUSTOM = MIGRATIONS.slice(0, CUSTOM).reduce((sum, migration) => sum + statementsOf(migration.sql).length + 1, 0)
const CUSTOM_STATEMENTS = statementsOf(MIGRATIONS[CUSTOM]!.sql).length

/**
 * Applies the pending migrations as drizzle-kit's d1-http driver does (drizzle-orm's sqlite-proxy migrator, every
 * statement its own request) against `db`. With `failAt`, that request (counted from 0 over the migration statements
 * and records) fails, as a timeout or a dropped connection would.
 */
async function publishMigrations(db: LocalD1, failAt?: number): Promise<void> {
  const request = async (sql: string, params: unknown[], method: string) => {
    const statement = db.prepare(sql).bind(...params)
    if (method === 'run') {
      await statement.run()
      return { rows: [] }
    }
    return { rows: await statement.raw() }
  }
  const migrations = async (queries: string[]) => {
    for (const [index, query] of queries.entries()) {
      if (index === failAt) throw new Error('D1 HTTP request failed')
      await request(query, [], 'run')
    }
  }
  await migrate(drizzle(request), migrations, { migrationsFolder: MIGRATIONS_FOLDER })
}

/** The schema in creation order (SQLite's trigger firing order follows it), and the seed. */
async function contents(db: LocalD1) {
  const schema = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY rowid")
    .all()
  const seed = await db.prepare('SELECT code, family, is_ocf, description FROM transaction_types ORDER BY rowid').all()
  const recorded = await db.prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at').all()
  return { schema: schema.results, seed: seed.results, recorded: recorded.results }
}

let reference: Awaited<ReturnType<typeof contents>>
beforeAll(async () => {
  const preview = await openMigratedDatabase()
  reference = await contents(preview)
  preview.close()
})

// Each case migrates a database twice: allow for a busy machine.
describe('a publish that fails midway', { timeout: 60_000 }, () => {
  it('applies the migrations like the preview when nothing fails', async () => {
    const db = await openLocalD1(':memory:')
    await publishMigrations(db)
    expect(await contents(db)).toEqual(reference)
    db.close()
  })

  it.each([0, 1, 2, Math.floor(CUSTOM_STATEMENTS / 2), CUSTOM_STATEMENTS - 1, CUSTOM_STATEMENTS])(
    'after %i statements of the custom migration ends, once retried, with the same schema and seed',
    async (applied) => {
      const db = await openLocalD1(':memory:')
      await expect(publishMigrations(db, BEFORE_CUSTOM + applied)).rejects.toThrow('D1 HTTP request failed')
      // Everything before the custom migration is recorded; the custom migration is not, whatever of it ran.
      expect((await contents(db)).recorded).toEqual(reference.recorded.slice(0, CUSTOM))
      await publishMigrations(db)
      expect(await contents(db)).toEqual(reference)
      db.close()
    },
  )

  it('inside the generated init migration cannot be retried: the first publish needs a fresh database', async () => {
    const db = await openLocalD1(':memory:')
    await expect(publishMigrations(db, 10)).rejects.toThrow('D1 HTTP request failed')
    await expect(publishMigrations(db)).rejects.toThrow(/already exists/)
    db.close()
  })
})

describe('the custom migration', () => {
  const statements = statementsOf(MIGRATIONS[CUSTOM]!.sql).map((statement) => statement.replace(/^(\s*--[^\n]*\n)*\s*/, ''))

  it('makes every statement safe to run again', () => {
    for (const statement of statements) {
      expect(statement, statement.slice(0, 80)).toMatch(/^(INSERT OR IGNORE INTO|CREATE TRIGGER IF NOT EXISTS) /)
    }
  })

  it('changes nothing when run again in full', async () => {
    const db = await openMigratedDatabase()
    for (const statement of statements) await db.prepare(statement).run()
    expect(await contents(db)).toEqual(reference)
    db.close()
  })
})
