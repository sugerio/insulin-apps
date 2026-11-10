// Each app's MCP server (DESIGN.md §5.2): the challenge, JSON-RPC, the four tools reaching the app's own API as the
// person (with their role at each call), and what an MCP token can't reach.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './helpers/harness.mjs'
import { connect, json, rpc, tool } from './helpers/oauth.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

async function connected(orgName = 'MCP Org') {
  const person = await h.user({ name: 'Mia Agent-User' })
  const orgId = await h.org(person.client, orgName)
  const tokens = await connect(h, person, orgId)
  return { person, orgId, tokens }
}

test('without a valid token, /mcp answers 401 pointing at its metadata; only POST is served', async () => {
  const bare = await json(h.client(), h.url('captable', '/mcp'), { jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(bare.status, 401)
  assert.equal(bare.headers.get('www-authenticate'), 'Bearer resource_metadata="http://captable.insulinapps.localhost/.well-known/oauth-protected-resource/mcp"')
  assert.equal(bare.headers.get('access-control-expose-headers').includes('WWW-Authenticate'), true)
  const forged = await rpc(h, `ia_at_${'A'.repeat(43)}`, 'ping')
  assert.equal(forged.status, 401)
  assert.match(forged.headers.get('www-authenticate'), /error="invalid_token"/)
  const get = await h.client().get(h.url('captable', '/mcp'))
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS')
  const unavailable = await json(h.client(), h.url('ledger', '/mcp'), { jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(unavailable.status, 503, 'an app that is not deployed')
})

test('JSON-RPC: initialize negotiates the version, notifications get 202, tools are listed, batches work', async () => {
  const { tokens } = await connected()
  const init = await rpc(h, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  assert.equal(init.status, 200)
  assert.equal(init.json.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } })
  assert.equal(init.json.result.serverInfo.name, 'insulin-apps-captable')
  const future = await rpc(h, tokens.access_token, 'initialize', { protocolVersion: '2099-01-01' })
  assert.equal(future.json.result.protocolVersion, '2025-11-25', 'an unknown version gets the newest')
  const notification = await json(h.client(), h.url('captable', '/mcp'), { jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: `Bearer ${tokens.access_token}` })
  assert.equal(notification.status, 202)
  assert.equal(notification.text, '')
  const list = await rpc(h, tokens.access_token, 'tools/list')
  assert.deepEqual(list.json.result.tools.map((entry) => entry.name), ['whoami', 'endpoints', 'read', 'change'])
  assert.equal((await rpc(h, tokens.access_token, 'resources/list')).json.error.code, -32601)
  assert.equal((await rpc(h, tokens.access_token, 'tools/call', { name: 'shell' })).json.error.code, -32602)
  const batch = await json(h.client(), h.url('captable', '/mcp'), [
    { jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'ping' },
  ], { Authorization: `Bearer ${tokens.access_token}` })
  assert.deepEqual(batch.json.map((answer) => answer.id), ['a', 'b'])
  const garbage = await h.client().request(h.url('captable', '/mcp'), { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(JSON.parse(garbage.text).error.code, -32700)
})

test('whoami and endpoints: who the connection acts as, and the app\'s catalog fetched as them', async () => {
  const { person, orgId, tokens } = await connected('Whoami Org')
  const who = (await tool(h, tokens.access_token, 'whoami')).structuredContent
  assert.deepEqual(who.user, { id: person.id, name: 'Mia Agent-User', email: person.email })
  assert.deepEqual(who.organization, { id: orgId, name: 'Whoami Org' })
  assert.equal(who.role, 'ADMIN')
  assert.equal(who.client, 'Test Agent')
  const catalog = (await tool(h, tokens.access_token, 'endpoints')).structuredContent
  assert.equal(catalog.status, 200)
  assert.equal(catalog.body.endpoints[0].path, '/api/echo')
})

test('read and change reach the app as the person: identity headers, no cookie or token, same-origin, the agent named', async () => {
  const { person, orgId, tokens } = await connected('Read Org')
  const read = (await tool(h, tokens.access_token, 'read', { path: '/api/echo', query: { page: 2, open: true } })).structuredContent
  assert.equal(read.status, 200)
  const seen = read.body
  assert.equal(seen.method, 'GET')
  assert.equal(seen.url, 'http://captable.insulinapps.localhost/api/echo?page=2&open=true')
  assert.equal(seen.headers['x-suger-user-id'], person.id)
  assert.equal(seen.headers['x-suger-organization-id'], orgId)
  assert.equal(seen.headers['x-suger-app-role'], 'ADMIN')
  assert.equal(seen.headers['x-suger-access-via'], 'mcp')
  assert.equal(seen.headers.origin, 'http://captable.insulinapps.localhost')
  assert.equal(seen.headers['sec-fetch-site'], 'same-origin')
  assert.equal(seen.headers['user-agent'], 'Insulin Apps MCP: Test Agent')
  assert.equal(seen.headers.authorization, undefined, 'the token stays with the gateway')
  assert.equal(seen.cookie, null)

  const change = (await tool(h, tokens.access_token, 'change', { method: 'post', path: '/api/echo-body', body: { shares: '100' }, idempotencyKey: 'key-1' })).structuredContent
  assert.equal(change.body.method, 'POST')
  assert.equal(change.body.headers['idempotency-key'], 'key-1')
  assert.equal(change.body.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(change.body.body), { shares: '100' })
  const missing = await tool(h, tokens.access_token, 'change', { method: 'GET', path: '/api/echo' })
  assert.equal(missing.isError, true, 'change takes POST, PUT, PATCH or DELETE')

  const large = (await tool(h, tokens.access_token, 'read', { path: '/api/large' })).structuredContent
  assert.equal(large.truncated, true)
  assert.equal(large.body.length, 200 * 1024)
})

test('only the app\'s own API is reachable: not its pages, the platform\'s routes, or another origin', async () => {
  const { tokens } = await connected('Paths Org')
  for (const path of ['/dashboard', '/api/__suger/health', '/API/__SUGER/health', '/api/../settings/users', '/api/%2e%2e/settings/users', '//evil.example/api/x', 'https://evil.example/api/x', '/api\\x', '/settings/users']) {
    const result = await tool(h, tokens.access_token, 'read', { path })
    assert.equal(result.isError, true, path)
    assert.match(result.content[0].text, /\/api\//, path)
  }
  const onApi = await h.client().get(h.url('captable', '/api/echo'), { headers: { Authorization: `Bearer ${tokens.access_token}` } })
  assert.equal(onApi.status, 401, "a person's MCP token doesn't work on the API directly")
})

test('every call re-checks the person: a new role applies at once, and losing access stops the agent', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Recheck Org')
  const editor = await h.user({ name: 'Edda Editor' })
  await h.join(owner, orgId, editor, 'EDITOR')
  const tokens = await connect(h, editor, orgId)
  assert.equal((await tool(h, tokens.access_token, 'whoami')).structuredContent.role, 'EDITOR')
  await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${editor.id}/role`), { role: 'VIEWER' })
  assert.equal((await tool(h, tokens.access_token, 'whoami')).structuredContent.role, 'VIEWER')
  await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${editor.id}/role`), { role: 'APPS', 'app:ledger': 'EDITOR' })
  const noApp = await rpc(h, tokens.access_token, 'ping')
  assert.equal(noApp.status, 403, 'specific apps, without this one')
  await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${editor.id}/role`), { role: 'APPS', 'app:captable': 'EDITOR' })
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 200)
  await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${editor.id}/remove`), {})
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401, 'removed from the organization: the grant ended with the membership')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1', editor.id))[0].n, 0)
  await h.join(owner, orgId, editor, 'EDITOR')
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 401, 'and being invited again does not bring the agent back')
})

