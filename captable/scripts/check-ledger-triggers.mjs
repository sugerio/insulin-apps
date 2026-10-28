#!/usr/bin/env node
// Stops the build when the database migrations would lose a trigger. The triggers protect the cap table: they keep
// the ledger append-only, reject stale and illegal updates, and move the ledger head. `npm run build` runs this first,
// and publishing runs `npm run build`.
//
//   node scripts/check-ledger-triggers.mjs [<migrations folder>]      (default: src/app/db/migrations)
//
// It replays the migrations in journal order on an empty in-memory SQLite database, one statement per
// `--> statement-breakpoint` chunk, the way the preview applies them, and fails when:
//   - a statement fails, or a chunk is empty or holds more than one statement (the preview runs only the first);
//   - a trigger that a migration created is missing at the end, unless a later migration removed it with DROP TRIGGER.
//     Drizzle Kit causes this when it rebuilds a table (CREATE TABLE __new_x, copy, DROP TABLE x, rename) or drops it:
//     SQLite drops a table's triggers with the table.
// Everything comes from the migration files themselves; there is no list of tables or triggers to maintain.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// node:sqlite still prints an ExperimentalWarning on Node 22; keep the build log to this check's own lines.
process.removeAllListeners('warning')
const { DatabaseSync } = await import('node:sqlite')

const BREAKPOINT = '--> statement-breakpoint'
const README = 'src/app/db/README.md'

/** `sql` with comments removed and string literals emptied, so only code is searched. */
function codeOf(sql) {
  let code = ''
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end - 1
      code += ' '
    } else if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 1
      code += ' '
    } else if (char === "'") {
      const end = sql.indexOf("'", index + 1)
      index = end === -1 ? sql.length : end
      code += "''"
    } else {
      code += char
    }
  }
  return code
}

