// An app's API access page (DESIGN.md §5.3): OAuth clients (client credentials, stored as service accounts) that only
// the organization's owners and admins manage and everyone who can use the app sees, never with a secret; and secret
// rotation with a 24-hour overlap, "Revoke previous secret now", and which tokens each ends.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { startGateway } from './helpers/harness.mjs'
import { form } from './helpers/oauth.mjs'
import {
  deleteServiceAccount, insertServiceAccount, issueServiceToken, revokePreviousSecret, rotateServiceAccount, updateServiceAccount,
} from '../src/db/oauth.ts'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const SECRET = /(ia_sk_[A-Za-z0-9_-]{43})/
const CLIENT_ID = /(ia_sa_[A-Za-z0-9_-]{22})/
const DAY_MS = 24 * 60 * 60 * 1000
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const apiPage = (person) => person.client.get(h.url('apex', '/apps/captable/settings/api'))
const post = (person, path, fields) => person.client.post(h.url('apex', `/apps/captable/settings/api${path}`), fields)

/**
 * Adds a signed-up user to the organization directly, with an organization role or specific apps (`grants`:
 * { captable: 'ADMIN' }); the invitation flow has its own tests.
 */
async function add(orgId, person, role, grants = {}) {
  const now = Date.now()
  await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  for (const [app, grant] of Object.entries(grants)) {
    await h.sql('INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)', orgId, person.id, app, grant, now)
  }
}

async function member(orgId, name, role, grants) {
  const person = await h.user({ name })
  await add(orgId, person, role, grants)
  return person
}

/** Creates an OAuth client as `person`; returns its id, client id and the secret shown once. */
async function createClient(person, orgId, name, role = 'EDITOR') {
  const created = await post(person, '/clients', { org_id: orgId, name, role })
  assert.equal(created.status, 200, created.text.slice(0, 400))
  const clientId = CLIENT_ID.exec(created.text)?.[1]
  const secret = SECRET.exec(created.text)?.[1]
  assert.ok(clientId && secret, 'the page shows the client id and secret once')
  const [row] = await h.sql('SELECT id FROM service_accounts WHERE client_id = ?1', clientId)
  return { id: row.id, clientId, secret, page: created.text }
}

/** Rotates a client's secret as `person`; returns the new secret and the page. */
async function rotate(person, orgId, client) {
  const rotated = await post(person, `/clients/${client.id}/rotate`, { org_id: orgId })
  assert.equal(rotated.status, 200, rotated.text.slice(0, 400))
  const secret = SECRET.exec(rotated.text)?.[1]
  assert.ok(secret, 'the new secret is shown once')
  return { secret, page: rotated.text }
}

function token({ clientId }, secret) {
  return form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'client_credentials', resource: h.url('captable').replace(/\/$/, '') }, {
    Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
  })
}

async function accessToken(client, secret) {
  const response = await token(client, secret)
  assert.equal(response.status, 200, response.text)
  return response.json.access_token
}

const api = (accessTokenValue) => h.client().request(h.url('captable', '/api/echo'), { headers: { Authorization: `Bearer ${accessTokenValue}` } })

async function row(id) {
  const [found] = await h.sql('SELECT name, role, secret_hash, previous_secret_hash, previous_secret_expires_at, secret_rotated_at FROM service_accounts WHERE id = ?1', id)
  return found ?? null
}

