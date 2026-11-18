// Who in an organization can use an app, as Esign asks it (DESIGN.md §8.9): the people to share with and an API
// client's people come from the member lookup, with the x-suger-member-lookup header of the browser request the app is
// serving; whether whoever scheduled a send may still send comes from member status. Those its People page counts, by
// name or email, with their roles and permissions in the app, and nothing for anyone else. (These were the checks of
// the earlier GET /__insulin/members, which took the organization from the app; that answer is now the lookup's.)
// All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, SECRET_KEY, startGateway } from './helpers/harness.mjs'
import { appToken } from '../../../scripts/deploy-apps.mjs'

const CATALOG = [
  { key: 'captable.manage', label: 'Record changes', description: 'Record and reverse equity changes.', role: 'EDITOR' },
  { key: 'captable.view', label: 'View the cap table', description: 'See everything, read only.', role: 'EDITOR' },
  { key: 'portfolio.view', label: 'See own holdings', description: 'Their own holdings.', role: 'VIEWER' },
]
const CAPTABLE_TOKEN = appToken(SECRET_KEY, 'captable')
const LEDGER_TOKEN = appToken(SECRET_KEY, 'ledger')

let h
before(async () => {
  h = await startGateway({ apps: APPS.map((app) => (app.name === 'captable' ? { ...app, permissions: CATALOG } : app)), stubBindings: ['APP_LEDGER'] })
})
after(async () => { await h?.close() })

/** The member lookup header the gateway signed on `person`'s browser request to `app` (which also notes the app's use). */
async function lookupHeader(person, app = 'captable', harness = h) {
  const response = await person.client.get(harness.url(app, '/api/echo'))
  assert.equal(response.status, 200, response.text.slice(0, 300))
  return JSON.parse(response.text).headers['x-suger-member-lookup']
}

async function members(q, header, { token = CAPTABLE_TOKEN, site = 'apex', method = 'GET', harness = h } = {}) {
  const response = await harness.client().request(harness.url(site, `/__insulin/members?q=${encodeURIComponent(q)}`), {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(header ? { 'x-suger-member-lookup': header } : {}) },
  })
  let json = null
  try { json = JSON.parse(response.text) } catch { /* not JSON */ }
  return { ...response, json }
}

async function status(org, ids, token = CAPTABLE_TOKEN) {
  const response = await h.client().request(h.url('apex', '/__insulin/members/status'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ org, ids }),
  })
  return { ...response, json: JSON.parse(response.text) }
}

async function member(orgId, name, role, grants = {}) {
  const person = await h.user({ name })
  const now = Date.now()
  await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  for (const [app, grant] of Object.entries(grants)) {
    await h.sql('INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)', orgId, person.id, app, grant, now)
  }
  return person
}

