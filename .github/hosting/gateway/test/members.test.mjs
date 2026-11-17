// Who in an organization can use an app (DESIGN.md §8.7): GET /__insulin/members with the app's token and the
// organization, answered with those its People page counts, by name or email when asked, and nothing for anyone else.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, SECRET_KEY, startGateway } from './helpers/harness.mjs'
import { appToken } from '../../../scripts/deploy-apps.mjs'

const CATALOG = [
  { key: 'captable.manage', label: 'Record changes', description: 'Record and reverse equity changes.', role: 'EDITOR' },
  { key: 'captable.view', label: 'View the cap table', description: 'See everything, read only.', role: 'EDITOR' },
  { key: 'portfolio.view', label: 'See own holdings', description: 'Their own holdings.', role: 'VIEWER' },
]

let h
before(async () => { h = await startGateway({ apps: APPS.map((app) => (app.name === 'captable' ? { ...app, permissions: CATALOG } : app)) }) })
after(async () => { await h?.close() })

async function members(orgId, { token = appToken(SECRET_KEY, 'captable'), query = '', site = 'apex', method = 'GET' } = {}) {
  const response = await h.client().request(h.url(site, `/__insulin/members${query}`), {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(orgId ? { 'x-suger-organization-id': orgId } : {}) },
  })
  let json = null
  try { json = JSON.parse(response.text) } catch { /* not JSON */ }
  return { ...response, json }
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

test("an app's token gets the organization's people who can use the app: by role, or given the app", async () => {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, 'Directory Org')
  const editor = await member(orgId, 'Eddie Editor', 'EDITOR')
  const viewer = await member(orgId, 'Vera Viewer', 'VIEWER')
  const given = await member(orgId, 'Abe App-Admin', 'APPS', { captable: 'ADMIN' })
  const elsewhere = await member(orgId, 'Lee Ledger-Only', 'APPS', { ledger: 'ADMIN' })
  const custom = await member(orgId, 'Cass Custom', 'APPS')
  await h.sql("INSERT INTO custom_roles (id, org_id, app, name, permissions, created_at, updated_at) VALUES ('role-reader', ?1, 'captable', 'Reader', '[\"captable.view\"]', 1, 1)", orgId)
  await h.sql("INSERT INTO app_grants (org_id, user_id, app, role, custom_role_id, created_at, updated_at) VALUES (?1, ?2, 'captable', 'CUSTOM', 'role-reader', 1, 1)", orgId, custom.id)
  const outsider = await h.user({ name: 'Otto Outsider' })

  const answer = await members(orgId)
  assert.equal(answer.status, 200, answer.text)
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  const listed = answer.json.members
  assert.deepEqual(listed.map((m) => m.email).sort(), [owner, editor, viewer, given, custom].map((p) => p.email).sort())
  assert.ok(!listed.some((m) => m.email === elsewhere.email), 'a specific-apps member without the app is not listed')
  assert.ok(!listed.some((m) => m.email === outsider.email), 'nor anyone outside the organization')
  assert.deepEqual(Object.keys(listed[0]).sort(), ['email', 'id', 'name', 'permissions', 'role'])
  assert.equal(listed.find((m) => m.email === editor.email).id, editor.id, 'the id their requests carry')
  // Their role and permissions in the app, as their requests carry them: what they may do there now.
  const access = (person) => { const m = listed.find((l) => l.email === person.email); return [m.role, m.permissions.join(' ')] }
  assert.deepEqual(access(owner), ['ADMIN', 'captable.manage captable.view portfolio.view'])
  assert.deepEqual(access(editor), ['EDITOR', 'captable.manage captable.view portfolio.view'])
  assert.deepEqual(access(viewer), ['VIEWER', 'portfolio.view'])
  assert.equal(access(given)[0], 'ADMIN', 'given the app as Admin')
  assert.deepEqual(access(custom), ['EDITOR', 'captable.view'], 'a custom role: its permissions only')
  // An account Insulin Apps suspended or disabled uses no app (DESIGN.md §11.3): it isn't listed.
  const paused = await member(orgId, 'Sid Suspended', 'EDITOR'), ended = await member(orgId, 'Dee Disabled', 'EDITOR')
  await h.sql("UPDATE users SET status = 'suspended' WHERE id = ?1", paused.id)
  await h.sql("UPDATE users SET status = 'disabled' WHERE id = ?1", ended.id)
  const now = (await members(orgId)).json.members.map((m) => m.email)
  assert.ok(!now.includes(paused.email) && !now.includes(ended.email), 'nobody suspended or disabled')
  assert.ok(now.includes(editor.email))
  // Narrowed by name or email, case-insensitively, and capped.
  assert.deepEqual((await members(orgId, { query: '?q=EDDIE' })).json.members.map((m) => m.email), [editor.email])
  assert.equal((await members(orgId, { query: '?limit=2' })).json.members.length, 2)
  // Another app's token: the people who can use that app.
  assert.deepEqual((await members(orgId, { token: appToken(SECRET_KEY, 'ledger') })).json.members.map((m) => m.email).sort(), [owner, editor, viewer, elsewhere].map((p) => p.email).sort())
})

test('refused: no token or a wrong one, no organization, a bad query, another host, another method; an unavailable organization', async () => {
  const owner = await h.user({ name: 'Rita Refused' })
  const orgId = await h.org(owner.client, 'Refusals Org')
  assert.equal((await members(orgId, { token: null })).status, 401)
  assert.equal((await members(orgId, { token: appToken(Buffer.alloc(32, 1).toString('base64'), 'captable') })).status, 401)
  assert.equal((await members(null)).status, 400)
  assert.equal((await members('not-an-id')).status, 400)
  for (const query of ['?limit=0', '?limit=501', `?q=${'x'.repeat(101)}`]) assert.equal((await members(orgId, { query })).status, 400, query)
  assert.equal((await members(orgId, { site: 'captable' })).status, 404, 'on the apex only')
  assert.equal((await members(orgId, { method: 'POST' })).status, 405)
  assert.equal((await members('00000000-0000-4000-8000-000000000000')).status, 404)
  await h.sql("UPDATE orgs SET status = 'suspended' WHERE id = ?1", orgId)
  assert.equal((await members(orgId)).status, 403)
})

test("one organization's lookups never use up another's", async () => {
  const limited = await startGateway({ appLimit: 2 })
  try {
    const ask = async (orgId) => (await limited.client().request(limited.url('apex', '/__insulin/members'), {
      headers: { Authorization: `Bearer ${appToken(SECRET_KEY, 'captable')}`, 'x-suger-organization-id': orgId },
    })).status
    const busy = await limited.user({ name: 'Busy Owner' }), quiet = await limited.user({ name: 'Quiet Owner' })
    const busyOrg = await limited.org(busy.client, 'Busy Org'), quietOrg = await limited.org(quiet.client, 'Quiet Org')
    assert.deepEqual([await ask(busyOrg), await ask(busyOrg), await ask(busyOrg)], [200, 200, 429], 'limited per organization')
    assert.equal(await ask(quietOrg), 200, 'another organization still asks')
  } finally { await limited.close() }
})
