import type { DatabaseSync } from 'node:sqlite'

/**
 * Cloudflare D1 refuses a LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too complex"); node:sqlite,
 * which the tests run on, allows 50,000. `like()` (both forms: `x LIKE p` and `x LIKE p ESCAPE e`) and `glob()` are
 * replaced on `sqlite` with functions that refuse such a pattern as D1 does, per row, and otherwise answer exactly as
 * SQLite's own (asked of a second, empty in-memory database), so a query that would fail on D1 fails in the tests.
 */
export const D1_LIKE_PATTERN_BYTES = 50

export async function withD1Limits(sqlite: DatabaseSync): Promise<DatabaseSync> {
  const { DatabaseSync: Sqlite } = await import('node:sqlite')
  const reference = new Sqlite(':memory:')
  const like = reference.prepare('SELECT like(?, ?) AS result')
  const likeEscaped = reference.prepare('SELECT like(?, ?, ?) AS result')
  const glob = reference.prepare('SELECT glob(?, ?) AS result')
  const refuseLong = (pattern: unknown) => {
    if (pattern === null || pattern === undefined) return
    const bytes = pattern instanceof Uint8Array ? pattern.byteLength : Buffer.byteLength(String(pattern))
    if (bytes > D1_LIKE_PATTERN_BYTES) throw new Error('LIKE or GLOB pattern too complex: SQLITE_ERROR')
  }
  type Value = null | number | bigint | string | Uint8Array
  const options = { deterministic: true, useBigIntArguments: true }
  sqlite.function('like', options, (pattern: Value, value: Value) => {
    refuseLong(pattern)
    return (like.get(pattern, value) as { result: Value }).result
  })
  sqlite.function('like', options, (pattern: Value, value: Value, escape: Value) => {
    refuseLong(pattern)
    return (likeEscaped.get(pattern, value, escape) as { result: Value }).result
  })
  sqlite.function('glob', options, (pattern: Value, value: Value) => {
    refuseLong(pattern)
    return (glob.get(pattern, value) as { result: Value }).result
  })
  return sqlite
}
