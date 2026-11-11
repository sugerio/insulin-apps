// The OAuth authorization server (DESIGN.md §5.2): metadata, registration rules, consent, codes with PKCE, rotating
// refresh tokens, revocation, and Account → AI agents.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, startGateway } from './helpers/harness.mjs'
import { LOOPBACK, authorizeUrl, connect, decide, form, json, openConsent, pkce, registerClient, rpc } from './helpers/oauth.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

async function owner(name = 'OAuth Org') {
  const person = await h.user({ name: 'Agent Owner' })
  const orgId = await h.org(person.client, name)
  return { ...person, orgId }
}

test('metadata: the apex is the authorization server, and every app host describes its MCP resource', async () => {
  const apex = await h.client().get(h.url('apex', '/.well-known/oauth-authorization-server'))
  assert.equal(apex.status, 200)
  assert.equal(apex.headers.get('access-control-allow-origin'), '*')
  const metadata = JSON.parse(apex.text)
  assert.equal(metadata.issuer, 'http://insulinapps.localhost')
  assert.equal(metadata.token_endpoint, 'http://insulinapps.localhost/oauth/token')
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(JSON.parse((await h.client().get(h.url('captable', '/.well-known/oauth-authorization-server'))).text), metadata, 'the same on app hosts')
  const resource = JSON.parse((await h.client().get(h.url('captable', '/.well-known/oauth-protected-resource/mcp'))).text)
  assert.deepEqual(resource.authorization_servers, ['http://insulinapps.localhost'])
  assert.equal(resource.resource, 'http://captable.insulinapps.localhost/mcp')
  assert.equal(JSON.parse((await h.client().get(h.url('captable', '/.well-known/oauth-protected-resource'))).text).resource, 'http://captable.insulinapps.localhost')
  const preflight = await h.client().request(h.url('apex', '/oauth/token'), { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274', 'Access-Control-Request-Method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/)
})

test('registration accepts public clients that return to this computer or a known connector, and nothing else', async () => {
  const client = await registerClient(h, { name: '  Claude\u0000 Code  ', redirectUris: [LOOPBACK, 'http://localhost:9999/cb', 'http://[::1]:1/x', 'https://claude.ai/api/mcp/auth_callback'] })
  assert.match(client.client_id, /^mcp_[A-Za-z0-9_-]{22}$/)
  assert.equal(client.client_name, 'Claude Code')
  assert.equal(client.token_endpoint_auth_method, 'none')
  for (const uris of [['https://evil.example/cb'], ['http://192.168.1.2/cb'], ['http://localhost.evil.example/cb'], ['http://user:pw@localhost/cb'], ['http://localhost/cb#x'], [], 'http://localhost/cb']) {
    const response = await json(h.client(), h.url('apex', '/oauth/register'), { redirect_uris: uris })
    assert.equal(response.status, 400, JSON.stringify(uris))
    assert.equal(response.json.error, 'invalid_redirect_uri')
  }
  const confidential = await json(h.client(), h.url('apex', '/oauth/register'), { redirect_uris: [LOOPBACK], token_endpoint_auth_method: 'client_secret_basic' })
  assert.equal(confidential.json.error, 'invalid_client_metadata')
  const implicit = await json(h.client(), h.url('apex', '/oauth/register'), { redirect_uris: [LOOPBACK], response_types: ['token'] })
  assert.equal(implicit.json.error, 'invalid_client_metadata')
  const notJson = await form(h.client(), h.url('apex', '/oauth/register'), { redirect_uris: LOOPBACK })
  assert.equal(notJson.status, 400)
})

test('authorization: a bad client or return address is shown, other problems go back to the client', async () => {
  const person = await owner()
  const client = await registerClient(h)
  const { challenge } = pkce()
  const unknown = await person.client.get(authorizeUrl(h, { client: { client_id: 'mcp_nope' }, challenge }))
  assert.equal(unknown.status, 400)
  assert.match(unknown.text, /isn&#x27;t registered/)
  const wrongReturn = await person.client.get(authorizeUrl(h, { client, challenge, redirectUri: 'http://127.0.0.1:1/other' }))
  assert.equal(wrongReturn.status, 400)
  assert.equal(wrongReturn.location, null, 'never redirected to an unregistered address')
  const noPkce = await person.client.get(authorizeUrl(h, { client, challenge: 'short' }))
  assert.equal(noPkce.status, 302)
  const back = new URL(noPkce.location)
  assert.equal(back.origin + back.pathname, LOOPBACK)
  assert.equal(back.searchParams.get('error'), 'invalid_request')
  assert.equal(back.searchParams.get('state'), 'state-1')
  assert.equal(back.searchParams.get('iss'), 'http://insulinapps.localhost')
  const noResource = await person.client.get(authorizeUrl(h, { client, challenge, resource: 'https://elsewhere.example/mcp' }))
  assert.equal(new URL(noResource.location).searchParams.get('error'), 'invalid_target')
  const signedOut = await h.client().get(authorizeUrl(h, { client, challenge }))
  assert.equal(signedOut.status, 302)
  assert.match(signedOut.location, /\/login\?return_to=/, 'sign in first, then come back')
})

test('consent lists only organizations where the person can use the app, and Deny tells the client', async () => {
  const person = await owner('Consent Org A')
  const second = await h.org(person.client, 'Consent Org B')
  const other = await owner('Ledger Org')
  const appsOnly = await h.user({ name: 'Ledger Person' })
  await other.client.post(h.url('apex', `/orgs/${other.orgId}/invitations`), { email: appsOnly.email, role: 'APPS', 'app:ledger': 'VIEWER' })
  await appsOnly.client.post(`${await h.link(appsOnly.email, '/invitations/')}/accept`, {})
  const client = await registerClient(h, { name: 'Consent Agent' })
  const { challenge } = pkce()
  const { page, token } = await openConsent(person, authorizeUrl(h, { client, challenge }))
  assert.match(page.text, /Allow Consent Agent to use Cap Table as you\?/)
  assert.match(page.text, /127\.0\.0\.1:33418/)
  assert.match(page.text, /Any program running here could listen on that address/)
  assert.match(page.text, /Consent Org A \(Admin\)/)
  assert.match(page.text, new RegExp(`value="${second}"`))
  const denied = await decide(h, person, token, { decision: 'deny' })
  assert.equal(denied.target.searchParams.get('error'), 'access_denied')
  assert.equal(denied.target.searchParams.get('state'), 'state-1')
  assert.equal((await decide(h, person, token, { orgId: person.orgId })).response.status, 400, 'a request is answered once')

  const none = await appsOnly.client.get(authorizeUrl(h, { client, challenge }))
  assert.equal(none.status, 403)
  assert.match(none.text, /You don&#x27;t have access to Cap Table/)
  const stranger = await openConsent(person, authorizeUrl(h, { client, challenge }))
  assert.equal((await decide(h, person, stranger.token, { orgId: other.orgId })).response.status, 403, "an organization that isn't theirs")
  const elsewhere = await openConsent(person, authorizeUrl(h, { client, challenge }))
  assert.equal((await decide(h, other, elsewhere.token, { orgId: other.orgId })).response.status, 400, "another person's request")
})

test('codes work once, with the PKCE verifier, the same client and return address; a replay ends the grant', async () => {
  const person = await owner('Code Org')
  const client = await registerClient(h)
  const { verifier, challenge } = pkce()
  const { token } = await openConsent(person, authorizeUrl(h, { client, challenge }))
  const { target } = await decide(h, person, token, { orgId: person.orgId })
  const code = target.searchParams.get('code')
  assert.match(code, /^ia_ac_/)
  assert.equal(target.searchParams.get('iss'), 'http://insulinapps.localhost')
  const exchange = (fields) => form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: LOOPBACK, code_verifier: verifier, ...fields })
  const badVerifier = await exchange({ code_verifier: pkce().verifier })
  assert.equal(badVerifier.json.error, 'invalid_grant', 'a wrong verifier, and the code is now used')
  const replay = await exchange({})
  assert.equal(replay.json.error, 'invalid_grant')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1', person.id))[0].n, 0, 'the replay ended the grant')

  const fresh = await connect(h, person, person.orgId)
  assert.match(fresh.access_token, /^ia_at_/)
  assert.match(fresh.refresh_token, /^ia_rt_/)
  assert.equal(fresh.token_type, 'Bearer')
  assert.equal(fresh.expires_in, 3600)
  const stored = await h.sql('SELECT token_hash FROM oauth_tokens')
  assert.ok(stored.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)), 'only hashes are stored')
  assert.ok(!stored.some((row) => row.token_hash === fresh.access_token))

  const other = await registerClient(h)
  const second = pkce()
  const again = await openConsent(person, authorizeUrl(h, { client, challenge: second.challenge }))
  const otherCode = (await decide(h, person, again.token, { orgId: person.orgId })).target.searchParams.get('code')
  const wrongClient = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'authorization_code', code: otherCode, client_id: other.client_id, redirect_uri: LOOPBACK, code_verifier: second.verifier })
  assert.equal(wrongClient.json.error, 'invalid_grant')
})