test('API access: everyone who can use the app sees the OAuth clients without secrets; only owners and admins manage them', async () => {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, 'API Access Org')
  const admin = await member(orgId, 'Ada Admin', 'ADMIN')
  const editor = await member(orgId, 'Eddie Editor', 'EDITOR')
  const viewer = await member(orgId, 'Vera Viewer', 'VIEWER')
  const appAdmin = await member(orgId, 'Abe App-Admin', 'APPS', { captable: 'ADMIN' })
  const appViewer = await member(orgId, 'Val App-Viewer', 'APPS', { captable: 'VIEWER' })
  const ledgerOnly = await member(orgId, 'Lee Ledger-Only', 'APPS', { ledger: 'ADMIN' })

  const nightly = await createClient(owner, orgId, 'Nightly export', 'EDITOR')
  assert.match(nightly.page, /copy the secret now/)
  const board = await createClient(admin, orgId, 'Board sync', 'VIEWER')
  const stored = await row(nightly.id)

  for (const person of [owner, admin, editor, viewer, appAdmin, appViewer]) {
    const page = await apiPage(person)
    assert.equal(page.status, 200, person.name)
    assert.match(page.text, /<h2>OAuth clients<\/h2>/, person.name)
    for (const shown of ['Nightly export', 'Board sync', nightly.clientId, board.clientId, 'Not rotated']) assert.ok(page.text.includes(shown), `${person.name}: ${shown}`)
    assert.ok(!SECRET.test(page.text), `${person.name}: no secret on the list`)
    assert.ok(!page.text.includes(stored.secret_hash), `${person.name}: nor a secret's hash`)
    assert.match(page.text, /aria-current="page"[^>]*>API access<\/a>/, `${person.name}: the API access tab`)
    // How a program gets a token and calls the API, with placeholder credentials.
    assert.ok(page.text.includes('http://insulinapps.localhost/oauth/token'), person.name)
    assert.ok(page.text.includes('grant_type=client_credentials'), person.name)
    assert.ok(page.text.includes('resource=http://captable.insulinapps.localhost'), person.name)
    assert.ok(page.text.includes('&lt;client_id&gt;:&lt;client_secret&gt;'), person.name)
    assert.ok(page.text.includes('http://captable.insulinapps.localhost/api/catalog'), person.name)
    assert.equal(page.text.match(/<h1[\s>]/g)?.length, 1)
    assert.doesNotMatch(page.text, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/)
    const manages = person === owner || person === admin
    assert.equal(/New OAuth client/.test(page.text), manages, `${person.name}: the create form`)
    assert.equal(/>Rotate secret<span class="sr-only">/.test(page.text), manages, `${person.name}: the rotate button`)
    assert.equal(/>Delete<span class="sr-only">/.test(page.text), manages, `${person.name}: the delete button`)
    assert.equal(/Only the owners and admins of API Access Org/.test(page.text), !manages, `${person.name}: the notice`)
  }
  assert.equal((await apiPage(ledgerOnly)).status, 403, 'someone without the app sees nothing')

  // A specific-apps Admin of the app, an Editor and a specific-apps Viewer change nothing (403).
  for (const person of [appAdmin, editor, appViewer]) {
    assert.equal((await post(person, '/clients', { org_id: orgId, name: 'Sneaky', role: 'ADMIN' })).status, 403, `${person.name}: create`)
    assert.equal((await post(person, `/clients/${nightly.id}`, { org_id: orgId, name: 'Renamed', role: 'ADMIN' })).status, 403, `${person.name}: edit`)
    assert.equal((await post(person, `/clients/${nightly.id}/rotate`, { org_id: orgId })).status, 403, `${person.name}: rotate`)
    assert.equal((await post(person, `/clients/${nightly.id}/revoke-previous`, { org_id: orgId })).status, 403, `${person.name}: revoke previous`)
    assert.equal((await post(person, `/clients/${nightly.id}/delete`, { org_id: orgId })).status, 403, `${person.name}: delete`)
  }
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM service_accounts WHERE org_id = ?1', orgId))[0].n, 2)
  assert.deepEqual(await row(nightly.id), stored, 'nothing changed')

  // An Owner and an Admin can.
  assert.equal((await post(admin, `/clients/${nightly.id}`, { org_id: orgId, name: 'Nightly export v2', role: 'VIEWER' })).status, 303)
  assert.deepEqual([(await row(nightly.id)).name, (await row(nightly.id)).role], ['Nightly export v2', 'VIEWER'])
  const byAdmin = await rotate(admin, orgId, nightly)
  assert.notEqual(byAdmin.secret, nightly.secret)
  const byOwner = await rotate(owner, orgId, board)
  assert.notEqual(byOwner.secret, board.secret)
  const listed = await apiPage(viewer)
  assert.match(listed.text, new RegExp(`Rotated ${new Date().toISOString().slice(0, 10)}`), 'when the secret was rotated')
  assert.ok(!listed.text.includes(byAdmin.secret) && !listed.text.includes(byOwner.secret), 'never a secret')
  assert.equal((await post(owner, `/clients/${board.id}/delete`, { org_id: orgId })).status, 303)
  assert.equal(await row(board.id), null)
})

