// App limits (DESIGN.md §8.8): the catalog the deploy writes to D1 (scripts/limits-catalog.mjs), GET /__insulin/limits
// with its defaults, overrides, cursor and pages, the console's /super/apps/<app>/limits and each organization's Limits
// section (admins change, everything audited), the watch list at 80%, and an app's 429 reaching an AI assistant. All
// data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPS, SECRET_KEY, splitStatements, startGateway } from './helpers/harness.mjs'
import { appToken, connect, tool } from './helpers/oauth.mjs'
import { encode, makeIdentityProviderKey, requestIdFrom, samlResponse, signResponse } from './helpers/saml-idp.mjs'
import { LIMITS_PER_APP, limitsCatalogSql, limitsProblems } from '../scripts/limits-catalog.mjs'
import { parseEndDate, parseLimitValue } from '../src/super/limits.ts'

const IDP_KEY = makeIdentityProviderKey('Stand-in Workspace')
const IDP_ENTITY = 'https://accounts.example.test/o/saml2/workspace'
const IDP_SSO = 'https://accounts.example.test/o/saml2/sso'
const GROUP = 'Insulin Apps Operators'
const ADMIN = 'ada.admin@staff.example.test'
const OPERATOR = 'otto.operator@staff.example.test'
const SUPER_VARS = {
  SUPER_SAML_IDP_ENTITY_ID: IDP_ENTITY,
  SUPER_SAML_IDP_SSO_URL: IDP_SSO,
  SUPER_SAML_IDP_CERT: IDP_KEY.certificate,
  SUPER_GOOGLE_GROUP: GROUP,
  SUPER_ADMIN_EMAILS: ADMIN,
}
const UNDER_TEST = [
  APPS.find((app) => app.name === 'captable'),
  { name: 'ledger', title: 'Ledger', summary: 'A second app, deployed in these tests.', binding: 'APP_LEDGER' },
]
// Synthetic limits, shaped like Knowledge's.
const LIMITS = [
  { key: 'collections', label: 'Collections', unit: 'count', default: 20 },
  { key: 'storage_bytes', label: 'Stored files', unit: 'bytes', default: 2147483648 },
  { key: 'questions_month', label: 'Questions a month', unit: 'count', default: 5000 },
  { key: 'awake_hours_month', label: 'Awake hours a month', unit: 'hours', default: 100 },
  { key: 'backup_days', label: 'Days of daily backups', unit: 'days', default: 30 },
]
const DEFAULTS = { collections: 20, storage_bytes: 2147483648, questions_month: 5000, awake_hours_month: 100, backup_days: 30 }
const CAPTABLE_TOKEN = appToken(SECRET_KEY, 'captable')
const LEDGER_TOKEN = appToken(SECRET_KEY, 'ledger')
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

let h
before(async () => {
  h = await startGateway({ vars: SUPER_VARS, apps: UNDER_TEST, stubBindings: ['APP_LEDGER'] })
  await writeCatalog([{ name: 'captable', limits: LIMITS }])
})
after(async () => { await h?.close() })

/** Runs the deploy's SQL against the gateway's D1, statement by statement, as `wrangler d1 execute --file` does. */
async function writeCatalog(apps) {
  for (const statement of splitStatements(limitsCatalogSql(apps))) await h.db.prepare(statement).run()
}

/** A browser signed in to the console as `email`, through the stand-in Workspace app. */
async function operator(email = OPERATOR) {
  const client = h.client()
  const start = await client.get(h.url('apex', '/super/login'))
  const { id } = requestIdFrom(start.location)
  const xml = samlResponse({
    issuer: IDP_ENTITY, email, displayName: 'Synthetic Operator', acs: h.url('apex', '/super/saml/acs'), entityId: h.url('apex', '/super'), requestId: id,
    attributes: { groups: [GROUP] },
  })
  const signedIn = await client.post(h.url('apex', '/super/saml/acs'), { SAMLResponse: encode(signResponse(xml, IDP_KEY)) }, { origin: 'https://accounts.example.test' })
  assert.equal(signedIn.status, 303, signedIn.text.slice(0, 300))
  return client
}

/** An owner and an organization where Cap Table is used. */
async function team(name = 'Limits Org') {
  const owner = await h.user({ name: 'Lim Owner' })
  const orgId = await h.org(owner.client, name)
  assert.equal((await owner.client.get(h.url('captable', '/api/echo'))).status, 200)
  return { owner, orgId }
}

