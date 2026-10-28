import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from 'drizzle-orm/d1/migrator'
import { is } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../src/app/db/schema.ts'
import type { LocalD1 } from '../../src/local-d1.ts'
import { MIGRATIONS_FOLDER, openMigratedDatabase, readMigrations } from './helpers.ts'

let db: LocalD1
beforeEach(async () => {
  db = await openMigratedDatabase()
})
afterEach(() => db.close())

async function rows<T>(sql: string): Promise<T[]> {
  return (await db.prepare(sql).all<T>()).results
}

interface MasterRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}
const schemaObjects = () =>
  rows<MasterRow>("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid")

const TABLES = Object.values(schema as Record<string, unknown>).filter((value): value is SQLiteTable => is(value, SQLiteTable))

describe('the migrations', () => {
  it('apply in journal order and record each one', async () => {
    const applied = await rows<{ hash: string }>('SELECT hash FROM __drizzle_migrations ORDER BY created_at')
    expect(applied).toHaveLength(readMigrations().length)
    expect(readMigrations().map((migration) => migration.tag)).toEqual([
      '0000_init', '0001_ledger_triggers', '0002_tenant_per_organization', '0003_freeze_owner',
      '0004_require_company_sequences',
    ])
  })

  it('apply only what is pending when the migrator runs again', async () => {
    await migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER })
    expect(await rows('SELECT hash FROM __drizzle_migrations')).toHaveLength(readMigrations().length)
  })

  // The preview's D1 stand-in prepares each `--> statement-breakpoint` chunk as one statement and silently ignores
  // anything after the first, so a chunk holding two statements would lose one without an error.
  it('create every table, index and trigger they declare', async () => {
    const migrations = readMigrations()
    const dropped = new Set(migrations
      .flatMap((migration) => [...migration.sql.matchAll(/DROP INDEX (?:IF EXISTS )?`?(\w+)`?/g)])
      .map((match) => match[1]))
    const declared = migrations
      .flatMap((migration) => [...migration.sql.matchAll(/CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?`?(\w+)`?/g)])
      .filter((match) => match[1] !== 'INDEX' || !dropped.has(match[2]))
      .map((match) => `${match[1]!.toLowerCase()} ${match[2]}`)
      .sort()
    const created = (await schemaObjects())
      .filter((object) => object.name !== '__drizzle_migrations')
      .map((object) => `${object.type} ${object.name}`)
      .sort()
    expect(created).toEqual(declared)
    expect(declared.filter((object) => object.startsWith('table '))).toHaveLength(36)
    expect(declared.filter((object) => object.startsWith('trigger '))).toHaveLength(81)
  })

  it('can replay the company-sequence triggers after a partial migration attempt', async () => {
    const migration = readMigrations().find(({ tag }) => tag === '0004_require_company_sequences')!
    for (const statement of migration.sql.split('--> statement-breakpoint')) await db.prepare(statement).run()
    expect((await rows<MasterRow>("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'"))).toHaveLength(81)
  })

  it('seed the transaction types', async () => {
    expect(await db.prepare('SELECT count(*) AS n FROM transaction_types').first('n')).toBe(49)
  })

  it('leave foreign keys enforced, as D1 always does', async () => {
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1)
    await expect(
      db
        .prepare(
          "INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, created_at, updated_at) VALUES ('sh_x', 'org_missing', 'individual', 'Nobody', 'other', 0, 0)",
        )
        .run(),
    ).rejects.toThrow('FOREIGN KEY constraint failed')
    expect(await rows('PRAGMA foreign_key_check')).toEqual([])
  })

  it('contain only the console and D1 product fields', async () => {
    const columns = async (table: string) =>
      rows<{ name: string; notnull: number }>(`PRAGMA table_xinfo('${table}')`)
    const names = async (table: string) => (await columns(table)).map((column) => column.name)

    expect((await columns('users')).find((column) => column.name === 'email')?.notnull).toBe(0)
    expect(await names('users')).not.toEqual(expect.arrayContaining(['status', 'notification_level']))
    expect(await names('orgs')).not.toEqual(expect.arrayContaining(['archived_reason', 'archived_at']))
    expect(await names('stakeholder_emails')).not.toEqual(expect.arrayContaining([
      'purpose', 'verified_at', 'verified_via', 'added_reason', 'usable_from', 'invited_at',
    ]))
    expect((await schemaObjects()).find((object) => object.name === 'documents')!.sql)
      .toContain('CHECK(byte_size > 0 AND byte_size <= 10485760)')
    expect(await names('payment_instructions')).toEqual(['org_id', 'details', 'updated_by', 'updated_at', 'version'])
    expect(await names('expiry_runs')).toEqual([
      'id', 'org_id', 'local_date', 'candidates', 'created_at', 'confirmation', 'confirmed_at', 'confirmed_by',
      'org_seq',
    ])
    expect(await names('audit_events')).toEqual([
      'id', 'occurred_at', 'org_id', 'actor_kind', 'actor_user_id', 'actor_email', 'auth_method', 'action',
      'target_type', 'target_id', 'result', 'reason', 'ip', 'user_agent', 'request_id', 'details',
      'console_organization_id', 'org_seq',
    ])
    expect(await names('document_blobs')).toEqual(['org_id', 'document_id', 'chunk_index', 'bytes', 'created_at'])
    expect(await names('document_upload_chunks')).toEqual([
      'org_id', 'document_id', 'chunk_index', 'bytes', 'created_at', 'console_organization_id',
    ])
    expect(await names('import_runs')).toEqual([
      'id', 'source_system', 'status', 'file_hashes', 'as_of_date', 'plan_sha256', 'counts', 'created_by',
      'org_id', 'error_message', 'timezone', 'jurisdiction', 'fiscal_year_end', 'attempt_id',
      'attempt_expires_at', 'created_at', 'updated_at', 'console_organization_id',
    ])
  })
})

