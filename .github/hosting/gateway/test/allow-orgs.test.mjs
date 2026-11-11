// The operator's script that lets an owner domain have more organizations (.github/hosting/scripts/allow-orgs.mjs):
// strict input checks, the SQL it builds (run here against the real migrations), and the wrangler call it makes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { COMPATIBILITY_DATE, gatewayDir } from './helpers/bundle.mjs'
import { applyMigrations } from './helpers/harness.mjs'
import {
  DATABASE, UsageError, allowanceSql, main, parseArgs, parseMax, parseNote, parseOwnerDomain, wranglerArgs, wranglerPath,
} from '../../scripts/allow-orgs.mjs'
import { orgAllowance } from '../src/db/orgs.ts'

const PROVIDER = 'gmail.com'

test('the owner domain: a domain in lower case and punycode, or an address without a +tag; nothing else', () => {
  assert.equal(parseOwnerDomain(' Example.COM. '), 'example.com')
  assert.equal(parseOwnerDomain('bücher.example'), 'xn--bcher-kva.example')
  assert.equal(parseOwnerDomain(`Ada.Lovelace@${PROVIDER}`), `ada.lovelace@${PROVIDER}`)
  for (const bad of [
    '', 'localhost', '10.0.0.1', 'exa mple.com', "example.com'; DROP TABLE orgs; --", 'example.com/path', 'example.com:443', 'exa%6dple.com',
    '"example.com"', 'example..com', '-example.com', `${'a'.repeat(64)}.com`, `ada+work@${PROVIDER}`, `o'brien@${PROVIDER}`, `@${PROVIDER}`,
    `a@b@${PROVIDER}`, undefined,
  ]) {
    assert.throws(() => parseOwnerDomain(bad), UsageError, String(bad))
  }
})

test('the number and the note', () => {
  assert.equal(parseMax('0'), 0)
  assert.equal(parseMax(' 5 '), 5)
  assert.equal(parseMax('1000'), 1000)
  for (const bad of ['', '-1', '1001', '2.5', '1e3', '0x10', '5 orgs', '99999', undefined]) assert.throws(() => parseMax(bad), UsageError, String(bad))
  assert.equal(parseNote(undefined), null)
  assert.equal(parseNote('   '), null)
  assert.equal(parseNote(" Approved: O'Brien  & Co (ticket #12) "), "Approved: O'Brien & Co (ticket #12)")
  assert.equal(parseNote('Größere Firma'), 'Größere Firma')
  for (const bad of ['a;b', 'a -- b', 'a\nb', 'a"b', 'a\\b', 'a`b', '$(x)', 'a*b', 'x'.repeat(201)]) {
    assert.throws(() => parseNote(bad), UsageError, bad)
  }
})

test('the command line: required, known and single options only', () => {
  assert.deepEqual(parseArgs(['--domain', 'Example.com', '--max', '5']), { domain: 'example.com', max: 5, note: null, remote: false })
  assert.deepEqual(parseArgs(['--remote', '--note', 'Approved', '--max', '3', '--domain', 'example.org']), { domain: 'example.org', max: 3, note: 'Approved', remote: true })
  assert.deepEqual(parseArgs(['--help']), { help: true })
  for (const bad of [
    [], ['--domain', 'example.com'], ['--max', '5'], ['--domain', '--max', '5'], ['--domain', 'example.com', '--max'],
    ['--domain', 'example.com', '--max', '5', '--domain', 'example.org'], ['--domain', 'example.com', '--max', '5', '--force'],
    ['example.com', '5'], ['--domain=example.com', '--max', '5'],
  ]) {
    assert.throws(() => parseArgs(bad), UsageError, bad.join(' '))
  }
})