test("an app gets the organization's people who can use it: by role, or given the app; with their roles and permissions there", async () => {
  const owner = await h.user({ name: 'Olive Owner Dirtest' })
  const orgId = await h.org(owner.client, 'Directory Org')
  const editor = await member(orgId, 'Eddie Editor Dirtest', 'EDITOR')
  const viewer = await member(orgId, 'Vera Viewer Dirtest', 'VIEWER')
  const given = await member(orgId, 'Abe App-Admin Dirtest', 'APPS', { captable: 'ADMIN' })
  const elsewhere = await member(orgId, 'Lee Ledger-Only Dirtest', 'APPS', { ledger: 'ADMIN' })
  const custom = await member(orgId, 'Cass Custom Dirtest', 'APPS')
  await h.sql("INSERT INTO custom_roles (id, org_id, app, name, permissions, created_at, updated_at) VALUES ('role-reader', ?1, 'captable', 'Reader', '[\"captable.view\"]', 1, 1)", orgId)
  await h.sql("INSERT INTO app_grants (org_id, user_id, app, role, custom_role_id, created_at, updated_at) VALUES (?1, ?2, 'captable', 'CUSTOM', 'role-reader', 1, 1)", orgId, custom.id)
  const outsider = await h.user({ name: 'Otto Outsider Dirtest' })
  const header = await lookupHeader(owner)

  const answer = await members('dirtest', header)
  assert.equal(answer.status, 200, answer.text)
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  const listed = answer.json.members.filter((m) => m.type === 'person')
  assert.deepEqual(listed.map((m) => m.email).sort(), [owner, editor, viewer, given, custom].map((p) => p.email).sort())
  assert.ok(!listed.some((m) => m.email === elsewhere.email), 'a specific-apps member without the app is not listed')
  assert.ok(!listed.some((m) => m.email === outsider.email), 'nor anyone outside the organization')
  assert.deepEqual(Object.keys(listed[0]).sort(), ['appRole', 'email', 'id', 'name', 'type'])
  assert.equal(listed.find((m) => m.email === editor.email).id, editor.id, 'the id their requests carry')
  const role = (person) => listed.find((m) => m.email === person.email).appRole
  assert.deepEqual([owner, editor, viewer, given, custom].map(role), ['ADMIN', 'EDITOR', 'VIEWER', 'ADMIN', 'EDITOR'], 'given the app as Admin; a custom role as the least built-in role covering it')

  // Their role and permissions in the app, as their requests carry them: what they may do there now (member status,
  // which an app asks with ids it holds, as Esign does for whoever scheduled a send).
  const access = async (person) => { const [entry] = (await status(orgId, [person.id])).json.members; return [entry.status, entry.appRole, entry.permissions.join(' ')] }
  assert.deepEqual(await access(owner), ['member', 'ADMIN', 'captable.manage captable.view portfolio.view'])
  assert.deepEqual(await access(editor), ['member', 'EDITOR', 'captable.manage captable.view portfolio.view'])
  assert.deepEqual(await access(viewer), ['member', 'VIEWER', 'portfolio.view'])
  assert.deepEqual(await access(given), ['member', 'ADMIN', 'captable.manage captable.view portfolio.view'], 'given the app as Admin')
  assert.deepEqual(await access(custom), ['member', 'EDITOR', 'captable.view'], 'a custom role: its permissions only')
  assert.equal((await status(orgId, [elsewhere.id])).json.members[0].status, 'left', 'no access to this app')

  // An account Insulin Apps suspended or disabled uses no app (DESIGN.md §11.3): the lookup leaves it out, and member
  // status says its standing.
  const paused = await member(orgId, 'Sid Suspended Dirtest', 'EDITOR'), ended = await member(orgId, 'Dee Disabled Dirtest', 'EDITOR')
  await h.sql("UPDATE users SET status = 'suspended' WHERE id = ?1", paused.id)
  await h.sql("UPDATE users SET status = 'disabled' WHERE id = ?1", ended.id)
  const now = (await members('dirtest', header)).json.members.map((m) => m.email)
  assert.ok(!now.includes(paused.email) && !now.includes(ended.email), 'nobody suspended or disabled')
  assert.ok(now.includes(editor.email))
  assert.deepEqual((await status(orgId, [paused.id, ended.id])).json.members.map((m) => m.standing), ['suspended', 'disabled'])
  // Narrowed by name or email, case-insensitively.
  assert.deepEqual((await members('EDDIE EDITOR', header)).json.members.map((m) => m.email), [editor.email])
  assert.deepEqual((await members(editor.email.toUpperCase(), header)).json.members.map((m) => m.id), [editor.id], 'an address, as Esign checks an API client\'s people')
  // Another app: with a header signed for it and its own token, the people who can use that app.
  const ledgerHeader = await lookupHeader(owner, 'ledger')
  assert.deepEqual((await members('dirtest', ledgerHeader, { token: LEDGER_TOKEN })).json.members.map((m) => m.email).sort(), [owner, editor, viewer, elsewhere].map((p) => p.email).sort())
})

test('refused: no token or a wrong one, no lookup header or a forged one, a bad query, another host, another method; an unavailable organization', async () => {
  const owner = await h.user({ name: 'Rita Refused' })
  const orgId = await h.org(owner.client, 'Refusals Org')
  const header = await lookupHeader(owner)
  assert.equal((await members('rita', header)).status, 200)
  assert.equal((await members('rita', header, { token: null })).status, 401)
  assert.equal((await members('rita', header, { token: appToken(Buffer.alloc(32, 1).toString('base64'), 'captable') })).status, 401)
  assert.equal((await members('rita', null)).status, 403, "the app's token alone reads no one")
  assert.equal((await members('rita', 'not-a-header')).status, 403)
  const [version, , user, expires, signature] = header.split('.')
  assert.equal((await members('rita', [version, '00000000-0000-4000-8000-000000000000', user, expires, signature].join('.'))).status, 403, 'an organization the app names itself')
  for (const q of ['', 'x'.repeat(101)]) assert.equal((await members(q, header)).status, 400, `q of ${q.length}`)
  assert.equal((await members('rita', header, { site: 'captable' })).status, 404, 'on the apex only')
  assert.equal((await members('rita', header, { method: 'POST' })).status, 405)
  assert.equal((await status('00000000-0000-4000-8000-000000000000', [])).status, 404)
  await h.sql("UPDATE orgs SET status = 'suspended' WHERE id = ?1", orgId)
  assert.equal((await members('rita', header)).status, 403, 'nobody looks people up in a suspended organization')
  assert.equal((await status(orgId, [owner.id])).json.standing, 'suspended')
})

