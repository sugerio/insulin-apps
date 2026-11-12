// The organization's OAuth clients (DESIGN.md §5.4): /settings/oauth-clients lists every app's clients for API access and
// everyone's AI agents to the organization's owners and admins only, with who created each, when, and when it was last
// used, never with a secret; Revoke ends access at once and keeps the client listed, marked revoked; Delete removes it.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './helpers/harness.mjs'
import { connect, form, rpc } from './helpers/oauth.mjs'
import { listOrgGrantsAsAdmin, listOrgServiceAccountsAsAdmin, revokeOrgGrant, revokeOrgServiceAccount } from '../src/db/oauth.ts'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const SECRET = /(ia_sk_[A-Za-z0-9_-]{43})/
const CLIENT_ID = /(ia_sa_[A-Za-z0-9_-]{22})/
const page = (person, orgId) => person.client.get(h.url('apex', `/settings/oauth-clients${orgId ? `?org=${orgId}` : ''}`))
const post = (person, orgId, path) => person.client.post(h.url('apex', `/orgs/${orgId}/oauth-clients${path}`), {})

async function member(orgId, name, role, grants = {}) {
  const person = await h.user({ name })
  const now = Date.now()
  await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  for (const [app, grant] of Object.entries(grants)) {
    await h.sql('INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)', orgId, person.id, app, grant, now)
  }
  return person
}

/** An OAuth client for API access, created as `person` on Cap Table's API access page; its secret is shown there once. */
async function createClient(person, orgId, name) {
  const created = await person.client.post(h.url('apex', '/apps/captable/settings/api/clients'), { org_id: orgId, name, role: 'EDITOR' })
  assert.equal(created.status, 200, created.text.slice(0, 400))
  const clientId = CLIENT_ID.exec(created.text)?.[1]
  const secret = SECRET.exec(created.text)?.[1]
  const [row] = await h.sql('SELECT id FROM service_accounts WHERE client_id = ?1', clientId)
  return { id: row.id, clientId, secret }
}

function token({ clientId }, secret) {
  return form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'client_credentials', resource: h.url('captable').replace(/\/$/, '') }, {
    Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
  })
}

const api = (accessToken) => h.client().request(h.url('captable', '/api/echo'), { headers: { Authorization: `Bearer ${accessToken}` } })

