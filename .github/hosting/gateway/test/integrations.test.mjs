// An app's integrations (DESIGN.md §5.3, §6): service accounts and their API access, stored credentials, and the
// integration proxy that adds a credential to an app's outside calls.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, SECRET_KEY, startGateway } from './helpers/harness.mjs'
import { appToken, connect, form, json } from './helpers/oauth.mjs'

const CATALOG = [
  { key: 'captable.manage', label: 'Record changes', description: '', role: 'EDITOR' },
  { key: 'captable.view', label: 'View the cap table', description: '', role: 'EDITOR' },
  { key: 'portfolio.view', label: 'See own holdings', description: '', role: 'VIEWER' },
]

let h
before(async () => {
  h = await startGateway({ apps: APPS.map((app) => (app.name === 'captable' ? { ...app, permissions: CATALOG } : app)) })
})
after(async () => { await h?.close() })

// The app's integrations page lives on the apex, under /apps/<app>.
const page = (person) => person.client.get(h.url('apex', '/apps/captable/settings/integrations'))
const post = (person, path, fields) => person.client.post(h.url('apex', `/apps/captable${path}`), fields)

async function team(name) {
  const owner = await h.user({ name: 'Ivy Owner' })
  const orgId = await h.org(owner.client, name)
  const viewer = await h.user({ name: 'Vic Viewer' })
  await h.join(owner, orgId, viewer, 'VIEWER')
  return { owner, orgId, viewer }
}

/** Creates a service account as `person`; returns its client id and the secret shown once. */
async function serviceAccount(person, orgId, name, role = 'EDITOR') {
  const created = await post(person, '/settings/integrations/service-accounts', { org_id: orgId, name, role })
  assert.equal(created.status, 200, created.text.slice(0, 400))
  const clientId = /(ia_sa_[A-Za-z0-9_-]{22})/.exec(created.text)?.[1]
  const secret = /(ia_sk_[A-Za-z0-9_-]{43})/.exec(created.text)?.[1]
  assert.ok(clientId && secret, 'the page shows the client id and secret')
  const [row] = await h.sql('SELECT id FROM service_accounts WHERE client_id = ?1', clientId)
  return { id: row.id, clientId, secret, page: created.text }
}

async function serviceToken({ clientId, secret }, extra = {}) {
  return form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'client_credentials', ...extra }, {
    Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
  })
}

async function api(token, path = '/api/echo', client = h.client(), options = {}) {
  return client.request(h.url('captable', path), { method: options.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) }, body: options.body })
}

