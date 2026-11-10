// Helpers for the OAuth, MCP and integration tests: an MCP client's side of registration, authorization and tokens,
// and the app token the deploy gives each app Worker. Synthetic data only.
import assert from 'node:assert/strict'
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'

export const LOOPBACK = 'http://127.0.0.1:33418/callback'

export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** The app token: HKDF-SHA256 (info "insulin-apps:app-token") to an HMAC key, the app's name signed, base64url. */
export function appToken(secretKeyBase64, app) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secretKeyBase64, 'base64'), Buffer.alloc(0), 'insulin-apps:app-token', 32))
  return createHmac('sha256', key).update(app).digest('base64url')
}

export async function json(client, url, body, headers = {}) {
  const response = await client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { ...response, json: response.text ? JSON.parse(response.text) : null }
}

export async function form(client, url, fields, headers = {}) {
  const response = await client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() })
  return { ...response, json: response.text && response.headers.get('content-type')?.includes('json') ? JSON.parse(response.text) : null }
}

export async function registerClient(h, { redirectUris = [LOOPBACK], name = 'Test Agent' } = {}) {
  const response = await json(h.client(), h.url('apex', '/oauth/register'), { client_name: name, redirect_uris: redirectUris })
  assert.equal(response.status, 201, response.text)
  return response.json
}

export function authorizeUrl(h, { client, redirectUri = LOOPBACK, challenge, state = 'state-1', resource = h.url('captable', '/mcp'), extra = {} }) {
  const params = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource, ...extra,
  })
  return h.url('apex', `/oauth/authorize?${params}`)
}

function unescapeHtml(text) {
  return text.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** Opens the consent page as `person`; returns the page and its request token. */
export async function openConsent(person, url) {
  const page = await person.client.get(url)
  assert.equal(page.status, 200, page.text.slice(0, 500))
  const token = /name="request" value="(ia_rq_[A-Za-z0-9_-]{43})"/.exec(page.text)?.[1]
  assert.ok(token, 'the consent page carries the request')
  return { page, token }
}

/** Answers the consent page; returns where the browser is sent next (the continue page's meta refresh). */
export async function decide(h, person, token, { decision = 'allow', orgId } = {}) {
  const response = await person.client.post(h.url('apex', '/oauth/authorize/decision'), { request: token, decision, ...(orgId ? { org_id: orgId } : {}) })
  const refresh = /<meta http-equiv="refresh" content="0; url=([^"]+)"/.exec(response.text)?.[1]
  return { response, target: refresh ? new URL(unescapeHtml(refresh)) : null }
}

/** The whole flow as an MCP client would run it, for `person` in `orgId`: tokens for the app's MCP server. */
export async function connect(h, person, orgId, { app = 'captable', name = 'Test Agent' } = {}) {
  const client = await registerClient(h, { name })
  const { verifier, challenge } = pkce()
  const { token } = await openConsent(person, authorizeUrl(h, { client, challenge, resource: h.url(app, '/mcp') }))
  const { target } = await decide(h, person, token, { orgId })
  assert.ok(target, 'sent back to the client')
  const code = target.searchParams.get('code')
  assert.ok(code, target.href)
  const exchanged = await form(h.client(), h.url('apex', '/oauth/token'), {
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: LOOPBACK,
  })
  assert.equal(exchanged.status, 200, exchanged.text)
  return { client, ...exchanged.json }
}

/** One JSON-RPC call to an app's MCP server with a token. */
export async function rpc(h, accessToken, method, params, { app = 'captable', id = 1 } = {}) {
  const response = await json(h.client(), h.url(app, '/mcp'), { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, {
    Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream',
  })
  return response
}

/** A tools/call's structured result. */
export async function tool(h, accessToken, name, args = {}, options = {}) {
  const response = await rpc(h, accessToken, 'tools/call', { name, arguments: args }, options)
  assert.equal(response.status, 200, response.text)
  return response.json.result
}
