// The organization's OAuth clients (DESIGN.md §5.4): /settings/oauth-clients lists every app's clients for API access and
// everyone's AI agents to the organization's owners and admins only, with who created each, when, and when it was last
// used, never with a secret; Revoke ends access at once and keeps the client listed, marked revoked; Delete removes it.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { startGateway } from './helpers/harness.mjs'
import { connect, form, rpc } from './helpers/oauth.mjs'
import {
  findGrant, issueServiceToken, listOrgGrantsAsAdmin, listOrgServiceAccountsAsAdmin, redeemCode, redeemRefresh, revokeOrgGrant, revokeOrgServiceAccount,
} from '../src/db/oauth.ts'

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

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

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

test('OAuth clients: each check refuses a revoked agent or client by itself, so rows left by a request racing the revoke do nothing', async () => {
  const owner = await h.user({ name: 'Iris Owner' })
  const orgId = await h.org(owner.client, 'Each Check Org')
  const admin = await member(orgId, 'Ines Admin', 'ADMIN')
  const editor = await member(orgId, 'Ike Editor', 'EDITOR')
  await connect(h, editor, orgId, { name: 'Leftover Agent' })
  const [grant] = await h.sql('SELECT id, client_id FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', editor.id, orgId)
  const client = await createClient(owner, orgId, 'Leftover client')
  assert.equal((await post(owner, orgId, `/agents/${grant.id}/revoke`)).status, 303)
  assert.equal((await post(owner, orgId, `/api/${client.id}/revoke`)).status, 303)

  // What a code exchange, a refresh or a token request that passed its check just before the revoke would insert.
  const now = Date.now()
  const later = now + 60 * 60 * 1000
  const [agentAccess, refresh, clientAccess] = ['ia_at_', 'ia_rt_', 'ia_at_'].map((prefix, index) => `${prefix}${String(index).repeat(43)}`)
  const code = `ia_ac_${'c'.repeat(43)}`
  await h.sql("INSERT INTO oauth_tokens (token_hash, kind, grant_id, created_at, expires_at) VALUES (?1, 'access', ?2, ?3, ?4)", sha256(agentAccess), grant.id, now, later)
  await h.sql("INSERT INTO oauth_tokens (token_hash, kind, grant_id, created_at, expires_at) VALUES (?1, 'refresh', ?2, ?3, ?4)", sha256(refresh), grant.id, now, later)
  await h.sql("INSERT INTO oauth_tokens (token_hash, kind, service_account_id, client_secret_hash, created_at, expires_at) VALUES (?1, 'access', ?2, ?3, ?4, ?5)", sha256(clientAccess), client.id, sha256(client.secret), now, later)
  await h.sql("INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, created_at, expires_at) VALUES (?1, ?2, 'http://127.0.0.1:8976/callback', 'x', ?3, ?4)", sha256(code), grant.id, now, later)

  assert.equal((await rpc(h, agentAccess, 'tools/list')).status, 401, 'the agent\'s token check')
  assert.equal((await api(clientAccess)).status, 401, 'the client\'s token check')
  assert.equal(await redeemRefresh(h.db, sha256(refresh), grant.client_id, Date.now()), null, 'the refresh')
  assert.equal(await redeemCode(h.db, sha256(code), grant.client_id, Date.now()), null, 'the code exchange')
  assert.equal(await findGrant(h.db, grant.id, Date.now()), null, 'the grant lookup')
  assert.equal(await issueServiceToken(h.db, { hash: sha256('ia_at_another'), serviceAccountId: client.id, secretHash: sha256(client.secret), now: Date.now(), expiresAt: later }), false, 'the token insert')

  // Nor does anything list, revoke again or rename what was revoked.
  assert.doesNotMatch((await editor.client.get(h.url('apex', `/apps/captable/settings/connect-ai?org=${orgId}`))).text, /Leftover Agent/, 'the person\'s own Connect AI')
  assert.equal((await post(admin, orgId, `/agents/${grant.id}/revoke`)).status, 409, 'a second revoke')
  assert.equal((await h.sql('SELECT revoked_by FROM oauth_grants WHERE id = ?1', grant.id))[0].revoked_by, owner.id, 'keeps who revoked it first')
  const renamed = await owner.client.post(h.url('apex', `/apps/captable/settings/api/clients/${client.id}`), { org_id: orgId, name: 'Renamed client', role: 'VIEWER' })
  assert.notEqual(renamed.status, 303, 'a rename')
  assert.deepEqual(await h.sql('SELECT name, role FROM service_accounts WHERE id = ?1', client.id), [{ name: 'Leftover client', role: 'EDITOR' }])
})