async function limits(since, token = CAPTABLE_TOKEN) {
  const response = await h.client().get(h.url('apex', `/__insulin/limits${since === undefined ? '' : `?since=${since}`}`), { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200, response.text)
  return JSON.parse(response.text)
}

/** The cursor an app holds after reading everything there is now. */
async function latestCursor() {
  let page = await limits(0)
  while (page.more) page = await limits(page.cursor)
  return page.cursor
}

function nextDay(offsetDays) {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)
}

const topOfHour = () => new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS).toISOString().replace('.000Z', 'Z')

function report(organizations, app = 'captable') {
  return h.client().post(h.url('apex', '/__insulin/metrics'), {}, {
    contentType: 'application/json', headers: { Authorization: `Bearer ${appToken(SECRET_KEY, app)}` },
    body: JSON.stringify({ hour: topOfHour(), organizations }),
  })
}

test('the deploy writes an app\'s whole catalog to D1, replacing what it had; a malformed catalog is refused whole', async () => {
  const rows = () => h.sql("SELECT key, label, unit, default_value, position FROM app_limit_catalog WHERE app = 'ledger' ORDER BY position")
  await writeCatalog([{ name: 'ledger', limits: [{ key: 'entries', label: "Ledger's entries", unit: 'count', default: 10 }, { key: 'files_bytes', label: 'Files', unit: 'bytes', default: 1024 }] }])
  assert.deepEqual(await rows(), [
    { key: 'entries', label: "Ledger's entries", unit: 'count', default_value: 10, position: 0 },
    { key: 'files_bytes', label: 'Files', unit: 'bytes', default_value: 1024, position: 1 },
  ], 'quotes in a label are written as they are')
  await writeCatalog([{ name: 'ledger', limits: [{ key: 'files_bytes', label: 'Files', unit: 'bytes', default: 2048 }] }])
  assert.deepEqual(await rows(), [{ key: 'files_bytes', label: 'Files', unit: 'bytes', default_value: 2048, position: 0 }], 'a key no longer listed goes')
  await writeCatalog([{ name: 'ledger' }])
  assert.deepEqual(await rows(), [], 'an app without limits has none')
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM app_limit_catalog WHERE app = 'captable'"))[0].n, LIMITS.length, 'apps not named are left as they are')

  assert.deepEqual(limitsProblems('captable', LIMITS), [])
  const bad = [
    { key: 'Bad Key', label: 'x', unit: 'count', default: 1 },
    { key: 'dup', label: 'x', unit: 'count', default: 1 },
    { key: 'dup', label: 'y', unit: 'count', default: 1 },
    { key: 'unit', label: 'x', unit: 'minutes', default: 1 },
    { key: 'negative', label: 'x', unit: 'count', default: -1 },
    { key: 'fraction', label: 'x', unit: 'count', default: 1.5 },
    { key: 'label', label: 'two\nlines', unit: 'count', default: 1 },
    { key: 'extra', label: 'x', unit: 'count', default: 1, max: 2 },
  ]
  const problems = limitsProblems('ledger', bad)
  assert.equal(problems.length, 7, problems.join('\n'))
  assert.equal(limitsProblems('ledger', Array.from({ length: LIMITS_PER_APP + 1 }, (_, index) => ({ key: `k${index}`, label: 'x', unit: 'count', default: 1 }))).length, 1)
  assert.equal(limitsProblems('Not An App', []).length, 1)
  assert.throws(() => limitsCatalogSql([{ name: 'ledger', limits: bad }]), /Malformed limit catalog:\nledger: insulin\.limits\[0\]\.key/)
  assert.match(limitsCatalogSql([{ name: 'ledger', limits: [{ key: 'a', label: "O'Brien's", unit: 'count', default: 1 }] }]), /'O''Brien''s'/)

  // The command line, for an app directory's package.json.
  const dir = mkdtempSync(join(tmpdir(), 'limits-catalog-'))
  try {
    const app = join(dir, 'ledger')
    mkdirSync(app)
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'ledger', insulin: { limits: [{ key: 'entries', label: 'Entries', unit: 'count', default: 5 }] } }))
    const out = join(dir, 'catalog.sql')
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'limits-catalog.mjs'), app, '--out', out], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const printed = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'limits-catalog.mjs'), app], { encoding: 'utf8' })
    assert.match(printed.stdout, /^DELETE FROM app_limit_catalog WHERE app = 'ledger' AND key NOT IN \('entries'\);\nINSERT INTO app_limit_catalog/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /__insulin/limits: every default in force, and only the asking app\'s, in organizations where it is used', async () => {
  const first = await limits()
  assert.deepEqual(first.defaults, DEFAULTS)
  assert.match(first.cursor, /^\d+$/)
  assert.equal(typeof first.more, 'boolean')
  const ledger = await limits(undefined, LEDGER_TOKEN)
  assert.deepEqual(ledger.defaults, {}, 'Ledger has no catalog')
  assert.deepEqual(ledger.organizations, [])
  const bad = await h.client().get(h.url('apex', '/__insulin/limits?since=-4'), { headers: { Authorization: `Bearer ${CAPTABLE_TOKEN}` } })
  assert.equal(bad.status, 400)
})

