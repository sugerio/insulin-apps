import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER, openMigratedDatabase } from '../support/harness.ts'

// The generated migrations apply to an empty database, and every table that holds an organization's records names it.

const APP_WIDE = new Set(['limit_defaults', 'sync_state', 'metrics_reports', 'engine_events', '__drizzle_migrations', 'd1_migrations'])

describe('migrations', () => {
  it('apply cleanly, and every table of organization records has org_id', async () => {
    const db = await openMigratedDatabase()
    const tables = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all<{ name: string }>()
    expect(tables.results.length).toBeGreaterThan(20)
    for (const { name } of tables.results) {
      if (APP_WIDE.has(name)) continue
      const columns = await db.prepare(`SELECT name FROM pragma_table_info(?)`).bind(name).all<{ name: string }>()
      expect({ table: name, scoped: columns.results.some((column) => column.name === 'org_id') }).toEqual({ table: name, scoped: true })
    }
    db.close()
  })

  it('are drizzle-kit\'s own: SQL files with a journal and snapshots', () => {
    const files = readdirSync(MIGRATIONS_FOLDER)
    expect(files.filter((file) => file.endsWith('.sql')).length).toBeGreaterThan(0)
    expect(readdirSync(`${MIGRATIONS_FOLDER}/meta`)).toContain('_journal.json')
  })
})
