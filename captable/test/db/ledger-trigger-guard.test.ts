import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER, readMigrations } from './helpers.ts'

// scripts/check-ledger-triggers.mjs runs first in `npm run build`, which publishing runs (the tests don't run there).
// These cases feed it the app's migrations plus synthetic later ones, shaped like Drizzle Kit's output.

const GUARD = fileURLToPath(new URL('../../scripts/check-ledger-triggers.mjs', import.meta.url))
const BREAKPOINT = '--> statement-breakpoint'

function guard(folder?: string): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, folder ? [GUARD, folder] : [GUARD], { encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A copy of the app's migrations with `extra` migrations appended to the journal, as drizzle-kit would. */
function migrationsWith(...extra: { tag: string; sql: string }[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'captable-migrations-'))
  folders.push(folder)
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
  const journalPath = join(folder, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }
  for (const { tag, sql } of extra) {
    const last = journal.entries.at(-1)!
    journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1, tag, breakpoints: true })
    writeFileSync(join(folder, `${tag}.sql`), sql)
  }
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return folder
}

/** Drizzle Kit's SQLite table rebuild, byte for byte as drizzle-kit 0.31.11 writes it for a changed CHECK. */
function rebuild(table: string, columns: string[], definition: string): string {
  const list = columns.map((column) => `"${column}"`).join(', ')
  return [
    'PRAGMA foreign_keys=OFF;',
    `CREATE TABLE \`__new_${table}\` (\n${definition}\n);\n`,
    `INSERT INTO \`__new_${table}\`(${list}) SELECT ${list} FROM \`${table}\`;`,
    `DROP TABLE \`${table}\`;`,
    `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\`;`,
    'PRAGMA foreign_keys=ON;',
  ].join(`${BREAKPOINT}\n`)
}

// valuation_prices has two append-only triggers, and no other table's trigger refers to it.
const REBUILD_VALUATION_PRICES = rebuild(
  'valuation_prices',
  ['org_id', 'valuation_id', 'stock_class_id', 'price_per_share'],
  [
    '\t`org_id` text NOT NULL,',
    '\t`valuation_id` text NOT NULL,',
    '\t`stock_class_id` text NOT NULL,',
    '\t`price_per_share` text NOT NULL,',
    '\tPRIMARY KEY(`valuation_id`, `stock_class_id`),',
    '\tFOREIGN KEY (`org_id`,`valuation_id`) REFERENCES `valuations`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,',
    '\tFOREIGN KEY (`org_id`,`stock_class_id`) REFERENCES `stock_classes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,',
    '\tCONSTRAINT "valuation_prices_price_per_share_check" CHECK(length(price_per_share) BETWEEN 1 AND 40)',
  ].join('\n'),
)

/** The statements of the app's migrations that create the triggers on `table`, in their order. */
function triggersOn(table: string): string {
  return readMigrations()
    .flatMap((migration) => migration.sql.split(BREAKPOINT))
    .filter((statement) => new RegExp(`CREATE TRIGGER (IF NOT EXISTS )?\\w+ [^\\n]* ON ${table}\\b`).test(statement))
    .join(BREAKPOINT)
}

// Each case starts Node and replays every migration: allow for a busy machine.
describe('the ledger trigger guard', { timeout: 60_000 }, () => {
  it("passes the app's migrations", () => {
    const { status, output } = guard()
    expect(output).toContain('keep all 74 triggers')
    expect(status).toBe(0)
  })

  it('refuses a migration that rebuilds a table and loses its triggers', () => {
    const { status, output } = guard(migrationsWith({ tag: '0002_price_check', sql: REBUILD_VALUATION_PRICES }))
    expect(status).toBe(1)
    expect(output).toContain('remove 2 triggers the cap table relies on')
    expect(output).toContain(
      'valuation_prices_immutable_update, valuation_prices_immutable_delete (on valuation_prices, created in 0001_ledger_triggers.sql, lost in 0002_price_check.sql, statement 4)',
    )
    expect(output).toContain('Make the change additive')
    expect(output).toContain('drizzle-kit generate --custom')
  })

  it('accepts the rebuild when a later custom migration re-creates the triggers', () => {
    const folder = migrationsWith(
      { tag: '0002_price_check', sql: REBUILD_VALUATION_PRICES },
      { tag: '0003_restore_triggers', sql: triggersOn('valuation_prices') },
    )
    expect(triggersOn('valuation_prices').split(BREAKPOINT)).toHaveLength(2)
    expect(guard(folder).status).toBe(0)
  })

  it('accepts a trigger removed on purpose with DROP TRIGGER', () => {
    const folder = migrationsWith({ tag: '0002_drop_guard', sql: 'DROP TRIGGER IF EXISTS "valuation_prices_immutable_delete";' })
    expect(guard(folder)).toMatchObject({ status: 0, output: expect.stringContaining('keep all 73 triggers') })
  })

  it('refuses a rebuild that cannot apply, because another trigger refers to the table', () => {
    const folder = migrationsWith({
      tag: '0002_dependency_check',
      sql: rebuild(
        'command_dependencies',
        ['org_id', 'command_id', 'depends_on_command_id', 'kind'],
        [
          '\t`org_id` text NOT NULL,',
          '\t`command_id` text NOT NULL,',
          '\t`depends_on_command_id` text NOT NULL,',
          '\t`kind` text NOT NULL,',
          '\tPRIMARY KEY(`command_id`, `depends_on_command_id`)',
        ].join('\n'),
      ),
    })
    const { status, output } = guard(folder)
    expect(status).toBe(1)
    expect(output).toContain('0002_dependency_check.sql, statement 5 fails: error in trigger commands_reversal_rules')
    expect(output).toContain('the statements\nbefore this one would stay applied')
  })

  it.each([
    ['more than one statement in a chunk', 'CREATE INDEX IF NOT EXISTS a ON legends (name);\nCREATE INDEX IF NOT EXISTS b ON legends (kind);', 'statement 1 holds more than one SQL statement'],
    ['a chunk without a statement', `CREATE INDEX IF NOT EXISTS a ON legends (name);\n${BREAKPOINT}\n-- nothing here\n`, 'statement 2 holds no SQL statement'],
  ])('refuses %s, which the preview cannot run', (_case, sql, message) => {
    const { status, output } = guard(migrationsWith({ tag: '0002_indexes', sql }))
    expect(status).toBe(1)
    expect(output).toContain(`0002_indexes.sql, ${message}`)
  })
})