test('OAuth clients: the list says when each was created and last used, names a creator whose account is gone, and holds only this organization\'s', async () => {
  const owner = await h.user({ name: 'Uma Owner' })
  const orgId = await h.org(owner.client, 'Usage Org')
  const admin = await member(orgId, 'Udo Admin', 'ADMIN')
  const editor = await member(orgId, 'Ula Editor', 'EDITOR')
  const client = await createClient(admin, orgId, 'Usage client')
  const agent = await connect(h, editor, orgId, { name: 'Usage Agent' })
  const other = await h.user({ name: 'Otto Elsewhere' })
  const otherOrg = await h.org(other.client, 'Elsewhere Org')
  await createClient(other, otherOrg, 'Elsewhere client')
  await connect(h, other, otherOrg, { name: 'Elsewhere Agent' })
  // Made ten days earlier, so a page that showed one date for both "created" and "last used" can't pass.
  const earlier = Date.now() - 10 * 24 * 60 * 60 * 1000
  await h.sql('UPDATE service_accounts SET created_at = ?2 WHERE id = ?1', client.id, earlier)
  await h.sql('UPDATE oauth_grants SET created_at = ?3 WHERE user_id = ?1 AND org_id = ?2', editor.id, orgId, earlier)

  let html = (await page(owner, orgId)).text
  assert.match(rowOf(html, 'Usage client'), /last used Never/, 'not used yet')
  assert.doesNotMatch(html, /Elsewhere/, 'another organization\'s clients and agents aren\'t listed')

  const issued = await token(client, client.secret)
  assert.equal((await api(issued.json.access_token)).status, 200)
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 200)
  // Each use is stamped in the background, just after the response.
  const stamped = async () => (await h.sql('SELECT (SELECT last_used_at FROM service_accounts WHERE id = ?1) AS client, (SELECT last_used_at FROM oauth_grants WHERE user_id = ?2 AND org_id = ?3) AS agent', client.id, editor.id, orgId))[0]
  for (let attempt = 0; attempt < 100 && !((await stamped()).client && (await stamped()).agent); attempt += 1) await new Promise((accept) => setTimeout(accept, 30))
  const used = await stamped()
  const [created] = await h.sql('SELECT (SELECT created_at FROM service_accounts WHERE id = ?1) AS client, (SELECT created_at FROM oauth_grants WHERE user_id = ?2 AND org_id = ?3) AS agent', client.id, editor.id, orgId)
  assert.notEqual(day(created.client), day(used.client))
  assert.notEqual(day(created.agent), day(used.agent))
  html = (await page(owner, orgId)).text
  assert.match(rowOf(html, 'Usage client'), new RegExp(`created ${day(created.client)} By Udo Admin \\([^)]+\\) · last used ${day(used.client)} `))
  assert.match(rowOf(html, 'Usage Agent'), new RegExp(`created ${day(created.agent)} By Ula Editor \\([^)]+\\) · last used ${day(used.agent)} `))

  await h.sql('DELETE FROM users WHERE id = ?1', admin.id)
  assert.match(rowOf((await page(owner, orgId)).text, 'Usage client'), /By A deleted account/, 'its creator\'s account is gone')
})

test('OAuth clients: a revoked agent stays listed when its person disconnects it from an older page or changes their password', async () => {
  const owner = await h.user({ name: 'Rhea Owner' })
  const orgId = await h.org(owner.client, 'Kept Record Org')
  const editor = await member(orgId, 'Ravi Editor', 'EDITOR')
  await connect(h, editor, orgId, { name: 'Weekly Digest Agent' })
  const [grant] = await h.sql('SELECT id FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', editor.id, orgId)
  await connect(h, editor, orgId, { name: 'Live Agent' })
  assert.equal((await post(owner, orgId, `/agents/${grant.id}/revoke`)).status, 303)

  // Disconnect buttons on Account › AI agents and Connect AI, from pages opened before the revoke, reach nothing now.
  assert.equal((await editor.client.post(h.url('apex', `/account/agents/${grant.id}/disconnect`), {})).status, 404)
  assert.equal((await editor.client.post(h.url('apex', `/apps/captable/settings/connect-ai/agents/${grant.id}/disconnect`), { org_id: orgId })).status, 404)
  // A credential change ends the person's live agents, and leaves the revoked one's record.
  await h.sql('UPDATE users SET credential_version = credential_version + 1 WHERE id = ?1', editor.id)
  const left = await h.sql('SELECT id, revoked_at FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', editor.id, orgId)
  assert.deepEqual(left.map((row) => row.id), [grant.id], 'only the revoked record is left')
  assert.ok(left[0].revoked_at > 0)
  assert.match(rowOf((await page(owner, orgId)).text, 'Weekly Digest Agent'), /Revoked \d{4}-\d{2}-\d{2} by Rhea Owner/)
})

