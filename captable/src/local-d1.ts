import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
} from '@cloudflare/workers-types/index.ts'

/**
 * The preview's stand-in for a Cloudflare D1 binding, over node:sqlite.
 *
 * App code talks to D1 in production, so the preview implements the same
 * interface rather than a friendlier local one, and refuses what D1 refuses:
 * SQL transaction statements (use `batch()`), `undefined` and BigInt bindings.
 */
export type LocalD1Database = Pick<D1Database, 'prepare' | 'batch' | 'exec'>

const TRANSACTION = /^(BEGIN|COMMIT|END\s+TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE)\b/i

class D1Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Error'
  }
}

/** `sql` split into its statements, outside quotes and comments, comments dropped. */
function statementsOf(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (char === "'" || char === '"' || char === '`') {
      const end = sql.indexOf(char, index + 1)
      const stop = end === -1 ? sql.length : end + 1
      current += sql.slice(index, stop)
      index = stop - 1
    } else if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end
    } else if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 1
    } else if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

function refuseTransaction(statement: string): void {
  if (TRANSACTION.test(statement)) {
    throw new D1Error(
      'D1_ERROR: SQL transaction statements are not supported by Cloudflare D1. ' +
        'To write atomically, use batch() — every batch runs as one transaction.',
    )
  }
}

function toBindable(value: unknown): SQLInputValue {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  const type = value === undefined ? 'undefined' : typeof value
  throw new D1Error(`D1_TYPE_ERROR: Type '${type}' not supported for value '${String(value)}'`)
}

/** D1 returns BLOB columns as plain arrays of bytes. */
function fromSqlite(value: unknown): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value
}

interface Executed {
  columns: string[]
  rows: unknown[][]
  changes: number
  lastRowId: number
  size: number
  duration: number
}

class LocalD1Statement implements D1PreparedStatement {
  private readonly database: LocalD1
  readonly sql: string
  readonly params: SQLInputValue[]

  constructor(database: LocalD1, sql: string, params: SQLInputValue[] = []) {
    this.database = database
    this.sql = sql
    this.params = params
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new LocalD1Statement(this.database, this.sql, values.map(toBindable))
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return resultOf<T>(this.database.run(this))
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>()
  }

  first<T = unknown>(colName: string): Promise<T | null>
  first<T = Record<string, unknown>>(): Promise<T | null>
  async first<T>(colName?: string): Promise<T | null> {
    const [row] = (await this.all<Record<string, unknown>>()).results
    if (!row) return null
    if (colName === undefined) return row as T
    if (!(colName in row)) throw new D1Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`)
    return row[colName] as T
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
  async raw<T>(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const { columns, rows } = this.database.run(this)
    return (options?.columnNames ? [columns, ...rows] : rows) as T[]
  }
}

function resultOf<T>(executed: Executed): D1Result<T> {
  const { columns, rows, changes } = executed
  const results = rows.map(
    (row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T,
  )
  return {
    success: true,
    results,
    meta: {
      duration: executed.duration,
      size_after: executed.size,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: executed.lastRowId,
      changed_db: changes > 0,
      changes,
    },
  }
}

export class LocalD1 implements LocalD1Database {
  private readonly sqlite: DatabaseSync
  private readonly progress: StatementSync
  /** Prepared statements by SQL text, for the schema version `schema`. */
  private readonly statements = new Map<string, StatementSync>()
  private schema: number | undefined

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite
    this.progress = sqlite.prepare(
      'SELECT total_changes() AS total, last_insert_rowid() AS rowid, ' +
        '(SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS size, ' +
        '(SELECT schema_version FROM pragma_schema_version()) AS schema',
    )
  }

  prepare(query: string): D1PreparedStatement {
    return new LocalD1Statement(this, query)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const local = statements.map((statement) => {
      if (!(statement instanceof LocalD1Statement)) {
        throw new D1Error('D1_ERROR: batch() only accepts statements prepared on this database')
      }
      return statement
    })
    return this.transaction(() => local.map((statement) => resultOf<T>(this.run(statement))))
  }

  async exec(query: string): Promise<D1ExecResult> {
    const started = performance.now()
    const statements = statementsOf(query)
    statements.forEach(refuseTransaction)
    try {
      this.sqlite.exec(query)
    } catch (error) {
      throw asD1Error(error)
    }
    return { count: statements.length, duration: performance.now() - started }
  }

  close(): void {
    this.statements.clear()
    this.sqlite.close()
  }

  run(statement: LocalD1Statement): Executed {
    refuseTransaction(statementsOf(statement.sql)[0] ?? '')
    const started = performance.now()
    try {
      const before = this.progress.get() ?? {}
      const prepared = this.prepared(statement.sql, Number(before.schema))
      const columns = prepared.columns().map((column) => column.name)
      let rows: unknown[][] = []
      if (columns.length > 0) {
        prepared.setReturnArrays(true)
        rows = (prepared.all(...statement.params) as unknown as unknown[][]).map((row) =>
          row.map(fromSqlite),
        )
      } else {
        prepared.run(...statement.params)
      }
      const after = this.progress.get() ?? {}
      return {
        columns,
        rows,
        changes: Number(after.total) - Number(before.total),
        lastRowId: Number(after.rowid),
        size: Number(after.size),
        duration: performance.now() - started,
      }
    } catch (error) {
      throw asD1Error(error)
    }
  }

  /**
   * One statement per distinct SQL text, reused by every execution: node:sqlite
   * has no finalize(), and Zero's (the preview's) frees a statement only when
   * its database closes, so preparing per query grew the preview with every
   * query. A schema change drops them (Zero keeps those until close: once per
   * migration, not per query): SQLite rebuilds a changed statement only as it
   * runs, after its columns were read, so a kept `SELECT *` would answer with
   * the table's old columns.
   */
  private prepared(sql: string, schema: number): StatementSync {
    if (schema !== this.schema) {
      this.statements.clear()
      this.schema = schema
    }
    let prepared = this.statements.get(sql)
    if (!prepared) {
      prepared = this.sqlite.prepare(sql)
      this.statements.set(sql, prepared)
    }
    return prepared
  }

  private transaction<R>(operation: () => R): R {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.sqlite.exec('COMMIT')
      return result
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

function asD1Error(error: unknown): Error {
  if (error instanceof D1Error) return error
  return new D1Error(`D1_ERROR: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Opens (or creates) the preview database stored at `path`. node:sqlite loads
 * here, on first use, rather than with this module.
 */
export async function openLocalD1(path: string): Promise<LocalD1> {
  const { DatabaseSync } = await import('node:sqlite')
  mkdirSync(dirname(path), { recursive: true })
  // D1 enforces foreign keys, as node:sqlite does by default.
  return new LocalD1(new DatabaseSync(path, { enableForeignKeyConstraints: true }))
}