test('the integrations page: everyone with access sees it, only app admins change it', async () => {
  const { owner, viewer, orgId } = await team('Integrations Org')
  const asViewer = await page(viewer)
  assert.equal(asViewer.status, 200)
  assert.match(asViewer.text, /<h2>Service accounts<\/h2>/)
  assert.match(asViewer.text, /Only Cap Table&#x27;s admins add, change and delete integrations/)
  assert.doesNotMatch(asViewer.text, /New service account/)
  assert.equal((await post(viewer, '/settings/integrations/service-accounts', { org_id: orgId, name: 'Sneaky', role: 'ADMIN' })).status, 403)
  assert.equal((await post(viewer, '/settings/integrations/credentials', { org_id: orgId, key: 'x', name: 'x', base_url: 'https://api.example.test', auth_scheme: 'bearer', secret: 's' })).status, 403)
  const asOwner = await page(owner)
  assert.match(asOwner.text, /New service account/)
  assert.match(asOwner.text, /New stored credential/)
  const stranger = await h.user()
  await h.org(stranger.client, 'Stranger Org')
  assert.equal((await post(stranger, '/settings/integrations/service-accounts', { org_id: orgId, name: 'x', role: 'ADMIN' })).status, 404)
})

test('a service account gets tokens with its credentials and calls the API with its role; its secret shows once', async () => {
  const { owner, orgId } = await team('Service Org')
  const account = await serviceAccount(owner, orgId, 'Nightly export', 'EDITOR')
  assert.match(account.page, /copy the secret now/)
  const [stored] = await h.sql('SELECT secret_hash FROM service_accounts WHERE id = ?1', account.id)
  assert.match(stored.secret_hash, /^[0-9a-f]{64}$/)
  const again = await page(owner)
  assert.ok(again.text.includes(account.clientId), 'the client id stays visible')
  assert.ok(!again.text.includes(account.secret), 'the secret never shows again')

  const token = await serviceToken(account)
  assert.equal(token.status, 200, token.text)
  assert.equal(token.json.token_type, 'Bearer')
  assert.equal(token.json.refresh_token, undefined, 'client credentials get no refresh token')
  const posted = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'client_credentials', client_id: account.clientId, client_secret: account.secret })
  assert.equal(posted.status, 200, 'client_secret_post works too')
  assert.equal((await serviceToken({ ...account, secret: `ia_sk_${'B'.repeat(43)}` })).json.error, 'invalid_client')
  assert.equal((await serviceToken(account, { resource: h.url('ledger') })).json.error, 'invalid_target')
  assert.equal((await serviceToken(account, { resource: 'http://captable.insulinapps.localhost' })).status, 200)

  assert.equal(account.page.match(/<h1[\s>]/g)?.length, 1)
  assert.doesNotMatch(account.page, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/)
  const response = await api(token.json.access_token)
  assert.equal(response.status, 200, response.text)
  const headers = JSON.parse(response.text).headers
  assert.equal(headers['x-suger-user-id'], account.id)
  assert.equal(headers['x-suger-user-email'], encodeURIComponent(`${account.id}@service-accounts.invalid`))
  assert.equal(headers['x-suger-user-name'], encodeURIComponent('Nightly export'))
  assert.equal(headers['x-suger-organization-id'], orgId)
  assert.equal(headers['x-suger-app-role'], 'EDITOR')
  assert.equal(headers['x-suger-app-permissions'], 'captable.manage captable.view portfolio.view')
  assert.equal(headers['x-suger-access-via'], 'api')
  assert.equal(headers['user-agent'], 'Insulin Apps API: Nightly export')
  assert.equal(headers.authorization, undefined)
  assert.equal(headers.origin, 'http://captable.insulinapps.localhost')
  const upload = await api(token.json.access_token, '/api/echo-body', h.client(), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'rows' })
  assert.equal(JSON.parse(upload.text).body, 'rows', 'the body is streamed through')
})

test('a bearer request never falls back to cookies, and reaches only the app\'s API', async () => {
  const { owner, orgId } = await team('Bearer Org')
  const account = await serviceAccount(owner, orgId, 'Bearer bot', 'VIEWER')
  const token = (await serviceToken(account)).json.access_token
  const withCookies = await api(token, '/api/echo', owner.client, { headers: { Cookie: 'app_pref=dark' } })
  const seen = JSON.parse(withCookies.text)
  assert.equal(seen.headers['x-suger-user-id'], account.id, "the token's identity, not the browser's")
  assert.equal(seen.cookie, null, 'no cookie reaches the app on a bearer request')
  const forged = await api(`ia_at_${'C'.repeat(43)}`, '/api/echo', owner.client)
  assert.equal(forged.status, 401, 'a bad token is refused even with a valid session alongside')
  assert.match(forged.headers.get('www-authenticate'), /error="invalid_token"/)
  for (const path of ['/dashboard', '/api/__suger/health', '/']) assert.equal((await api(token, path)).status, 401, path)
  const mcp = await json(h.client(), h.url('captable', '/mcp'), { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${token}` })
  assert.equal(mcp.status, 401, 'MCP is for people')
  const settings = await h.client().get(h.url('apex', '/apps/captable/settings/integrations'), { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(settings.status, 302, 'a token never opens the gateway\'s pages: they want a signed-in browser')
  assert.match(settings.location, /\/login\?/)
})

test('custom roles, edits, new secrets and deletion apply to the next request', async () => {
  const { owner, orgId } = await team('Lifecycle Org')
  const body = new URLSearchParams({ app: 'captable', name: 'Read only', description: '' })
  body.append('permission', 'captable.view')
  await owner.client.post(h.url('apex', `/orgs/${orgId}/roles`), {}, { body: body.toString() })
  const [role] = await h.sql('SELECT id FROM custom_roles WHERE org_id = ?1', orgId)
  const account = await serviceAccount(owner, orgId, 'Board feed', `custom:${role.id}`)
  let token = (await serviceToken(account)).json.access_token
  let headers = JSON.parse((await api(token)).text).headers
  assert.equal(headers['x-suger-app-role'], 'EDITOR')
  assert.equal(headers['x-suger-app-permissions'], 'captable.view')
  const inUse = await owner.client.post(h.url('apex', `/orgs/${orgId}/roles/${role.id}/delete`), {})
  assert.equal(inUse.status, 409, 'a custom role a service account uses stays')

  assert.equal((await post(owner, `/settings/integrations/service-accounts/${account.id}`, { org_id: orgId, name: 'Board feed v2', role: 'VIEWER' })).status, 303)
  headers = JSON.parse((await api(token)).text).headers
  assert.equal(headers['x-suger-app-role'], 'VIEWER', 'the new role, with the same token')
  assert.equal(headers['x-suger-user-name'], encodeURIComponent('Board feed v2'))

  const rotated = await post(owner, `/settings/integrations/service-accounts/${account.id}/rotate`, { org_id: orgId })
  const newSecret = /(ia_sk_[A-Za-z0-9_-]{43})/.exec(rotated.text)?.[1]
  assert.ok(newSecret && newSecret !== account.secret)
  assert.equal((await api(token)).status, 401, 'the old tokens stopped')
  assert.equal((await serviceToken(account)).status, 401, 'and the old secret')
  token = (await serviceToken({ ...account, secret: newSecret })).json.access_token
  assert.equal((await api(token)).status, 200)

  assert.equal((await post(owner, `/settings/integrations/service-accounts/${account.id}/delete`, { org_id: orgId })).status, 303)
  assert.equal((await api(token)).status, 401)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/roles/${role.id}/delete`), {})).status, 303, 'now the role can go')
})