test('refresh tokens rotate; presenting an old one ends the grant for every copy', async () => {
  const person = await owner('Refresh Org')
  const first = await connect(h, person, person.orgId)
  const refresh = (token, clientId = first.client.client_id) => form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: token, client_id: clientId })
  assert.equal((await refresh(first.refresh_token, 'mcp_someone_else')).json.error, 'invalid_grant', 'another client')
  const next = await refresh(first.refresh_token)
  assert.equal(next.status, 200, next.text)
  assert.notEqual(next.json.refresh_token, first.refresh_token)
  assert.equal((await rpc(h, next.json.access_token, 'ping')).status, 200)
  const reused = await refresh(first.refresh_token)
  assert.equal(reused.json.error, 'invalid_grant')
  assert.equal((await rpc(h, next.json.access_token, 'ping')).status, 401, 'the reuse ended the grant, so the new tokens stop too')
  assert.equal((await refresh(next.json.refresh_token)).json.error, 'invalid_grant')
})

test('revocation: an access token ends alone, a refresh token ends its grant; only the client that holds it can', async () => {
  const person = await owner('Revoke Org')
  const tokens = await connect(h, person, person.orgId)
  const revoke = (token, clientId) => form(h.client(), h.url('apex', '/oauth/revoke'), { token, client_id: clientId })
  assert.equal((await revoke(tokens.access_token, 'mcp_not_the_client')).status, 200, 'always 200')
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 200, '…but nothing happened')
  assert.equal((await revoke(tokens.access_token, tokens.client.client_id)).status, 200)
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401)
  const renewed = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.client.client_id })
  assert.equal(renewed.status, 200, 'the grant outlived its access token')
  await revoke(renewed.json.refresh_token, tokens.client.client_id)
  assert.equal((await rpc(h, renewed.json.access_token, 'ping')).status, 401, 'revoking the refresh token ended the grant')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1', person.id))[0].n, 0)
})

