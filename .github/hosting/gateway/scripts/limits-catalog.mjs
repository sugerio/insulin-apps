#!/usr/bin/env node
// Each app's limit catalog in the gateway's D1 (DESIGN.md §8.8). An app's package.json lists its limits under
// `insulin.limits` ({ key, label, unit, default }); they may not fit SITE_APPS, so the deploy writes them to the
// gateway's `app_limit_catalog` table (migration 0012) once the gateway's migrations are applied, for the app version
// in production, and the local run (scripts/dev.mjs) does the same for its local D1. The console shows the catalog, and
// GET /__insulin/limits serves its defaults unless an admin set another.
//
//   import { limitsCatalogSql } from '.github/hosting/gateway/scripts/limits-catalog.mjs'
//   const sql = limitsCatalogSql([{ name: 'knowledge', limits: pkg.insulin.limits }])
//   wrangler d1 execute <gateway database> --remote --config <gateway config> --command "<sql>"
//
// --command, D1's query path: --file goes through D1's import, which makes the database unavailable while it runs.
// (The local run's `--local --file` reads the file into the local database, with no import.)
//
//   node scripts/limits-catalog.mjs <app directory>... [--out <file>]   # the SQL for those apps' package.json files
//
// For each app it names, the SQL replaces the app's whole catalog: limits the app no longer lists are removed (an
// admin's default or an organization's override of one stays stored, unused, and applies again if the key returns:
// the organizations that hold one are listed again at the app's next read, with all their overrides). An app named
// with no limits has its catalog emptied. Apps it doesn't name are left as they are.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** The gateway's table the SQL writes (migration 0012), for a deploy that checks it exists before writing. */
export const LIMIT_CATALOG_TABLE = 'app_limit_catalog'
export const LIMIT_KEY = /^[a-z][a-z0-9_]{0,39}$/
export const LIMIT_UNITS = ['count', 'bytes', 'hours', 'days']
export const LIMITS_PER_APP = 20
const APP_NAME = /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/
const LABEL_MAX = 80
const DEFAULT_MAX = 1e15

/**
 * The problems with an app's `insulin.limits` (an empty list when it is fine): at most 20 entries, each a unique key by
 * the usage metrics' rule (§8.6), a label, a unit (count, bytes, hours or days) and a default that is a whole number
 * from 0 to 10^15.
 */
export function limitsProblems(app, limits) {
  const problems = []
  if (!APP_NAME.test(app)) problems.push(`${app}: not an app name`)
  if (limits === undefined) return problems
  if (!Array.isArray(limits)) return [...problems, `${app}: insulin.limits must be a list`]
  if (limits.length > LIMITS_PER_APP) problems.push(`${app}: insulin.limits has ${limits.length} entries, at most ${LIMITS_PER_APP}`)
  const seen = new Set()
  limits.forEach((limit, index) => {
    const where = `${app}: insulin.limits[${index}]`
    if (typeof limit !== 'object' || limit === null || Array.isArray(limit)) {
      problems.push(`${where} must be an object`)
      return
    }
    const unknown = Object.keys(limit).filter((name) => !['key', 'label', 'unit', 'default'].includes(name))
    if (unknown.length) problems.push(`${where} has unknown fields: ${unknown.join(', ')}`)
    if (typeof limit.key !== 'string' || !LIMIT_KEY.test(limit.key)) problems.push(`${where}.key must match ${LIMIT_KEY}`)
    else if (seen.has(limit.key)) problems.push(`${where}.key ${limit.key} is listed twice`)
    else seen.add(limit.key)
    if (typeof limit.label !== 'string' || !limit.label.trim() || limit.label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(limit.label)) {
      problems.push(`${where}.label must be 1 to ${LABEL_MAX} characters on one line`)
    }
    if (!LIMIT_UNITS.includes(limit.unit)) problems.push(`${where}.unit must be one of ${LIMIT_UNITS.join(', ')}`)
    if (!Number.isSafeInteger(limit.default) || limit.default < 0 || limit.default > DEFAULT_MAX) problems.push(`${where}.default must be a whole number from 0 to 10^15`)
  })
  return problems
}

/** A SQL string literal. */
function text(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * The SQL that writes these apps' catalogs (`[{ name, limits }]`, `limits` as in package.json, or absent for none),
 * one statement per line group, ready for `wrangler d1 execute --file`. Throws on a malformed catalog, naming every
 * problem, so a deploy never writes half of one.
 */
export function limitsCatalogSql(apps, { now = Date.now() } = {}) {
  const problems = apps.flatMap((app) => limitsProblems(app.name, app.limits))
  if (problems.length) throw new Error(`Malformed limit catalog:\n${problems.join('\n')}`)
  const statements = []
  for (const app of apps) {
    const limits = app.limits ?? []
    const keys = limits.map((limit) => text(limit.key))
    if (keys.length) {
      // Keys coming (back) into the catalog: the organizations with an override of one get the next change numbers, one
      // each, so GET /__insulin/limits lists them again with it. Read before the catalog changes, so "not in it" is now.
      const returning = `SELECT DISTINCT l.org_id FROM org_app_limits l WHERE l.app = ${text(app.name)} AND l.key IN (${keys.join(', ')})
         AND NOT EXISTS (SELECT 1 FROM app_limit_catalog c WHERE c.app = l.app AND c.key = l.key)`
      statements.push(
        `UPDATE app_limit_sequence SET seq = seq + (SELECT COUNT(*) FROM (${returning})) WHERE id = 1;`,
        `INSERT INTO org_app_limit_changes (app, org_id, seq)
         SELECT ${text(app.name)}, r.org_id, (SELECT seq FROM app_limit_sequence WHERE id = 1) - r.total + r.n
         FROM (SELECT org_id, ROW_NUMBER() OVER (ORDER BY org_id) AS n, COUNT(*) OVER () AS total FROM (${returning})) r WHERE true
         ON CONFLICT (app, org_id) DO UPDATE SET seq = excluded.seq;`,
      )
    }
    statements.push(keys.length
      ? `DELETE FROM app_limit_catalog WHERE app = ${text(app.name)} AND key NOT IN (${keys.join(', ')});`
      : `DELETE FROM app_limit_catalog WHERE app = ${text(app.name)};`)
    limits.forEach((limit, position) => {
      statements.push(
        'INSERT INTO app_limit_catalog (app, key, label, unit, default_value, position, updated_at) VALUES '
          + `(${text(app.name)}, ${text(limit.key)}, ${text(limit.label.trim())}, ${text(limit.unit)}, ${limit.default}, ${position}, ${Math.trunc(now)}) `
          + 'ON CONFLICT (app, key) DO UPDATE SET label = excluded.label, unit = excluded.unit, default_value = excluded.default_value, '
          + 'position = excluded.position, updated_at = excluded.updated_at;',
      )
    })
  }
  return `${statements.join('\n')}\n`
}

/** The catalog an app directory's package.json declares: `{ name, limits }`, named after the directory. */
export function readAppLimits(directory) {
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return { name: basename(resolve(directory)), limits: pkg.insulin?.limits }
}

if (process.argv[1] && process.argv[1].endsWith('limits-catalog.mjs')) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--out')
  const out = at === -1 ? null : args[at + 1]
  const directories = args.filter((arg, index) => arg !== '--out' && (at === -1 || index !== at + 1))
  if (!directories.length || (at !== -1 && !out)) {
    console.error('usage: node scripts/limits-catalog.mjs <app directory>... [--out <file>]')
    process.exit(2)
  }
  const sql = limitsCatalogSql(directories.map(readAppLimits))
  if (out) writeFileSync(out, sql)
  else process.stdout.write(sql)
}