test('LIM-04: console defaults: the catalog with each default; an admin changes one with a reason; audited; the app reads it', async () => {
  const reader = await operator()
  const page = await reader.get(h.url('apex', '/super/apps/captable/limits'))
  assert.equal(page.status, 200)
  assert.match(page.text, /<h1>Cap Table limits<\/h1>/)
  assert.match(page.text, /Questions a month/)
  assert.match(page.text, /2\.00 GB/, 'bytes as GB')
  assert.match(page.text, /100 hours/)
  assert.doesNotMatch(page.text, /Change the default/, 'operators read only')
  assert.equal((await reader.post(h.url('apex', '/super/apps/captable/limits'), { action: 'set', key: 'questions_month', value: '1', reason: 'Not allowed to' })).status, 403)
  assert.match((await reader.get(h.url('apex', '/super/apps'))).text, /href="\/super\/apps\/captable\/limits"/)

  const admin = await operator(ADMIN)
  const form = await admin.get(h.url('apex', '/super/apps/captable/limits'))
  assert.match(form.text, /Change the default/)
  const before = await latestCursor()
  const post = (fields) => admin.post(h.url('apex', '/super/apps/captable/limits'), fields)
  const noReason = await post({ action: 'set', key: 'questions_month', value: '8000', reason: '' })
  assert.equal(noReason.status, 400)
  assert.match(noReason.text, /Give a reason/)
  assert.equal((await post({ action: 'set', key: 'questions_month', value: 'lots', reason: 'Pilot customers' })).status, 400)
  assert.equal((await post({ action: 'set', key: 'nothing_here', value: '1', reason: 'Pilot customers' })).status, 400)
  assert.equal((await admin.post(h.url('apex', '/super/apps/nowhere/limits'), { action: 'set', key: 'questions_month', value: '1', reason: 'Pilot' })).status, 404)
  assert.equal((await admin.post(h.url('apex', '/super/apps/captable/limits'), { action: 'set', key: 'questions_month', value: '1', reason: 'Cross-site' }, { origin: 'https://evil.example.test' })).status, 403)

  const changed = await post({ action: 'set', key: 'questions_month', value: '8,000', reason: 'Pilot customers ask more' })
  assert.equal(changed.status, 303, changed.text.slice(0, 300))
  assert.equal(changed.location, h.url('apex', '/super/apps/captable/limits?notice=default_set'))
  assert.equal((await post({ action: 'set', key: 'questions_month', value: '8000', reason: 'Again' })).location, h.url('apex', '/super/apps/captable/limits?notice=unchanged'))
  assert.equal((await post({ action: 'set', key: 'storage_bytes', value: '3 GB', reason: 'Bigger files' })).status, 303)
  assert.equal((await post({ action: 'set', key: 'backup_days', value: 'unlimited', reason: 'Keep them all' })).status, 303)
  const read = await limits(before)
  assert.deepEqual(read.defaults, { ...DEFAULTS, questions_month: 8000, storage_bytes: 3 * 1024 ** 3, backup_days: null }, 'null is unlimited')
  assert.deepEqual(read.organizations, [], 'a default changes no organization\'s overrides')

  const shown = await admin.get(h.url('apex', '/super/apps/captable/limits?notice=default_set'))
  assert.match(shown.text, /The default is changed/)
  assert.match(shown.text, /8,000/)
  assert.match(shown.text, /Unlimited/)
  assert.match(shown.text, /Pilot customers ask more/)
  const history = await h.sql("SELECT action, target_type, target_id, target_label, reason, operator_email FROM super_audit WHERE target_type = 'app' ORDER BY id")
  assert.deepEqual(history.slice(0, 3), [
    { action: 'app.limit_default', target_type: 'app', target_id: 'captable', target_label: 'Cap Table: Questions a month', reason: 'Pilot customers ask more', operator_email: ADMIN },
    { action: 'app.limit_default', target_type: 'app', target_id: 'captable', target_label: 'Cap Table: Stored files', reason: 'Bigger files', operator_email: ADMIN },
    { action: 'app.limit_default', target_type: 'app', target_id: 'captable', target_label: 'Cap Table: Days of daily backups', reason: 'Keep them all', operator_email: ADMIN },
  ], 'the repeated change recorded nothing')
  const audit = await admin.get(h.url('apex', '/super/audit'))
  assert.match(audit.text, /Changed an app&#x27;s default limit/)
  assert.match(audit.text, /href="\/super\/apps\/captable\/limits"/)

  // Putting the catalog's default back.
  assert.equal((await post({ action: 'reset', key: 'questions_month', reason: 'Pilot over' })).location, h.url('apex', '/super/apps/captable/limits?notice=default_reset'))
  assert.equal((await post({ action: 'reset', key: 'questions_month', reason: 'Pilot over' })).location, h.url('apex', '/super/apps/captable/limits?notice=unchanged'))
  for (const key of ['storage_bytes', 'backup_days']) await post({ action: 'reset', key, reason: 'Back to normal' })
  assert.deepEqual((await limits()).defaults, DEFAULTS)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM super_audit WHERE action = 'app.limit_default_reset'"))[0].n, 3)
})

test('LIM-05: an organization\'s override, until a day; the app gets it after its cursor, and {} once it is removed', async () => {
  const { orgId } = await team('Override Org')
  const admin = await operator(ADMIN)
  const before = await latestCursor()
  const post = (fields) => admin.post(h.url('apex', `/super/orgs/${orgId}/limits`), { app: 'captable', ...fields })
  const lastDay = nextDay(30)
  assert.match((await post({ action: 'set', key: 'questions_month', value: '9000', until: nextDay(-2), reason: 'Launch week' })).text, /can&#x27;t be in the past/)
  assert.equal((await post({ action: 'set', key: 'questions_month', value: '-3', until: '', reason: 'Launch week' })).status, 400)
  assert.equal((await post({ action: 'set', key: 'questions_month', value: '9000', until: '2026-02-30', reason: 'Launch week' })).status, 400)
  assert.equal((await post({ action: 'set', key: 'questions_month', value: '9000', until: '', reason: 'x' })).status, 400, 'a reason of 3 characters or more')
  assert.equal((await admin.post(h.url('apex', `/super/orgs/${orgId}/limits`), { app: 'nowhere', action: 'set', key: 'questions_month', value: '1', reason: 'Launch week' })).status, 400)
  const set = await post({ action: 'set', key: 'questions_month', value: '9000', until: lastDay, reason: 'Launch week' })
  assert.equal(set.status, 303, set.text.slice(0, 300))
  assert.equal(set.location, h.url('apex', `/super/orgs/${orgId}?notice=limit_set#limits`))
  assert.equal((await post({ action: 'set', key: 'storage_bytes', value: 'unlimited', until: '', reason: 'Archive project' })).status, 303)
  const until = new Date(Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS).toISOString()
  const read = await limits(before)
  assert.deepEqual(read.organizations, [{ id: orgId, limits: { questions_month: { value: 9000, until }, storage_bytes: { value: null, until: null } } }])
  assert.equal(read.more, false)
  assert.deepEqual((await limits(read.cursor)).organizations, [], 'nothing new after the cursor')
  assert.ok((await limits()).organizations.some((entry) => entry.id === orgId), 'a first read lists every organization with an override')

  const page = await admin.get(h.url('apex', `/super/orgs/${orgId}?notice=limit_set`))
  assert.match(page.text, /The override is set/)
  assert.match(page.text, /id="limits"/)
  assert.match(page.text, new RegExp(`Through ${lastDay}`))
  assert.match(page.text, /Launch week/)
  const [audit] = await h.sql("SELECT target_type, target_label, reason FROM super_audit WHERE action = 'org.limit_override' AND target_id = ?1 ORDER BY id LIMIT 1", orgId)
  assert.deepEqual(audit, { target_type: 'org', target_label: 'Override Org: Cap Table, Questions a month', reason: 'Launch week' })
  assert.equal((await post({ action: 'set', key: 'questions_month', value: '9000', until: lastDay, reason: 'Same again' })).location, h.url('apex', `/super/orgs/${orgId}?notice=limit_unchanged#limits`))

  // Past its last day the override no longer applies: the console shows the default in force, and the app falls back.
  await h.sql("UPDATE org_app_limits SET until = ?2 WHERE org_id = ?1 AND key = 'questions_month'", orgId, Date.now() - HOUR_MS)
  const ended = await admin.get(h.url('apex', `/super/orgs/${orgId}`))
  assert.match(ended.text, /Ended /)
  const row = /<tr[^>]*>(?:(?!<\/tr>).)*Questions a month(?:(?!<\/tr>).)*<\/tr>/s.exec(ended.text)[0]
  assert.match(row, /5,000(?:(?!<\/td>).)*<\/td><td[^>]*>5,000/s, 'the limit in force is the default again')

  // Removing an override lists the organization with what is left; removing the last, with {}.
  const cursor = await latestCursor()
  assert.equal((await post({ action: 'remove', key: 'storage_bytes', reason: 'Archive done' })).location, h.url('apex', `/super/orgs/${orgId}?notice=limit_removed#limits`))
  assert.deepEqual((await limits(cursor)).organizations.map((entry) => Object.keys(entry.limits)), [['questions_month']])
  const next = await latestCursor()
  assert.equal((await post({ action: 'remove', key: 'questions_month', reason: 'Launch over' })).status, 303)
  assert.deepEqual((await limits(next)).organizations, [{ id: orgId, limits: {} }])
  assert.ok(!(await limits()).organizations.some((entry) => entry.id === orgId), 'no longer on a first read')
  assert.equal((await post({ action: 'remove', key: 'questions_month', reason: 'Again' })).location, h.url('apex', `/super/orgs/${orgId}?notice=limit_unchanged#limits`))
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM super_audit WHERE action = 'org.limit_override_removed' AND target_id = ?1", orgId))[0].n, 2)

  // Operators read; only admins change.
  const reader = await operator()
  assert.doesNotMatch((await reader.get(h.url('apex', `/super/orgs/${orgId}`))).text, /Set the override/)
  assert.equal((await reader.post(h.url('apex', `/super/orgs/${orgId}/limits`), { app: 'captable', action: 'set', key: 'collections', value: '1', reason: 'Not allowed to' })).status, 403)
})

test('an organization that starts using the app gets its overrides at the next read; others\' are never listed', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Not Yet Org')
  const admin = await operator(ADMIN)
  const before = await latestCursor()
  assert.equal((await admin.post(h.url('apex', `/super/orgs/${orgId}/limits`), { app: 'captable', action: 'set', key: 'collections', value: '40', until: '', reason: 'Pre-agreed' })).status, 303)
  const cursor = (await limits(before)).cursor
  assert.ok(!(await limits(before)).organizations.some((entry) => entry.id === orgId), 'not used there yet')
  assert.ok(!(await limits(undefined, LEDGER_TOKEN)).organizations.some((entry) => entry.id === orgId))
  assert.equal((await owner.client.get(h.url('captable', '/api/echo'))).status, 200)
  assert.deepEqual((await limits(cursor)).organizations, [{ id: orgId, limits: { collections: { value: 40, until: null } } }])
})

test('pages hold 500 organizations, oldest change first, with the cursor and more', async () => {
  const before = await latestCursor()
  const base = Number(before)
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
     INSERT INTO orgs (id, name, created_at, updated_at) SELECT printf('00000000-0000-4000-9000-%012d', i), 'Paged ' || i, 0, 0 FROM n`,
  )
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
     INSERT INTO app_orgs (app, org_id, first_at) SELECT 'captable', printf('00000000-0000-4000-9000-%012d', i), 0 FROM n`,
  )
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
     INSERT INTO org_app_limits (org_id, app, key, value, until, reason, changed_by, changed_at, seq)
     SELECT printf('00000000-0000-4000-9000-%012d', i), 'captable', 'collections', i, NULL, 'Paging', 'ops@staff.example.test', 0, ?1 + i FROM n`, base,
  )
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
     INSERT INTO org_app_limit_changes (app, org_id, seq) SELECT 'captable', printf('00000000-0000-4000-9000-%012d', i), ?1 + i FROM n`, base,
  )
  await h.sql('UPDATE app_limit_sequence SET seq = ?1 WHERE id = 1', base + 501)
  const first = await limits(before)
  assert.equal(first.organizations.length, 500)
  assert.equal(first.more, true)
  assert.equal(first.cursor, String(base + 500))
  assert.equal(first.organizations[0].limits.collections.value, 1, 'oldest change first')
  const second = await limits(first.cursor)
  assert.deepEqual(second.organizations, [{ id: '00000000-0000-4000-9000-000000000501', limits: { collections: { value: 501, until: null } } }])
  assert.equal(second.more, false)
  assert.equal(second.cursor, String(base + 501))
})