test("one organization's lookups never use up another's", async () => {
  const limited = await startGateway({ appLimit: 2 })
  try {
    const busy = await limited.user({ name: 'Busy Owner' }), quiet = await limited.user({ name: 'Quiet Owner' })
    await limited.org(busy.client, 'Busy Org')
    await limited.org(quiet.client, 'Quiet Org')
    const [busyHeader, quietHeader] = [await lookupHeader(busy, 'captable', limited), await lookupHeader(quiet, 'captable', limited)]
    const ask = async (header) => (await members('owner', header, { harness: limited })).status
    assert.deepEqual([await ask(busyHeader), await ask(busyHeader), await ask(busyHeader)], [200, 200, 429], 'limited per person')
    assert.equal(await ask(quietHeader), 200, 'another organization still asks')
  } finally { await limited.close() }
})

/** People added straight to the database, many at a time: id, address and name, as members of `orgId` with `role`. */
async function members_(orgId, people, role = 'EDITOR') {
  const now = Date.now()
  for (const person of people) {
    await h.sql('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', person.id, person.email, person.name, now)
    await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  }
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('names and addresses are matched without regard to case beyond ASCII: people and API clients', async () => {
  const owner = await h.user({ name: 'Una Unicode' })
  const orgId = await h.org(owner.client, 'Unicode Org')
  await members_(orgId, [
    { id: uuid(9001), email: 'elodie.example@example.test', name: 'Élodie Example' },
    { id: uuid(9002), email: 'oeystein@example.test', name: 'ØYSTEIN ÅSHEIM' },
    { id: uuid(9003), email: 'dmitri@example.test', name: 'Дмитрий Пример' },
  ])
  await h.sql(`INSERT INTO service_accounts (id, org_id, app, name, role, client_id, secret_hash, created_at, updated_at)
    VALUES (?1, ?2, 'captable', 'Ärzte Sync', 'EDITOR', 'ia_sa_unicodeclient0000000001', 'hash', 1, 1)`, uuid(9004), orgId)
  const header = await lookupHeader(owner)
  const ids = async (q) => (await members(q, header)).json.members.map((m) => m.id)
  for (const q of ['élodie', 'ÉLODIE', 'Élodie', 'odie ex']) assert.deepEqual(await ids(q), [uuid(9001)], q)
  for (const q of ['øystein åsheim', 'Øystein', 'ÅSHEIM']) assert.deepEqual(await ids(q), [uuid(9002)], q)
  for (const q of ['дмитрий', 'ПРИМЕР']) assert.deepEqual(await ids(q), [uuid(9003)], q)
  for (const q of ['ärzte', 'ÄRZTE SYNC']) assert.deepEqual(await ids(q), [uuid(9004)], `${q}: an API client`)
  assert.deepEqual(await ids('éloxx'), [], 'still only what contains it')
})

test('an exact address comes first, ahead of 20 people whose address contains it, so an app checking an address finds it', async () => {
  const owner = await h.user({ name: 'Cora Crowd' })
  const orgId = await h.org(owner.client, 'Crowded Org')
  const crowd = Array.from({ length: 20 }, (_, i) => ({ id: uuid(9100 + i), email: `person${i}+eva@example.test`, name: `Aaron Crowd ${String(i).padStart(2, '0')}` }))
  await members_(orgId, [...crowd, { id: uuid(9200), email: 'eva@example.test', name: 'Zed Target' }])
  const header = await lookupHeader(owner)
  const found = (await members('eva@example.test', header)).json.members
  assert.equal(found.length, 20, 'a full answer')
  assert.equal(found[0].id, uuid(9200), 'the address itself first')
  assert.deepEqual((await members('EVA@Example.test', header)).json.members[0].id, uuid(9200), 'without regard to case')
  assert.deepEqual(found.slice(1).map((m) => m.name), crowd.slice(0, 19).map((p) => p.name), 'then by name')
})