test('rotation: both secrets work for 24 hours, then only the new one; revoking the previous ends it and its tokens; a second rotation replaces it', async () => {
  const owner = await h.user({ name: 'Rita Rotator' })
  const orgId = await h.org(owner.client, 'Rotation Org')
  const client = await createClient(owner, orgId, 'Payroll sync')
  const first = client.secret
  const tokenFirst = await accessToken(client, first)

  // Rotate: the new secret is shown once, and the previous keeps working for 24 hours.
  const { secret: second, page } = await rotate(owner, orgId, client)
  assert.match(page, /The previous secret keeps working until/)
  let stored = await row(client.id)
  assert.equal(stored.secret_hash, sha256(second))
  assert.equal(stored.previous_secret_hash, sha256(first))
  assert.ok(Math.abs(stored.previous_secret_expires_at - (Date.now() + DAY_MS)) < 60_000, 'valid for 24 hours')
  assert.equal((await api(tokenFirst)).status, 200, 'a token already issued keeps working')
  const tokenFirstAgain = await accessToken(client, first)
  const tokenSecond = await accessToken(client, second)
  const recorded = await h.sql('SELECT token_hash, client_secret_hash FROM oauth_tokens WHERE service_account_id = ?1', client.id)
  assert.equal(recorded.find((entry) => entry.token_hash === sha256(tokenFirstAgain)).client_secret_hash, sha256(first), 'each token records its secret')
  assert.equal(recorded.find((entry) => entry.token_hash === sha256(tokenSecond)).client_secret_hash, sha256(second))
  const listed = (await apiPage(owner)).text
  assert.match(listed, /The previous secret works until/)
  assert.match(listed, /Revoke previous secret now/)

  // 24 hours later the previous secret stops; tokens it issued run out on their own.
  await h.sql('UPDATE service_accounts SET previous_secret_expires_at = ?2 WHERE id = ?1', client.id, Date.now() - 1)
  const expired = await token(client, first)
  assert.equal(expired.status, 401)
  assert.equal(expired.json.error, 'invalid_client')
  assert.equal((await token(client, second)).status, 200)
  assert.equal((await api(tokenFirstAgain)).status, 200, 'its tokens last their hour')
  assert.doesNotMatch((await apiPage(owner)).text, /Revoke previous secret now/)

  // Rotating again: the second becomes the previous; the first is pushed out with its tokens.
  const { secret: third } = await rotate(owner, orgId, client)
  assert.equal((await token(client, second)).status, 200, 'the second is now the previous, still valid')
  assert.equal((await token(client, third)).status, 200)
  assert.equal((await token(client, first)).status, 401)
  assert.equal((await api(tokenFirst)).status, 401, "the pushed-out secret's tokens end")
  assert.equal((await api(tokenFirstAgain)).status, 401)
  assert.equal((await api(tokenSecond)).status, 200, "the previous secret's tokens keep working")

  // Rotating while the previous is still valid replaces it: at most two secrets ever work.
  const tokenThird = await accessToken(client, third)
  const { secret: fourth, page: replacing } = await rotate(owner, orgId, client)
  assert.match(replacing, /The secret before it stopped working now/)
  assert.equal((await token(client, second)).status, 401, 'the replaced previous secret stops at once')
  assert.equal((await api(tokenSecond)).status, 401, 'with its tokens')
  assert.equal((await token(client, third)).status, 200)
  assert.equal((await token(client, fourth)).status, 200)
  stored = await row(client.id)
  assert.deepEqual([stored.secret_hash, stored.previous_secret_hash], [sha256(fourth), sha256(third)])

  // Revoke previous secret now: the third and its tokens end at once; the fourth's tokens don't.
  const tokenThirdAgain = await accessToken(client, third)
  const tokenFourth = await accessToken(client, fourth)
  const revoked = await post(owner, `/clients/${client.id}/revoke-previous`, { org_id: orgId })
  assert.equal(revoked.status, 303)
  assert.equal(revoked.location, '/apps/captable/settings/api?notice=previous-revoked')
  assert.equal((await token(client, third)).status, 401)
  assert.equal((await api(tokenThird)).status, 401)
  assert.equal((await api(tokenThirdAgain)).status, 401)
  assert.equal((await api(tokenFourth)).status, 200, "the current secret's tokens keep working")
  assert.equal((await token(client, fourth)).status, 200)
  stored = await row(client.id)
  assert.deepEqual([stored.previous_secret_hash, stored.previous_secret_expires_at], [null, null])
  assert.equal((await post(owner, `/clients/${client.id}/revoke-previous`, { org_id: orgId })).location, '/apps/captable/settings/api?notice=no-previous')

  // Delete ends the client and every token at once.
  assert.equal((await post(owner, `/clients/${client.id}/delete`, { org_id: orgId })).status, 303)
  assert.equal((await api(tokenFourth)).status, 401)
  assert.equal((await token(client, fourth)).status, 401)
  assert.ok(!h.logText().includes(first) && !h.logText().includes(fourth), 'logs never carry a secret')
})