// drizzle-kit's own check (`drizzle-kit generate` writes nothing) runs at publish time; this one runs with the tests
// and needs no drizzle-kit: every table of schema.ts exists in the migrated database exactly as declared.
describe('schema.ts and the migrated database', () => {
  it('declare the same tables', async () => {
    const tables = (await schemaObjects())
      .filter((object) => object.type === 'table' && object.name !== '__drizzle_migrations')
      .map((object) => object.name)
    expect(TABLES.map((table) => getTableConfig(table).name).sort()).toEqual(tables.sort())
  })

  it.each(TABLES.map((table) => [getTableConfig(table).name, table] as const))('%s', async (name, table) => {
    const config = getTableConfig(table)
    const columns = await rows<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
      `PRAGMA table_xinfo('${name}')`,
    )
    expect(columns.map((column) => column.name)).toEqual(config.columns.map((column) => column.name))
    for (const column of config.columns) {
      const actual = columns.find((candidate) => candidate.name === column.name)!
      // SQLite reports the standard type names upper-cased.
      expect(actual.type, column.name).toBe(column.getSQLType().toUpperCase())
      expect(actual.notnull === 1, column.name).toBe(column.notNull)
      expect(actual.dflt_value === null, column.name).toBe(column.default === undefined)
    }
    const primaryKey = config.primaryKeys[0]?.columns.map((column) => column.name) ?? config.columns.filter((c) => c.primary).map((c) => c.name)
    expect(
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
    ).toEqual(primaryKey)

    const indexes = await rows<{ name: string; unique: number; partial: number }>(`PRAGMA index_list('${name}')`)
    const declaredIndexes = [
      ...config.indexes.map((index) => ({ name: index.config.name, unique: index.config.unique, partial: index.config.where !== undefined })),
      ...config.uniqueConstraints.map((unique) => ({ name: unique.name!, unique: true, partial: false })),
      ...config.columns.filter((column) => column.isUnique).map((column) => ({ name: column.uniqueName!, unique: true, partial: false })),
    ]
    for (const index of declaredIndexes) {
      const actual = indexes.find((candidate) => candidate.name === index.name)
      expect(actual, index.name).toBeDefined()
      expect({ unique: actual!.unique === 1, partial: actual!.partial === 1 }, index.name).toEqual({ unique: index.unique, partial: index.partial })
    }
    expect(indexes.filter((index) => !index.name.startsWith('sqlite_autoindex_')).length).toBe(declaredIndexes.length)

    const tableSql = (await schemaObjects()).find((object) => object.type === 'table' && object.name === name)!.sql!
    for (const check of config.checks) expect(tableSql, check.name).toContain(`CONSTRAINT "${check.name}" CHECK(`)
    expect(tableSql.match(/CONSTRAINT "\w+" CHECK\(/g) ?? []).toHaveLength(config.checks.length)

    const foreignKeys = await rows<{ id: number; table: string; from: string; to: string }>(`PRAGMA foreign_key_list('${name}')`)
    const actualKeys = [...new Set(foreignKeys.map((key) => key.id))].map((id) => {
      const parts = foreignKeys.filter((key) => key.id === id)
      return `${parts.map((key) => key.from).join(',')} -> ${parts[0]!.table}(${parts.map((key) => key.to).join(',')})`
    })
    const declaredKeys = config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference()
      return `${reference.columns.map((column) => column.name).join(',')} -> ${getTableConfig(reference.foreignTable).name}(${reference.foreignColumns.map((column) => column.name).join(',')})`
    })
    expect(actualKeys.sort()).toEqual(declaredKeys.sort())
  })

  it('keeps DOCUMENT_BLOB_CHUNK_BYTES equal to the document_blobs CHECK', async () => {
    const tableSql = (await schemaObjects()).find((object) => object.name === 'document_blobs')!.sql!
    expect(tableSql).toContain(`CHECK(length(bytes) BETWEEN 1 AND ${schema.DOCUMENT_BLOB_CHUNK_BYTES})`)
  })
})