/** The table row naming `text` (a client's or an agent's name), as one line of the page's text. */
function rowOf(html, text) {
  const rows = html.split('<tr').filter((row) => row.includes(text))
  assert.equal(rows.length, 1, `exactly one row names ${text}`)
  return rows[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

test('OAuth clients: only owners and admins open the page and see it in the navigation; nobody sees a secret there', async () => {
  const owner = await h.user({ name: 'Olga Owner' })
  const orgId = await h.org(owner.client, 'Clients Org')
  const admin = await member(orgId, 'Adam Admin', 'ADMIN')
  const editor = await member(orgId, 'Edna Editor', 'EDITOR')
  const viewer = await member(orgId, 'Vic Viewer', 'VIEWER')
  const appAdmin = await member(orgId, 'Abby App-Admin', 'APPS', { captable: 'ADMIN' })
  const outsider = await h.user({ name: 'Otto Outsider' })
  await h.org(outsider.client, 'Elsewhere Org')

  const client = await createClient(owner, orgId, 'Nightly export')
  await connect(h, editor, orgId, { name: 'Claude Code' })

  for (const [who, person] of [['owner', owner], ['admin', admin]]) {
    const shown = await page(person, orgId)
    assert.equal(shown.status, 200, `${who}: ${shown.text.slice(0, 300)}`)
    assert.match(shown.text, /<h2>OAuth clients<\/h2>/)
    assert.match(shown.text, new RegExp(`href="[^"]*/settings/oauth-clients\\?org=${orgId}"[^>]*aria-current="page"`), `${who}: the navigation's OAuth clients item is current`)
    const apiRow = rowOf(shown.text, 'Nightly export')
    assert.match(apiRow, /API access/)
    assert.match(apiRow, new RegExp(client.clientId))
    assert.match(apiRow, /Cap Table · Editor/)
    assert.match(apiRow, /Olga Owner \(olga-owner-[^)]*\)|Olga Owner/, 'who created it')
    assert.match(apiRow, /Active/)
    const agentRow = rowOf(shown.text, 'Claude Code')
    assert.match(agentRow, /AI agent \(MCP\)/)
    assert.match(agentRow, /Edna Editor/, 'who connected it')
    assert.match(agentRow, /Until \d{4}-\d{2}-\d{2}/, 'when the agent\'s grant ends')
    assert.ok(!SECRET.test(shown.text), `${who}: no secret on the page`)
    assert.ok(!shown.text.includes(client.secret), `${who}: not the client's secret`)
    assert.doesNotMatch(shown.text, /Rotate/, `${who}: no rotation here`)
    assert.doesNotMatch(shown.text, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/)
  }
  for (const [who, person] of [['editor', editor], ['viewer', viewer], ['app admin', appAdmin]]) {
    const refused = await page(person, orgId)
    assert.equal(refused.status, 403, `${who}: not allowed`)
    const home = await person.client.get(h.url('apex', `/settings/users?org=${orgId}`))
    assert.doesNotMatch(home.text, /settings\/oauth-clients/, `${who}: no OAuth clients item in the navigation`)
  }
  assert.equal((await page(outsider, orgId)).status, 404, 'another organization\'s member: as if it didn\'t exist')
  const signedOut = await h.client().get(h.url('apex', '/settings/oauth-clients'))
  assert.equal(signedOut.status, 302, 'signed out: sign in first')
  assert.match(signedOut.headers.get('location') ?? '', /\/login/)
})

test('OAuth clients: revoking a client for API access ends its secrets and tokens at once, keeps it listed as revoked, and Delete removes it', async () => {
  const owner = await h.user({ name: 'Rita Owner' })
  const orgId = await h.org(owner.client, 'Revoke Clients Org')
  const admin = await member(orgId, 'Raj Admin', 'ADMIN')
  const client = await createClient(owner, orgId, 'Billing sync')
  const issued = await token(client, client.secret)
  assert.equal(issued.status, 200, issued.text)
  const access = issued.json.access_token
  assert.equal((await api(access)).status, 200, 'the token works before')

  const revoked = await post(admin, orgId, `/api/${client.id}/revoke`)
  assert.equal(revoked.status, 303)
  assert.match(revoked.headers.get('location') ?? '', new RegExp(`/settings/oauth-clients\\?org=${orgId}&notice=client-revoked`))
  const shown = await admin.client.get(new URL(revoked.headers.get('location'), h.url('apex')).href)
  assert.match(shown.text, /The OAuth client was revoked: it gets no token again/)
  const row = rowOf(shown.text, 'Billing sync')
  assert.match(row, /Revoked \d{4}-\d{2}-\d{2} by Raj Admin/, 'who revoked it and when')
  assert.doesNotMatch(row, />\s*Revoke\s*</, 'no Revoke on a revoked client')
  const [stored] = await h.sql('SELECT revoked_at, revoked_by FROM service_accounts WHERE id = ?1', client.id)
  assert.ok(stored.revoked_at > 0)
  assert.equal(stored.revoked_by, admin.id)

  assert.equal((await api(access)).status, 401, 'its token ends at once')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_tokens WHERE service_account_id = ?1', client.id))[0].n, 0, 'and is deleted')
  const again = await token(client, client.secret)
  assert.equal(again.status, 401, 'its secret gets no new token')
  assert.equal(again.json.error, 'invalid_client')

  // The app's API access page says so, and offers no rename or rotation; those are refused anyway.
  const apiPage = await owner.client.get(h.url('apex', '/apps/captable/settings/api'))
  assert.match(apiPage.text, /Revoked/)
  assert.doesNotMatch(apiPage.text, new RegExp(`/clients/${client.id}/rotate`))
  assert.doesNotMatch(apiPage.text, new RegExp(`action="/apps/captable/settings/api/clients/${client.id}"`))
  const rotate = await owner.client.post(h.url('apex', `/apps/captable/settings/api/clients/${client.id}/rotate`), { org_id: orgId })
  assert.ok(!SECRET.test(rotate.text), 'a revoked client gets no new secret')
  assert.equal((await token(client, client.secret)).status, 401, 'and still no token')

  // Revoking again changes nothing; Delete takes it off the list.
  const twice = await post(owner, orgId, `/api/${client.id}/revoke`)
  assert.equal(twice.status, 409)
  const deleted = await post(owner, orgId, `/api/${client.id}/delete`)
  assert.equal(deleted.status, 303)
  assert.match(deleted.headers.get('location') ?? '', /notice=client-deleted/)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM service_accounts WHERE id = ?1', client.id))[0].n, 0)
  assert.doesNotMatch((await page(owner, orgId)).text, /Billing sync/)
})

test('OAuth clients: revoking an AI agent ends its grant\'s tokens and refresh at once and keeps it listed; Delete removes it', async () => {
  const owner = await h.user({ name: 'Gina Owner' })
  const orgId = await h.org(owner.client, 'Revoke Agents Org')
  const editor = await member(orgId, 'Gus Editor', 'EDITOR')
  const agent = await connect(h, editor, orgId, { name: 'Nightly Report Agent' })
  const listed = await rpc(h, agent.access_token, 'tools/list')
  assert.equal(listed.status, 200, 'the agent works before')
  const [grant] = await h.sql('SELECT id FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', editor.id, orgId)

  const revoked = await post(owner, orgId, `/agents/${grant.id}/revoke`)
  assert.equal(revoked.status, 303)
  assert.match(revoked.headers.get('location') ?? '', /notice=agent-revoked/)
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 401, 'its access token ends at once')
  const refreshed = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: agent.refresh_token, client_id: agent.client.client_id })
  assert.equal(refreshed.status, 400, refreshed.text)
  assert.equal(refreshed.json.error, 'invalid_grant', 'its refresh token gets nothing')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_tokens WHERE grant_id = ?1', grant.id))[0].n, 0)

  const row = rowOf((await page(owner, orgId)).text, 'Nightly Report Agent')
  assert.match(row, /Revoked \d{4}-\d{2}-\d{2} by Gina Owner/)
  // The person's own lists and Connect AI show live agents only.
  assert.doesNotMatch((await editor.client.get(h.url('apex', '/account/agents'))).text, /Nightly Report Agent/)
  assert.doesNotMatch((await owner.client.get(h.url('apex', '/apps/captable/settings/connect-ai'))).text, /Nightly Report Agent/)

  // The person can allow an agent again: a new grant, which works.
  const reconnected = await connect(h, editor, orgId, { name: 'Nightly Report Agent' })
  assert.equal((await rpc(h, reconnected.access_token, 'tools/list')).status, 200)

  const deleted = await post(owner, orgId, `/agents/${grant.id}/delete`)
  assert.equal(deleted.status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE id = ?1', grant.id))[0].n, 0)
  assert.equal((await rpc(h, reconnected.access_token, 'tools/list')).status, 200, 'deleting the revoked one leaves the new one alone')
})