test('tokens issued before migration 0008 recorded no secret: they count as the previous secret\'s', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Legacy Token Org')
  const client = await createClient(owner, orgId, 'Legacy job')
  const legacy = await accessToken(client, client.secret)
  await h.sql('UPDATE oauth_tokens SET client_secret_hash = NULL WHERE token_hash = ?1', sha256(legacy))
  const { secret } = await rotate(owner, orgId, client)
  assert.equal((await api(legacy)).status, 200, 'a rotation leaves it working')
  const current = await accessToken(client, secret)
  assert.equal((await post(owner, `/clients/${client.id}/revoke-previous`, { org_id: orgId })).status, 303)
  assert.equal((await api(legacy)).status, 401, 'revoking the previous secret ends it')
  assert.equal((await api(current)).status, 200)
})

test('the SQL guards: a demoted admin, or an app admin by grant, writes nothing, and a revoked secret issues no token', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Guarded Clients Org')
  const admin = await member(orgId, 'Dee Demoted', 'ADMIN')
  const appAdmin = await member(orgId, 'Gus Grant-Admin', 'APPS', { captable: 'ADMIN' })
  const client = await createClient(admin, orgId, 'Guarded job')
  await rotate(owner, orgId, client)
  const before = await row(client.id)
  await h.sql("UPDATE memberships SET role = 'EDITOR' WHERE org_id = ?1 AND user_id = ?2", orgId, admin.id)
  const now = Date.now()
  for (const actor of [admin, appAdmin]) {
    const base = { id: client.id, orgId, app: 'captable', actorId: actor.id, now }
    assert.equal(await insertServiceAccount(h.db, { ...base, id: crypto.randomUUID(), name: 'Smuggled', grant: { app: 'captable', role: 'ADMIN', customRoleId: null }, clientId: `ia_sa_${'S'.repeat(22)}`, secretHash: sha256('x') }), false, `${actor.name}: insert`)
    assert.equal(await updateServiceAccount(h.db, { ...base, name: 'Renamed', grant: { app: 'captable', role: 'ADMIN', customRoleId: null } }), false, `${actor.name}: update`)
    assert.equal(await rotateServiceAccount(h.db, { ...base, secretHash: sha256('y'), previousExpiresAt: now + DAY_MS }), false, `${actor.name}: rotate`)
    assert.equal(await revokePreviousSecret(h.db, base), false, `${actor.name}: revoke previous`)
    assert.equal(await deleteServiceAccount(h.db, base), false, `${actor.name}: delete`)
  }
  assert.deepEqual(await row(client.id), before, 'nothing changed')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM service_accounts WHERE org_id = ?1', orgId))[0].n, 1)
  assert.equal((await post(admin, `/clients/${client.id}/rotate`, { org_id: orgId })).status, 403, 'and the page refuses the demoted admin')

  // The token insert checks the secret again: one revoked between the check and the insert issues nothing.
  const issue = (secretHash) => issueServiceToken(h.db, { hash: sha256(crypto.randomUUID()), serviceAccountId: client.id, secretHash, now: Date.now(), expiresAt: Date.now() + 60_000 })
  assert.equal(await issue(before.previous_secret_hash), true, 'the previous secret, while valid')
  assert.equal(await revokePreviousSecret(h.db, { id: client.id, orgId, app: 'captable', actorId: owner.id, now: Date.now() }), true)
  assert.equal(await issue(before.previous_secret_hash), false, 'not once it is revoked')
  assert.equal(await issue(before.secret_hash), true, 'the current one still')
})