test('Account → AI agents lists the person\'s agents and disconnects them; nobody else can', async () => {
  const person = await owner('Agents Org')
  const tokens = await connect(h, person, person.orgId, { name: 'Codex CLI' })
  const page = await person.client.get(h.url('apex', '/account/agents'))
  assert.equal(page.status, 200)
  assert.match(page.text, /Codex CLI/)
  assert.match(page.text, /Agents Org/)
  assert.match(page.text, /http:\/\/captable\.insulinapps\.localhost\/mcp/)
  assert.ok(page.text.includes('href="/apps/captable/settings/connect-ai"'), "it links to each app's Connect AI page")
  assert.ok(!page.text.includes('href="/apps/ledger/settings/connect-ai"'), 'but not to an app that is not deployed')
  assert.match((await person.client.get(h.url('apex', '/account'))).text, /href="\/account\/agents"/)
  const [grant] = await h.sql('SELECT id FROM oauth_grants WHERE user_id = ?1', person.id)
  const stranger = await h.user()
  assert.equal((await stranger.client.post(h.url('apex', `/account/agents/${grant.id}/disconnect`), {})).status, 404)
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 200)
  const out = await person.client.post(h.url('apex', `/account/agents/${grant.id}/disconnect`), {})
  assert.equal(out.status, 303)
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401, 'disconnected at once')
  assert.match((await person.client.get(h.url('apex', '/account/agents'))).text, /You haven&#x27;t connected an agent yet/)
})

