import { describe, expect, it } from 'vitest'
import { api, engine } from '#shared'
import { readMigrations } from './helpers.ts'

// The safety-critical enums are CHECK (<column> IN (…)) lists in the migrations, and the contracts in #shared mirror
// them. This test reads the migration SQL itself, so a CHECK change without the matching contract change (or the
// reverse) fails here. drizzle-kit writes every CHECK as `CONSTRAINT "<name>" CHECK(<expression>)`, and a column's
// own CHECK is named `<table>_<column>_check`.

const SQL = readMigrations()
  .map((migration) => migration.sql)
  .join('\n')

/** Index of the parenthesis that closes the one at `open`, skipping string literals. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === "'") index = text.indexOf("'", index + 1)
    else if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return index
  }
  throw new Error(`Unbalanced parentheses: ${text.slice(open, open + 60)}`)
}

/** Every named CHECK expression of every table. */
function checksByTable(sql: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>()
  for (const table of sql.matchAll(/CREATE TABLE `(\w+)` \(/g)) {
    const body = sql.slice(table.index, closing(sql, table.index + table[0].length - 1))
    const checks = new Map<string, string>()
    for (const check of body.matchAll(/CONSTRAINT "(\w+)" CHECK\(/g)) {
      const open = check.index + check[0].length - 1
      checks.set(check[1]!, body.slice(open + 1, closing(body, open)).replace(/\s+/g, ' ').trim())
    }
    tables.set(table[1]!, checks)
  }
  return tables
}
const CHECKS = checksByTable(SQL)

const quoted = (list: string) => [...list.matchAll(/'([^']*)'/g)].map((value) => value[1]!)

/** The values of a column's own `<column> IN ('…', …)` CHECK. */
function enumValues(table: string, column: string): string[] {
  const expression = CHECKS.get(table)?.get(`${table}_${column}_check`)
  const match = expression?.match(new RegExp(`^${column} IN \\(([^)]*)\\)$`))
  if (!match) throw new Error(`No CHECK (${column} IN (…)) on ${table}`)
  return quoted(match[1]!)
}

const MIRRORED: [string, readonly string[]][] = [
  ['orgs.status', api.ORG_STATUSES],
  ['orgs.entity_type', api.ENTITY_TYPES],
  ['import_runs.source_system', api.IMPORT_SOURCES],
  ['import_runs.status', api.IMPORT_RUN_STATUSES],
  ['stakeholders.kind', api.STAKEHOLDER_KINDS],
  ['stakeholders.relationship', api.RELATIONSHIPS],
  ['stakeholders.tax_status', api.TAX_STATUSES],
  ['stakeholders.portal_access', api.PORTAL_ACCESS_MODES],
  ['stakeholder_emails.kind', api.STAKEHOLDER_EMAIL_KINDS],
  ['admin_stakeholder_links.source', api.ADMIN_LINK_SOURCES],
  ['stock_classes.class_type', api.STOCK_CLASS_TYPES],
  ['legends.kind', api.LEGEND_KINDS],
  ['transaction_types.family', api.TRANSACTION_TYPE_FAMILIES],
  ['commands.actor_kind', api.COMMAND_ACTOR_KINDS],
  ['commands.auth_method', api.AUTH_METHODS],
  ['command_dependencies.kind', api.DEPENDENCY_KINDS],
  ['securities.family', api.SECURITY_FAMILIES],
  ['valuations.valuation_type', api.VALUATION_TYPES],
  ['valuations.report_version', api.VALUATION_REPORT_VERSIONS],
  ['valuation_events.kind', api.VALUATION_EVENT_KINDS],
  ['transactions.source', api.TRANSACTION_SOURCES],
  ['document_collections.kind', api.COLLECTION_KINDS],
  ['document_collections.source', api.COLLECTION_SOURCES],
  ['documents.content_type', api.DOCUMENT_CONTENT_TYPES],
  ['documents.source', api.DOCUMENT_SOURCES],
  ['certificates.status', api.CERTIFICATE_STATUSES],
  ['exercise_requests.payment_method', api.PAYMENT_METHODS],
  ['exercise_requests.status', api.EXERCISE_REQUEST_STATUSES],
  ['signature_requests.signer_role', api.SIGNER_ROLES],
  ['signature_requests.status', api.SIGNATURE_STATUSES],
  ['signature_requests.method', api.SIGNATURE_METHODS],
  ['scheduled_terminations.termination_type', api.TERMINATION_TYPES],
  ['scheduled_terminations.status', api.SCHEDULED_TERMINATION_STATUSES],
  ['election_83b_records.status', api.ELECTION_83B_STATUSES],
  ['audit_events.actor_kind', api.AUDIT_ACTOR_KINDS],
  ['audit_events.auth_method', api.AUTH_METHODS],
  ['audit_events.result', api.AUDIT_RESULTS],
]

/** Enum CHECKs no contract mirrors: bookkeeping the API never exposes. */
const DATABASE_ONLY: [string, readonly string[]][] = [
  ['stakeholder_merge_link_moves.kind', ['admin_link', 'document_link']],
  ['stakeholder_merge_link_moves.action', ['moved', 'deduplicated']],
]

describe("the contracts mirror the schema's CHECK lists", () => {
  it.each([...MIRRORED, ...DATABASE_ONLY])('%s', (column, values) => {
    const [table, name] = column.split('.') as [string, string]
    expect(enumValues(table, name)).toEqual([...values])
  })

  it('every enum CHECK is mirrored or known to be database-only', () => {
    const listed = new Set([...MIRRORED, ...DATABASE_ONLY].map(([column]) => column))
    const enumChecks = [...CHECKS].flatMap(([table, checks]) =>
      [...checks]
        .map(([name, expression]) => ({ name, column: expression.match(/^(\w+) IN \( ?'/)?.[1] }))
        .filter((check) => check.column !== undefined && check.name === `${table}_${check.column}_check`)
        .map((check) => `${table}.${check.column}`),
    )
    expect(enumChecks.sort()).toEqual([...listed].sort())
  })

  it('securities pair each family with its subtypes as the table CHECK does', () => {
    const expression = CHECKS.get('securities')!.get('securities_subtype_of_family_check')!
    const pairs: Record<string, string[]> = {}
    for (const match of expression.matchAll(/family = '(\w+)' AND subtype (?:IN \(([^)]*)\)|= '(\w+)')/g)) {
      pairs[match[1]!] = match[2] ? quoted(match[2]) : [match[3]!]
    }
    expect(pairs).toEqual(api.SECURITY_SUBTYPES_BY_FAMILY)
    expect([...api.SECURITY_SUBTYPES].sort()).toEqual(Object.values(pairs).flat().sort())
    expect(Object.keys(pairs)).toEqual([...api.SECURITY_FAMILIES])
  })

  it('every decimal column has the canonical-decimal CHECK the engine implements', () => {
    const canonical =
      "x NOT GLOB '*[^0-9.]*' AND x GLOB '[0-9]*' AND x NOT GLOB '*.*.*' AND x NOT GLOB '*.' AND x NOT GLOB '0[0-9]*' AND x NOT GLOB '*.*0' AND length(x) <= 40 AND (instr(x, '.') = 0 OR length(x) - instr(x, '.') <= 12)"
    const decimals: string[] = []
    const nonZero: string[] = []
    for (const [table, checks] of CHECKS) {
      for (const [name, expression] of checks) {
        const column = expression.match(/^(\w+) NOT GLOB '\*\[\^0-9\.\]\*'/)?.[1]
        if (!column) continue
        expect(name).toBe(`${table}_${column}_check`)
        const generic = expression.replaceAll(column, 'x')
        expect(generic.replace(/ AND x <> '0'$/, ''), name).toBe(canonical)
        decimals.push(`${table}.${column}`)
        if (generic.endsWith(" AND x <> '0'")) nonZero.push(`${table}.${column}`)
      }
    }
    expect(decimals.sort()).toEqual(
      [
        'orgs.share_unit',
        'stock_classes.par_value',
        'stock_classes.original_issue_price',
        'valuation_prices.price_per_share',
        'transactions.quantity',
        'transactions.amount',
        'exercise_requests.quantity',
        'exercise_requests.iso_quantity',
        'exercise_requests.nso_quantity',
        'exercise_requests.exercise_price',
        'exercise_requests.fmv_per_share',
        'exercise_requests.estimated_withholding',
        'exercise_requests.total_cost',
      ].sort(),
    )
    expect(nonZero.sort()).toEqual(
      ['orgs.share_unit', 'valuation_prices.price_per_share', 'transactions.quantity', 'exercise_requests.quantity'].sort(),
    )
  })
})

describe('the transaction_types seed', () => {
  const seeded = [...SQL.matchAll(/\('((?:TX|X)_[A-Z0-9_]+)', '([A-Z_]+)', ([01]), '((?:[^']|'')*)'\)/g)].map((match) => ({
    code: match[1]!,
    family: match[2]!,
    isOcf: match[3] === '1',
    description: match[4]!.replace(/''/g, "'"),
  }))

  it("is the engine's catalogue, row for row by code", () => {
    expect(seeded).toHaveLength(49)
    const byCode = new Map(seeded.map((row) => [row.code, row]))
    expect(new Set(byCode.keys())).toEqual(new Set(engine.TRANSACTION_TYPE_CODES))
    for (const { code, family, isOcf, description } of engine.TRANSACTION_TYPES) {
      expect(byCode.get(code), code).toEqual({ code, family, isOcf, description })
    }
  })

  it('names OCF types TX_ and extensions X_, in the families the contracts know', () => {
    expect(new Set(seeded.map((row) => row.code))).toEqual(new Set(api.TRANSACTION_TYPES))
    for (const row of seeded) {
      expect(api.TRANSACTION_TYPE_FAMILIES, row.code).toContain(row.family)
      expect(row.isOcf, row.code).toBe(row.code.startsWith('TX_'))
      expect(api.transactionTypeSchema.safeParse(row.code).success, row.code).toBe(true)
    }
  })
})