const IDENTIFIER = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|\w+)`
const DROP_TRIGGER = new RegExp(String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(?:${IDENTIFIER}\s*\.\s*)?(${IDENTIFIER})`, 'gi')
const unquote = (name) => (/^["`[]/.test(name) ? name.slice(1, -1) : name).toLowerCase()

/** The triggers a chunk drops by name. */
function droppedTriggers(chunk) {
  return new Set([...codeOf(chunk).matchAll(DROP_TRIGGER)].map((match) => unquote(match[1])))
}

/** The database's triggers, by lowercase name (SQLite names are case-insensitive). */
function triggersOf(db) {
  const rows = db.prepare("SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'trigger'").all()
  return new Map(rows.map((row) => [row.name.toLowerCase(), { name: row.name, table: row.tableName }]))
}

/**
 * Replays the migrations in `folder`. Returns the problems found (empty when all is well) and how many triggers the
 * migrations leave in place.
 */
function check(folder) {
  const journalPath = join(folder, 'meta/_journal.json')
  if (!existsSync(journalPath)) return { problems: [], triggers: 0, migrations: 0 }
  const { entries } = JSON.parse(readFileSync(journalPath, 'utf8'))
  const db = new DatabaseSync(':memory:')
  const created = new Map() // every trigger a migration created and no migration dropped by name
  const lost = new Map() // where a trigger went missing without a DROP TRIGGER

  for (const { tag } of entries) {
    const chunks = readFileSync(join(folder, `${tag}.sql`), 'utf8').split(BREAKPOINT)
    for (const [index, chunk] of chunks.entries()) {
      const where = `${tag}.sql, statement ${index + 1}`
      if (!codeOf(chunk).trim()) {
        return { problems: [{ kind: 'empty', where }] }
      }
      const before = triggersOf(db)
      try {
        const statement = db.prepare(chunk)
        // sourceSQL is the text of the first statement only. A runtime without it skips this check.
        const first = statement.sourceSQL
        if (typeof first === 'string' && chunk.startsWith(first) && codeOf(chunk.slice(first.length)).trim()) {
          return { problems: [{ kind: 'several', where }] }
        }
        statement.run()
      } catch (error) {
        return { problems: [{ kind: 'fails', where, message: error instanceof Error ? error.message : String(error) }] }
      }
      const after = triggersOf(db)
      for (const [key, trigger] of after) {
        if (!before.has(key)) {
          created.set(key, { ...trigger, migration: tag })
          lost.delete(key)
        }
      }
      const dropped = droppedTriggers(chunk)
      for (const [key, trigger] of before) {
        if (after.has(key)) continue
        if (dropped.has(key)) created.delete(key)
        else lost.set(key, { ...trigger, where })
      }
    }
  }

  const present = triggersOf(db)
  const missing = [...created.keys()].filter((key) => !present.has(key))
  return {
    problems: missing.map((key) => ({ kind: 'missing', ...created.get(key), lostIn: lost.get(key)?.where })),
    triggers: present.size,
    migrations: entries.length,
  }
}

function report({ problems }) {
  const [first] = problems
  if (first.kind === 'empty' || first.kind === 'several' || first.kind === 'fails') {
    const what = {
      empty:
        `${first.where} holds no SQL statement, only comments or blank lines, and the preview fails on it. ` +
        `Write its statement, or remove the extra "${BREAKPOINT}" line.`,
      several:
        `${first.where} holds more than one SQL statement, and the preview runs only the first. ` +
        `Put each statement in its own chunk, separated by a "${BREAKPOINT}" line.`,
      fails: `${first.where} fails: ${first.message}`,
    }[first.kind]
    return [
      'The database migrations do not apply cleanly, so the build stops here.',
      `  ${what}`,
      ...(first.kind === 'fails'
        ? [
            '',
            'Published, this would fail midway: D1 applies a migration one statement at a time, and the statements',
            'before this one would stay applied. A Drizzle Kit table rebuild (CREATE TABLE __new_x, DROP TABLE x,',
            'ALTER TABLE ... RENAME) fails this way when another table\'s trigger refers to the rebuilt table: make the',
            'schema change additive instead.',
          ]
        : []),
      `See ${README}.`,
    ].join('\n')
  }

  const byPlace = new Map()
  for (const problem of problems) {
    const place = `on ${problem.table}, created in ${problem.migration}.sql${problem.lostIn ? `, lost in ${problem.lostIn}` : ''}`
    byPlace.set(place, [...(byPlace.get(place) ?? []), problem.name])
  }
  return [
    `The database migrations remove ${problems.length} trigger${problems.length === 1 ? '' : 's'} the cap table relies on, so the build stops here.`,
    ...[...byPlace].map(([place, names]) => `  - ${names.join(', ')} (${place})`),
    '',
    'These triggers keep the ledger append-only and reject stale or illegal changes. SQLite drops a table\'s triggers',
    'with the table, and Drizzle Kit drops and rebuilds a table for any change ALTER TABLE cannot make: a new or',
    'changed check(), default, notNull(), column type, primary key or multi-column foreignKey().',
    '',
    'To fix it:',
    '  1. Make the change additive: a new table, a new nullable column or one with a default, or a new index. Leave the',
    '     existing columns and constraints of tables with triggers as they are. The migration that rebuilt the table',
    '     must not be published: a developer removes it with `npx drizzle-kit drop`, then regenerates with',
    '     `npm run db:generate`. AppBuilder agents can\'t edit or delete migration files: revert the change in',
    '     schema.ts, stop, and tell the user.',
    '  2. If the rebuild is intended, a developer adds a custom migration after it that re-creates the triggers:',
    '     `npx drizzle-kit generate --custom --name restore_triggers`, then copy each missing trigger\'s CREATE TRIGGER',
    '     statement from the migration that created it, in the same order, one per chunk. A trigger meant to go away',
    '     for good is removed explicitly with DROP TRIGGER.',
    `See ${README}.`,
  ].join('\n')
}

const folder = resolve(process.argv[2] ?? fileURLToPath(new URL('../src/app/db/migrations', import.meta.url)))
const result = check(folder)
if (result.problems.length) {
  console.error(report(result))
  process.exit(1)
}
console.log(
  result.migrations
    ? `Ledger triggers: ${result.migrations} migrations apply cleanly and keep all ${result.triggers} triggers.`
    : 'Ledger triggers: no migrations to check.',
)