test('LIM-06: usage beside each limit on the organization\'s page, and organizations at 80% or more on the watch list', async () => {
  const { orgId } = await team('Busy Org')
  const calm = await team('Calm Org')
  assert.equal((await report([
    { id: orgId, metrics: { questions_month: 4600, collections: 3, storage_bytes: 1024 ** 3 } },
    { id: calm.orgId, metrics: { questions_month: 100 } },
  ])).status, 202)
  const reader = await operator()
  // React separates adjacent pieces of text with empty comments.
  const watch = async () => (await reader.get(h.url('apex', '/super'))).text.replaceAll('<!-- -->', '')
  const overview = await watch()
  assert.match(overview, new RegExp(`href="/super/orgs/${orgId}#limits"[^>]*>Busy Org</a> uses 92% of Cap Table&#x27;s questions a month: 4,600 of 5,000 this month\\.`))
  assert.doesNotMatch(overview, /Calm Org<\/a> uses/)
  const page = await reader.get(h.url('apex', `/super/orgs/${orgId}`))
  assert.match(page.text, /4,600 this month/, 'a monthly count is labelled as this month\'s')
  assert.match(page.text, /1\.00 GB/)
  assert.match(page.text, />92%</)
  // An override raises the limit, and the organization leaves the watch list.
  const admin = await operator(ADMIN)
  await admin.post(h.url('apex', `/super/orgs/${orgId}/limits`), { app: 'captable', action: 'set', key: 'questions_month', value: '10000', until: '', reason: 'Room to grow' })
  assert.doesNotMatch(await watch(), /Busy Org<\/a> uses/)
  // Unlimited is never on it.
  await admin.post(h.url('apex', `/super/orgs/${calm.orgId}/limits`), { app: 'captable', action: 'set', key: 'questions_month', value: '100', until: '', reason: 'Tight' })
  assert.match(await watch(), /Calm Org<\/a> uses/)
  await admin.post(h.url('apex', `/super/orgs/${calm.orgId}/limits`), { app: 'captable', action: 'set', key: 'questions_month', value: 'unlimited', until: '', reason: 'No limit' })
  assert.doesNotMatch(await watch(), /Calm Org<\/a> uses/)
})