test("a token is for one app: a grant for another app doesn't open this one", async () => {
  const { person, tokens } = await connected('One App Org')
  assert.equal((await rpc(h, tokens.access_token, 'ping')).status, 200)
  await h.sql("UPDATE oauth_grants SET app = 'ledger' WHERE user_id = ?1", person.id)
  const refused = await rpc(h, tokens.access_token, 'ping')
  assert.equal(refused.status, 401)
  assert.match(refused.headers.get('www-authenticate'), /error="invalid_token"/)
})

test('review: a batch holds at most 10 messages, and every tool call in it counts against the person\'s app rate', async () => {
  const limited = await startGateway({ appLimit: 4 })
  try {
    const person = await limited.user()
    const orgId = await limited.org(person.client, 'Batch Org')
    const tokens = await connect(limited, person, orgId)
    const send = (messages) => json(limited.client(), limited.url('captable', '/mcp'), messages, { Authorization: `Bearer ${tokens.access_token}` })
    const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
    const tooMany = await send(Array.from({ length: 11 }, (_, index) => call(index)))
    assert.equal(tooMany.status, 400)
    assert.equal(tooMany.json.error.code, -32600)
    assert.match(tooMany.json.error.message, /at most 10/)
    // Of the four requests a minute, the refused batch took one and this request another: five tool calls share two.
    const batch = await send(Array.from({ length: 5 }, (_, index) => call(index)))
    assert.equal(batch.status, 200)
    assert.equal(batch.json.filter((answer) => answer.result).length, 2)
    assert.equal(batch.json.filter((answer) => answer.error?.code === -32000).length, 3)
  } finally {
    await limited.close()
  }
})