test('OAuth clients: only owners and admins revoke or delete, only in their own organization, and each write re-checks the role', async () => {
  const owner = await h.user({ name: 'Petra Owner' })
  const orgId = await h.org(owner.client, 'Guarded Clients Org')
  const admin = await member(orgId, 'Pat Admin', 'ADMIN')
  const editor = await member(orgId, 'Perry Editor', 'EDITOR')
  const client = await createClient(owner, orgId, 'Guarded client')
  const agent = await connect(h, editor, orgId, { name: 'Guarded agent' })
  const [grant] = await h.sql('SELECT id FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', editor.id, orgId)
  const other = await h.user({ name: 'Quinn Other-Owner' })
  const otherOrg = await h.org(other.client, 'Other Clients Org')
  const theirs = await createClient(other, otherOrg, 'Their client')

  for (const path of [`/api/${client.id}/revoke`, `/api/${client.id}/delete`, `/agents/${grant.id}/revoke`, `/agents/${grant.id}/delete`]) {
    assert.equal((await post(editor, orgId, path)).status, 403, `an editor: ${path}`)
  }
  assert.equal((await post(other, orgId, `/api/${client.id}/revoke`)).status, 404, 'a non-member: as if the organization didn\'t exist')
  // Another organization's client through this organization's address changes nothing, and reads as already gone.
  assert.equal((await post(owner, orgId, `/api/${theirs.id}/revoke`)).status, 409)
  assert.equal((await post(owner, orgId, `/api/${theirs.id}/delete`)).status, 409)
  assert.equal((await token(theirs, theirs.secret)).status, 200, 'their client still works')
  assert.equal((await token(client, client.secret)).status, 200, 'ours too')
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 200, 'and the agent')

  // An admin demoted between the page and the write: the statement's own check refuses, and the page says what changed.
  await h.sql("UPDATE memberships SET role = 'EDITOR' WHERE org_id = ?1 AND user_id = ?2", orgId, admin.id)
  const demoted = await post(admin, orgId, `/api/${client.id}/revoke`)
  assert.equal(demoted.status, 403)
  const now = Date.now()
  assert.equal(await revokeOrgServiceAccount(h.db, { id: client.id, orgId, actorId: admin.id, now }), false, 'the statement checks the role itself')
  assert.equal(await revokeOrgGrant(h.db, { id: grant.id, orgId, actorId: admin.id, now }), false)
  assert.deepEqual(await listOrgServiceAccountsAsAdmin(h.db, { orgId, actorId: admin.id }), [], 'and lists nothing to a non-admin')
  assert.deepEqual(await listOrgGrantsAsAdmin(h.db, { orgId, actorId: admin.id, now }), [])
  assert.equal((await token(client, client.secret)).status, 200, 'nothing was revoked')
})