test('an app\'s 429 quota_exceeded reaches an AI assistant as a tool result marked as an error, with the app\'s message', async () => {
  const { owner, orgId } = await team('Quota Org')
  const agent = await connect(h, owner, orgId)
  const result = await tool(h, agent.access_token, 'read', { path: '/api/quota' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.status, 429)
  assert.equal(result.structuredContent.body.error, 'quota_exceeded')
  assert.match(result.content[0].text, /used its 100 awake hours this month\. Contact Insulin Apps support for more\./)
})

test('a limit\'s value and last day, as an admin types them', () => {
  assert.deepEqual(parseLimitValue('count', ' 8,000 '), { value: 8000 })
  assert.deepEqual(parseLimitValue('count', 'Unlimited'), { value: null })
  assert.deepEqual(parseLimitValue('bytes', '25 MB'), { value: 25 * 1024 ** 2 })
  assert.deepEqual(parseLimitValue('bytes', '1.5gb'), { value: 1.5 * 1024 ** 3 })
  assert.deepEqual(parseLimitValue('bytes', '512'), { value: 512 })
  assert.ok('problem' in parseLimitValue('bytes', '5 parsecs'))
  assert.ok('problem' in parseLimitValue('count', '1.5'))
  assert.ok('problem' in parseLimitValue('hours', '-1'))
  assert.ok('problem' in parseLimitValue('days', '99999999999999999'))
  const now = Date.UTC(2026, 10, 16, 12)
  assert.deepEqual(parseEndDate('', now), { until: null })
  assert.deepEqual(parseEndDate('2026-11-16', now), { until: Date.UTC(2026, 10, 17) }, 'through the last day, UTC')
  assert.ok('problem' in parseEndDate('2026-11-15', now))
  assert.ok('problem' in parseEndDate('2026-02-30', now))
  assert.ok('problem' in parseEndDate('2040-01-01', now))
  assert.ok('problem' in parseEndDate('16/11/2026', now))
})