test('stored credentials: admins save them encrypted, nobody sees the secret, and the checks keep them outside', async () => {
  const { owner, viewer, orgId } = await team('Credentials Org')
  const save = (fields) => post(owner, '/settings/integrations/credentials', { org_id: orgId, name: 'Payroll', base_url: 'https://api.example.test/v1', auth_scheme: 'bearer', secret: 'sk-live-synthetic-123', ...fields })
  assert.equal((await save({ key: 'payroll', allowed_hosts: 'files.example.test, Files.Example.Test' })).status, 303)
  const [row] = await h.sql("SELECT id, secret_enc, allowed_hosts FROM integrations WHERE org_id = ?1 AND key = 'payroll'", orgId)
  assert.match(row.secret_enc, /^v1\./, 'sealed')
  assert.ok(!row.secret_enc.includes('sk-live'))
  assert.deepEqual(JSON.parse(row.allowed_hosts), ['files.example.test'])
  for (const person of [owner, viewer]) {
    const text = (await page(person)).text
    assert.match(text, /payroll/)
    assert.match(text, /https:\/\/api\.example\.test\/v1/)
    assert.ok(!text.includes('sk-live-synthetic-123'), 'the secret is never rendered')
  }
  for (const [fields, why] of [
    [{ key: 'payroll' }, 'a key that is taken'],
    [{ key: 'Bad Key' }, 'a malformed key'],
    [{ key: 'plain', base_url: 'http://api.example.test' }, 'http'],
    [{ key: 'self', base_url: 'https://captable.insulinapps.localhost' }, 'this site'],
    [{ key: 'hdr', auth_scheme: 'header', header_name: 'Cookie' }, 'a reserved header'],
    [{ key: 'basic', auth_scheme: 'basic', secret: 'no-colon' }, 'basic needs user:password'],
    [{ key: 'empty', secret: '' }, 'no secret'],
    [{ key: 'ip', base_url: 'https://169.254.169.254/latest' }, 'an IPv4 address'],
    [{ key: 'ip6', base_url: 'https://[::1]/x' }, 'an IPv6 address'],
    [{ key: 'single', base_url: 'https://intranet/x' }, 'a single-label host'],
    [{ key: 'numeric', base_url: 'https://api.example.123/x' }, 'a numeric last label'],
    [{ key: 'hostip', allowed_hosts: '10.0.0.1' }, 'an IP address among the allowed hosts'],
  ]) {
    const response = await save(fields)
    assert.ok([400, 409].includes(response.status), `${why}: ${response.status}`)
  }
  const update = (fields) => post(owner, `/settings/integrations/credentials/${row.id}`, {
    org_id: orgId, name: 'Payroll API', base_url: 'https://api.example.test/v1', allowed_hosts: 'files.example.test', auth_scheme: 'bearer', secret: '', ...fields,
  })
  assert.equal((await update({})).status, 303, 'renaming keeps the stored secret')
  const [kept] = await h.sql('SELECT name, base_url, secret_enc FROM integrations WHERE id = ?1', row.id)
  assert.deepEqual([kept.name, kept.base_url, kept.secret_enc], ['Payroll API', 'https://api.example.test/v1', row.secret_enc])
  // Sending the stored secret anywhere new, or differently, needs it entered again: an admin could otherwise read it there.
  for (const [fields, why] of [
    [{ base_url: 'https://attacker.example.test' }, 'another base URL'],
    [{ allowed_hosts: 'files.example.test collector.example.test' }, 'another allowed host'],
    [{ auth_scheme: 'header', header_name: 'X-Leak' }, 'another way of sending it'],
  ]) {
    const refused = await update(fields)
    assert.equal(refused.status, 400, why)
    assert.match(refused.text, /needs the secret again/, why)
  }
  const [unchanged] = await h.sql('SELECT base_url, allowed_hosts, auth_scheme, secret_enc FROM integrations WHERE id = ?1', row.id)
  assert.deepEqual([unchanged.base_url, JSON.parse(unchanged.allowed_hosts), unchanged.auth_scheme, unchanged.secret_enc], ['https://api.example.test/v1', ['files.example.test'], 'bearer', row.secret_enc])
  assert.equal((await update({ base_url: 'https://api.example.test/v2', secret: 'sk-live-synthetic-456' })).status, 303, 'with a new secret, it may move')
  const [moved] = await h.sql('SELECT base_url, secret_enc FROM integrations WHERE id = ?1', row.id)
  assert.equal(moved.base_url, 'https://api.example.test/v2')
  assert.notEqual(moved.secret_enc, row.secret_enc, 'and the old secret is gone')
  assert.equal((await post(owner, `/settings/integrations/credentials/${row.id}/delete`, { org_id: orgId })).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM integrations WHERE id = ?1', row.id))[0].n, 0)
})

test('the integration proxy: the app proves itself, names the organization, and reaches only the allowed hosts', async () => {
  const { owner, orgId } = await team('Proxy Org')
  const save = (fields) => post(owner, '/settings/integrations/credentials', { org_id: orgId, name: 'Upstream', base_url: 'https://api.example.test/v1', allowed_hosts: 'files.example.test', ...fields })
  await save({ key: 'upstream', auth_scheme: 'bearer', secret: 'bearer-synthetic' })
  await save({ key: 'keyed', auth_scheme: 'header', header_name: 'X-Api-Key', secret: 'key-synthetic' })
  await save({ key: 'basic', auth_scheme: 'basic', secret: 'user:pass-synthetic' })
  const seen = []
  const echo = async (request, url, params, body) => {
    seen.push({ url: url.href, method: request.method, headers: Object.fromEntries(request.headers), body })
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=1', 'X-Upstream': 'yes' } })
  }
  h.outbound.on('https://api.example.test/', echo)
  h.outbound.on('https://files.example.test/', echo)
  h.outbound.on('https://evil.example/', echo)
  const token = appToken(SECRET_KEY, 'captable')
  const proxy = (path, headers = {}, options = {}) => h.client().request(h.url('apex', `/__insulin/integrations/${path}`), {
    method: options.method ?? 'GET', body: options.body,
    headers: { Authorization: `Bearer ${token}`, 'x-suger-organization-id': orgId, ...headers },
  })

  const through = await proxy('upstream/proxy/_/items?page=2', { Cookie: 'insulin_session=x', 'X-Suger-User-Id': 'spoofed', 'X-Custom': 'kept' })
  assert.equal(through.status, 201)
  assert.equal(through.headers.get('set-cookie'), null, 'no cookie comes back')
  assert.equal(through.headers.get('x-upstream'), 'yes')
  const first = seen.at(-1)
  assert.equal(first.url, 'https://api.example.test/v1/items?page=2')
  assert.equal(first.headers.authorization, 'Bearer bearer-synthetic', "the app's own token is replaced by the credential")
  assert.equal(first.headers.cookie, undefined)
  assert.equal(first.headers['x-suger-user-id'], undefined)
  assert.equal(first.headers['x-suger-organization-id'], undefined)
  assert.equal(first.headers['x-custom'], 'kept')

  await proxy('keyed/proxy/files.example.test/report.csv', {}, { method: 'POST', body: 'a,b' })
  assert.equal(seen.at(-1).url, 'https://files.example.test/report.csv')
  assert.equal(seen.at(-1).headers['x-api-key'], 'key-synthetic')
  assert.equal(seen.at(-1).headers.authorization, undefined)
  assert.equal(seen.at(-1).body, 'a,b')
  await proxy('basic/proxy/_/')
  assert.equal(seen.at(-1).headers.authorization, `Basic ${Buffer.from('user:pass-synthetic').toString('base64')}`)

  const count = seen.length
  assert.equal((await proxy('upstream/proxy/evil.example/steal')).status, 403, 'a host not on the list')
  assert.equal((await proxy('upstream/proxy/_/../../admin')).status, 404, 'URL parsing resolves plain dot segments: no proxy path is left')
  assert.ok([400, 403].includes((await proxy('upstream/proxy/_/%2e%2e/admin')).status), 'encoded dot segments climb nowhere either')
  assert.equal((await proxy('upstream/proxy/_/a%2F..%2Fadmin')).status, 400, 'nor ones hidden in an encoded slash')
  assert.equal(seen.length, count, 'nothing left the gateway')
  assert.equal((await proxy('missing/proxy/_/x')).status, 404)
  assert.equal((await proxy('upstream/proxy/_/x', { Authorization: 'Bearer not-the-token' })).status, 401)
  assert.equal((await proxy('upstream/proxy/_/x', { Authorization: `Bearer ${appToken(SECRET_KEY, 'ledger')}` })).status, 404, "another app's token sees only that app's credentials")
  assert.equal((await proxy('upstream/proxy/_/x', { 'x-suger-organization-id': 'not-an-id' })).status, 400)
  const otherOrg = await h.org(owner.client, 'Other Proxy Org')
  assert.equal((await proxy('upstream/proxy/_/x', { 'x-suger-organization-id': otherOrg })).status, 404, "another organization's credentials")
  assert.equal((await h.client().get(h.url('captable', '/__insulin/integrations/upstream/proxy/_/x'), { headers: { Authorization: `Bearer ${token}` } })).status, 404, 'apex only')
})

test('without GATEWAY_SECRET_KEY, stored credentials and the proxy say they are not set up', async () => {
  const bare = await startGateway({ vars: { GATEWAY_SECRET_KEY: undefined } })
  try {
    const owner = await bare.user()
    const orgId = await bare.org(owner.client, 'Keyless Org')
    const text = (await owner.client.get(bare.url('apex', '/apps/captable/settings/integrations'))).text
    assert.match(text, /aren&#x27;t set up on this site yet/)
    assert.match(text, /New service account/, 'service accounts need no key')
    const refused = await owner.client.post(bare.url('apex', '/apps/captable/settings/integrations/credentials'), { org_id: orgId, key: 'k', name: 'n', base_url: 'https://api.example.test', auth_scheme: 'bearer', secret: 's' })
    assert.equal(refused.status, 503)
    const proxy = await bare.client().get(bare.url('apex', '/__insulin/integrations/k/proxy/_/x'), { headers: { Authorization: 'Bearer x', 'x-suger-organization-id': orgId } })
    assert.equal(proxy.status, 503)
  } finally {
    await bare.close()
  }
})

test('connecting an agent to Cap Table needs no integrations: a person\'s MCP token and a service account stay apart', async () => {
  const { owner, orgId } = await team('Apart Org')
  const tokens = await connect(h, owner, orgId)
  assert.equal((await api(tokens.access_token)).status, 401)
})

test('review: revoking a service account\'s token needs its secret, not just its client id', async () => {
  const { owner, orgId } = await team('Revoke SA Org')
  const account = await serviceAccount(owner, orgId, 'Revocable', 'VIEWER')
  const token = (await serviceToken(account)).json.access_token
  const revoke = (headers, fields = {}) => form(h.client(), h.url('apex', '/oauth/revoke'), { token, ...fields }, headers)
  assert.equal((await revoke({}, { client_id: account.clientId })).status, 200)
  assert.equal((await api(token)).status, 200, 'the client id alone revoked nothing')
  assert.equal((await revoke({ Authorization: `Basic ${Buffer.from(`${account.clientId}:ia_sk_${'W'.repeat(43)}`).toString('base64')}` })).status, 200)
  assert.equal((await api(token)).status, 200, 'nor did a wrong secret')
  assert.equal((await revoke({ Authorization: `Basic ${Buffer.from(`${account.clientId}:${account.secret}`).toString('base64')}` })).status, 200)
  assert.equal((await api(token)).status, 401, 'its own credentials did')
})