test('the new pages keep the site\'s rules: one heading, no inline script, style or handler, nothing unescaped', async () => {
  const person = await owner('<b>Pages</b> Org')
  const client = await registerClient(h, { name: '<script>alert(1)</script>' })
  const { challenge } = pkce()
  const { page, token } = await openConsent(person, authorizeUrl(h, { client, challenge }))
  const { response } = await decide(h, person, token, { orgId: person.orgId })
  const agents = await person.client.get(h.url('apex', '/account/agents'))
  for (const [name, text] of [['consent', page.text], ['continue', response.text], ['agents', agents.text]]) {
    assert.equal(text.match(/<h1[\s>]/g)?.length, 1, `${name}: one h1`)
    assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/, `${name}: no inline script, style or handler`)
    assert.ok(!text.includes('<script>alert(1)'), `${name}: the client's name is escaped`)
  }
})

test('housekeeping drops expired requests, codes, tokens and grants, and clients that never got a grant', async () => {
  const person = await owner('Cleanup Org')
  await connect(h, person, person.orgId)
  const idle = await registerClient(h)
  await h.sql('UPDATE oauth_clients SET created_at = 0 WHERE id = ?1', idle.client_id)
  await h.sql('UPDATE oauth_grants SET expires_at = 1 WHERE user_id = ?1', person.id)
  await h.sql('UPDATE oauth_tokens SET expires_at = 1')
  // Any POST runs the bounded cleanup after its response.
  await h.client().post(h.url('apex', '/login'), {})
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [{ n }] = await h.sql('SELECT COUNT(*) AS n FROM oauth_clients WHERE id = ?1', idle.client_id)
    if (n === 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_clients WHERE id = ?1', idle.client_id))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1', person.id))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_tokens'))[0].n, 0)
})

test('review: a credential change ends the person\'s agents, so one connected by an intruder doesn\'t outlive the recovery', async () => {
  const person = await owner('Recovery Org')
  const tokens = await connect(h, person, person.orgId)
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 200)
  const changed = await person.client.post(h.url('apex', '/account/password'), { current_password: PASSWORD, password: 'a brand new passphrase' })
  assert.equal(changed.status, 303, changed.text.slice(0, 300))
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1', person.id))[0].n, 0)
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401)
  const renewed = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.client.client_id })
  assert.equal(renewed.status, 400, 'nor can it refresh')
})

test('review: junk token requests naming a public client id are slowed per IP and per failure, never locking the client out', async () => {
  const limited = await startGateway({ authLimit: 5 })
  try {
    const person = await limited.user()
    const orgId = await limited.org(person.client, 'Slow Down Org')
    const tokens = await connect(limited, person, orgId)
    const attacker = limited.client()
    const junk = () => form(attacker, limited.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: `ia_rt_${'J'.repeat(43)}`, client_id: tokens.client.client_id })
    const statuses = []
    for (let attempt = 0; attempt < 8; attempt += 1) statuses.push((await junk()).status)
    assert.ok(statuses.includes(429), `the attacker is slowed: ${statuses}`)
    const renewed = await form(limited.client(), limited.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: tokens.client.client_id })
    assert.equal(renewed.status, 200, 'the real client still refreshes')
  } finally {
    await limited.close()
  }
})