test('OAuth clients: below 1280px each row keeps its status and actions in view: only the client cell and the actions show, and the client cell carries the rest', async () => {
  const owner = await h.user({ name: 'Nina Owner' })
  const orgId = await h.org(owner.client, 'Narrow Screens Org')
  const editor = await member(orgId, 'Ned Editor', 'EDITOR')
  const narrow = await createClient(owner, orgId, 'Narrowscreenclientwithaverylongnamewithoutanyspaces')
  // Its role is a custom one whose name is 60 characters without a space, the longest a role's name may be.
  const roleName = 'Quarterlyfinancereportingexportreadonlyroleforauditorsabcdef'
  assert.equal(roleName.length, 60)
  await h.sql("INSERT INTO custom_roles (id, org_id, app, name, permissions, created_at, updated_at) VALUES ('narrow-role', ?1, 'captable', ?2, '[\"captable.view\"]', 1, 1)", orgId, roleName)
  await h.sql("UPDATE service_accounts SET role = 'CUSTOM', custom_role_id = 'narrow-role' WHERE id = ?1", narrow.id)
  await connect(h, editor, orgId, { name: 'Narrow Agent' })
  const html = (await page(owner, orgId)).text
  const classes = (tag) => /class="([^"]*)"/.exec(tag)?.[1].split(/\s+/) ?? []
  // The columns: Client always; Type, Created by, Last used and Status from xl (1280px) only; the actions from sm
  // (640px), since on a phone they move into the client cell.
  const hides = (tag) => ({ belowXl: classes(tag).includes('max-xl:hidden'), belowSm: classes(tag).includes('max-sm:hidden') })
  const heads = [...html.matchAll(/<th [^>]*>[\s\S]*?<\/th>/g)].map((match) => ({ text: match[0].replace(/<[^>]+>/g, '').trim(), ...hides(match[0]) }))
  const always = { belowXl: false, belowSm: false }, fromXl = { belowXl: true, belowSm: false }, fromSm = { belowXl: false, belowSm: true }
  assert.deepEqual(heads, [
    { text: 'Client', ...always }, { text: 'Type', ...fromXl }, { text: 'Created by', ...fromXl },
    { text: 'Last used', ...fromXl }, { text: 'Status', ...fromXl }, { text: 'Actions', ...fromSm },
  ])
  const rows = html.split('<tbody')[1].split('<tr').slice(1)
  assert.equal(rows.length, 2)
  assert.ok(html.includes(`Cap Table · ${roleName} · created`), 'the client shows its custom role')
  const forms = (html) => [...html.matchAll(/<form [^>]*action="([^"]+)"/g)].map((match) => match[1])
  for (const row of rows) {
    const cells = [...row.matchAll(/<td [^>]*>/g)].map((match) => hides(match[0]))
    assert.deepEqual(cells, [always, fromXl, fromXl, fromXl, fromXl, fromSm], 'the same columns hide in every row')
    const [first, , , , , actions] = [...row.matchAll(/<td [^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1])
    // Below xl the first cell says what the hidden columns say.
    const narrow = /<div class="[^"]*\bxl:hidden\b[^"]*">([\s\S]*?)<\/div><\/div>/.exec(first)?.[1] ?? ''
    const text = first.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, /By (Nina Owner|Ned Editor) \([^)]+\) · last used (Never|\d{4}-\d{2}-\d{2})/, 'creator and last use')
    assert.match(narrow, /API access|AI agent \(MCP\)/, 'the type')
    assert.match(narrow, />Active</, 'the status')
    // Its badges may wrap, so large text can't widen the table with them.
    assert.match(first, /<div class="[^"]*\[&amp;_\[data-slot=badge\]\]:whitespace-normal[^"]*\bxl:hidden\b/, 'the folded badges wrap')
    // Below sm it also holds the row's Revoke and Delete, the same forms as the actions column.
    const phone = /<div class="[^"]*\bsm:hidden\b[^"]*">([\s\S]*?)<\/div>/.exec(first)?.[1] ?? ''
    assert.equal(forms(actions).length, 2, 'Revoke and Delete')
    assert.deepEqual(forms(phone), forms(actions), 'the actions, folded into the client cell on a phone')
    // A long name, role or address can't widen the table: it wraps anywhere.
    assert.match(first, /<div class="[^"]*\[overflow-wrap:anywhere\][^"]*">Narrow/, 'the name wraps anywhere')
    assert.match(first, /<div class="[^"]*\[overflow-wrap:anywhere\][^"]*">Cap Table[^<]* · created /, 'the app and role wrap anywhere')
  }
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