test('the SQL is one upsert with quoted, checked values, and it works against the migrated database', async () => {
  const sql = allowanceSql({ domain: 'allowed.example', max: 5, note: "O'Brien asked", now: 1_700_000_000_000 })
  assert.equal(sql, "INSERT INTO org_domain_allowances (owner_domain, max_orgs, note, created_at) VALUES ('allowed.example', 5, 'O''Brien asked', 1700000000000) ON CONFLICT (owner_domain) DO UPDATE SET max_orgs = excluded.max_orgs, note = COALESCE(excluded.note, org_domain_allowances.note)")
  assert.ok(!sql.includes(';'))
  assert.throws(() => allowanceSql({ domain: "x'; --", max: 5, note: null, now: 1 }), UsageError, 'the values are checked here too')
  assert.throws(() => allowanceSql({ domain: 'allowed.example', max: '5); DROP TABLE orgs; --', note: null, now: 1 }), UsageError)

  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.WARN),
    workers: [{ name: 'allow-check', modules: true, script: 'export default { fetch() { return new Response() } }', compatibilityDate: COMPATIBILITY_DATE, d1Databases: { DB: 'allow-check' } }],
  }))
  try {
    const db = await mf.getD1Database('DB')
    await applyMigrations(db)
    await db.prepare(sql).run()
    assert.deepEqual(await orgAllowance(db, 'someone@allowed.example'), { ownerDomain: 'allowed.example', count: 0, max: 5 })
    // Run again: the number changes, the note and the first date stay unless a note is given.
    await db.prepare(allowanceSql({ domain: 'Allowed.Example', max: 8, note: null, now: 1_800_000_000_000 })).run()
    let row = await db.prepare("SELECT max_orgs, note, created_at FROM org_domain_allowances WHERE owner_domain = 'allowed.example'").first()
    assert.deepEqual(row, { max_orgs: 8, note: "O'Brien asked", created_at: 1_700_000_000_000 })
    await db.prepare(allowanceSql({ domain: 'allowed.example', max: 0, note: 'Closed', now: 1 })).run()
    row = await db.prepare("SELECT max_orgs, note FROM org_domain_allowances WHERE owner_domain = 'allowed.example'").first()
    assert.deepEqual(row, { max_orgs: 0, note: 'Closed' })
    await db.prepare(allowanceSql({ domain: `grace@${PROVIDER}`, max: 4, note: null, now: 1 })).run()
    assert.equal((await orgAllowance(db, `Grace+work@${PROVIDER}`)).max, 4, 'an address at a provider, as the gateway counts it')
  } finally {
    await mf.dispose()
  }
})

test('it runs the gateway\'s wrangler on the production database by name, or on the local development one', () => {
  assert.deepEqual(wranglerArgs({ remote: true, sql: 'SELECT 1' }), ['d1', 'execute', DATABASE, '--remote', '--command', 'SELECT 1'])
  assert.deepEqual(wranglerArgs({ remote: false, sql: 'SELECT 1' }), [
    'd1', 'execute', DATABASE, '--local', '--config', join(gatewayDir, 'wrangler.local.jsonc'), '--persist-to', join(gatewayDir, '.dev', 'state'), '--command', 'SELECT 1',
  ])

  const calls = []
  const output = []
  const spawn = (program, args, options) => {
    calls.push({ program, args, options })
    return { status: 0 }
  }
  assert.equal(main(['--domain', 'Example.com', '--max', '5', '--note', 'Approved', '--remote'], { spawn, now: 42, out: (line) => output.push(line), err: (line) => output.push(line) }), 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].program, wranglerPath())
  assert.equal(calls[0].options.cwd, gatewayDir)
  assert.deepEqual(calls[0].args.slice(0, 5), ['d1', 'execute', DATABASE, '--remote', '--command'])
  assert.equal(calls[0].args[5], allowanceSql({ domain: 'example.com', max: 5, note: 'Approved', now: 42 }))
  assert.match(output.join('\n'), /Allowing example\.com 5 organizations in the production database\./)

  // Bad input never reaches wrangler; a failed wrangler is the script's failure.
  assert.equal(main(['--domain', "x'--", '--max', '5'], { spawn, out: () => {}, err: (line) => output.push(line) }), 2)
  assert.equal(calls.length, 1)
  assert.match(output.at(-1), /Usage: node \.github\/hosting\/scripts\/allow-orgs\.mjs/)
  assert.equal(main(['--domain', 'example.com', '--max', '5'], { spawn: () => ({ status: 3 }), out: () => {} }), 3)
  assert.equal(main(['--domain', 'example.com', '--max', '5'], { spawn: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }), out: () => {}, err: () => {} }), 1)
})
