// App hosts: what reaches the app (identity headers, never spoofed ones or the session cookie), what comes back
// (no gateway cookies, the account bar on HTML only, HSTS), and the /__insulin/* endpoints the account bar uses.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { NAVIGATE, UUID_RE, startGateway } from './helpers/harness.mjs'

let h
let production
let limited
before(async () => {
  ;[h, production, limited] = await Promise.all([
    startGateway(),
    startGateway({ mode: 'production' }),
    startGateway({ appLimit: 5 }),
  ])
})
after(async () => { await Promise.all([h?.close(), production?.close(), limited?.close()]) })

async function member(harness = h, options = {}) {
  const person = await harness.user(options)
  person.orgId = await harness.org(person.client, options.org ?? 'Proxy Org')
  return person
}

const echo = async (client, path = '/api/echo', init) => {
  const response = await client.get(h.url('captable', path), init)
  return JSON.parse(response.text)
}

test('signed out: navigations go to sign-in with return_to, API calls and other methods get 401 JSON', async () => {
  const client = h.client()
  const target = h.url('captable', '/companies/abc?tab=ledger')
  const page = await client.raw(target, { headers: NAVIGATE })
  assert.equal(page.status, 302)
  assert.equal(page.location, h.url('auth', `/login?return_to=${encodeURIComponent(target)}`))
  assert.equal((await client.raw(target, { method: 'HEAD', headers: NAVIGATE })).status, 302)
  for (const [path, method] of [['/api/me', 'GET'], ['/companies', 'POST'], ['/api/orgs', 'PUT']]) {
    const response = await client.request(h.url('captable', path), { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })
    assert.equal(response.status, 401, `${method} ${path}`)
    assert.deepEqual(JSON.parse(response.text), { error: 'unauthorized' })
  }
})

test('the app receives exactly the console identity headers', async () => {
  const person = await member(h, { name: 'Zoë O\'Brien & Co', org: 'Identity Org' })
  const received = await echo(person.client, '/api/echo?x=1')
  assert.equal(received.url, h.url('captable', '/api/echo?x=1'))
  assert.equal(received.headers['x-suger-user-id'], person.id)
  assert.equal(received.headers['x-suger-organization-id'], person.orgId)
  assert.match(received.headers['x-suger-user-id'], UUID_RE, 'user ids are UUIDs')
  assert.match(received.headers['x-suger-organization-id'], UUID_RE, 'organization ids are UUIDs')
  assert.ok(received.headers['x-suger-organization-id'].length <= 128)
  assert.equal(received.headers['x-suger-app-id'], 'insulin-apps-captable')
  assert.equal(received.headers['x-suger-app-role'], 'OWNER')
  assert.equal(received.headers['x-suger-user-email'], encodeURIComponent(person.email))
  assert.equal(received.headers['x-suger-user-name'], encodeURIComponent('Zoë O\'Brien & Co'))
  assert.equal(decodeURIComponent(received.headers['x-suger-user-name']), 'Zoë O\'Brien & Co')
})

test('header spoofing: x-suger-* headers from the browser never reach the app, in any case', async () => {
  const person = await member()
  const received = await echo(person.client, '/api/echo', {
    headers: {
      'X-Suger-User-Id': 'usr_spoofed', 'x-suger-organization-id': 'org_spoofed', 'X-SUGER-APP-ROLE': 'OWNER',
      'x-Suger-App-Id': 'evil', 'x-suger-user-email': 'boss%40example.test', 'X-Suger-Extra': 'smuggled',
    },
  })
  assert.equal(received.headers['x-suger-user-id'], person.id)
  assert.equal(received.headers['x-suger-organization-id'], person.orgId)
  assert.equal(received.headers['x-suger-app-id'], 'insulin-apps-captable')
  assert.equal(received.headers['x-suger-user-email'], encodeURIComponent(person.email))
  assert.equal(received.headers['x-suger-extra'], undefined)
  const anonymous = await h.client().get(h.url('captable', '/api/echo'), { headers: { 'x-suger-user-id': 'usr_x', 'x-suger-organization-id': 'org_x', 'x-suger-app-id': 'a', 'x-suger-app-role': 'OWNER' } })
  assert.equal(anonymous.status, 401, 'spoofed identity without a session gets nowhere')
})

test('cookie stripping: the session cookie never reaches the app, other cookies do', async () => {
  const person = await member()
  assert.equal((await echo(person.client)).cookie, null, 'only the session cookie: no Cookie header at all')
  const session = person.client.jar.get('insulin_session').value
  const received = await echo(person.client, '/api/echo', { headers: { Cookie: `app_pref=dark; insulin_session=${session}; INSULIN_SESSION=x; theme=2` } })
  assert.equal(received.cookie, 'app_pref=dark; theme=2')
  assert.ok(!JSON.stringify(received).includes(session))
})

test('the app cannot set the gateway\'s cookies; its own cookies pass through', async () => {
  const person = await member()
  const response = await person.client.get(h.url('captable', '/set-cookies'))
  assert.equal(response.status, 200)
  assert.deepEqual(response.cookies, ['app_pref=dark; Path=/; SameSite=Lax'])
  assert.ok(person.client.jar.get('insulin_session').value.length === 43, 'the session survives')
})

test('HTML responses get the account bar before </body>; nothing else is touched', async () => {
  const person = await member()
  const page = await person.client.get(h.url('captable', '/'))
  assert.match(page.headers.get('content-type'), /^text\/html/)
  assert.match(page.text, /<script src="\/__insulin\/bar\.js" defer><\/script><\/body>/)
  assert.equal(page.text.match(/__insulin\/bar\.js/g).length, 1)
  const json = await person.client.get(h.url('captable', '/data.json'))
  assert.equal(json.text, JSON.stringify({ html: '<body>not a page</body>' }))
  const css = await person.client.get(h.url('captable', '/style.css'))
  assert.equal(css.text, 'body { color: rebeccapurple; }\n')
  const bodyless = await person.client.get(h.url('captable', '/no-body'))
  assert.equal(bodyless.text, '<!doctype html><title>No body element</title><p>text</p>')
  const head = await person.client.request(h.url('captable', '/'), { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
})

test('the app\'s own headers pass through: its CSP is untouched and the bar still lands under it', async () => {
  const person = await member()
  const page = await person.client.get(h.url('captable', '/csp'))
  assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'")
  assert.match(page.text, /<script src="\/__insulin\/bar\.js" defer><\/script><\/body>/)
})

test('redirects from the app pass through unfollowed', async () => {
  const person = await member()
  const response = await person.client.get(h.url('captable', '/redirect'))
  assert.equal(response.status, 302)
  assert.equal(response.location, '/elsewhere')
})

test('uploads stream through to the app byte for byte', async () => {
  const person = await member()
  const bytes = randomBytes(3 * 1024 * 1024)
  const response = await person.client.request(h.url('captable', '/upload'), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
  const received = JSON.parse(response.text)
  assert.equal(received.method, 'POST')
  assert.equal(received.body.bytes, bytes.length)
  assert.equal(received.body.sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('over https, responses get HSTS unless the app set its own; the session cookie is Secure', async () => {
  const person = await member(production)
  const cookie = person.client.jar.get('insulin_session')
  assert.equal(cookie.secure, true)
  assert.equal(cookie.domain, 'example.test')
  const page = await person.client.get(production.url('captable', '/'))
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains')
  const own = await person.client.get(production.url('captable', '/own-hsts'))
  assert.equal(own.headers.get('strict-transport-security'), 'max-age=60')
  const local = await (await member()).client.get(h.url('captable', '/'))
  assert.equal(local.headers.get('strict-transport-security'), null, 'not over http')
})

test('RL_APP limits each user\'s app requests', async () => {
  const person = await member(limited)
  const statuses = []
  for (let i = 0; i < 7; i += 1) statuses.push((await person.client.get(limited.url('captable', '/api/echo'))).status)
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200])
  const over = await person.client.get(limited.url('captable', '/api/echo'))
  assert.equal(over.status, 429)
  assert.deepEqual(JSON.parse(over.text), { error: 'rate_limited' })
  assert.equal((await person.client.get(limited.url('captable', '/'))).status, 429)
  const other = await member(limited)
  assert.equal((await other.client.get(limited.url('captable', '/api/echo'))).status, 200, 'per user')
})

test('unknown hosts are 404, an app without a deployed Worker is 503, and /__insulin/ is never forwarded', async () => {
  const person = await member()
  const unknown = await person.client.get(`http://nope.${h.domain}/`)
  assert.equal(unknown.status, 404)
  assert.match(unknown.text, /There&#x27;s no app at this address/)
  const missing = await person.client.get(h.url('ledger', '/'))
  assert.equal(missing.status, 503)
  assert.equal((await person.client.get(h.url('ledger', '/api/x'))).status, 503)
  const reserved = await person.client.get(h.url('captable', '/__insulin/anything'))
  assert.equal(reserved.status, 404)
  assert.doesNotMatch(reserved.text, /Stub app/)
  const bar = await person.client.get(h.url('captable', '/__insulin/bar.js'))
  assert.equal(bar.status, 200)
  assert.match(bar.headers.get('content-type'), /^text\/javascript/)
})

test('a signed-in user without an organization is sent to create one', async () => {
  const { client } = await h.user()
  const page = await client.raw(h.url('captable', '/x'), { headers: NAVIGATE })
  assert.equal(page.status, 302)
  assert.equal(page.location, h.url('auth', `/orgs/new?return_to=${encodeURIComponent(h.url('captable', '/x'))}`))
  const api = await client.get(h.url('captable', '/api/me'))
  assert.equal(api.status, 403)
  assert.deepEqual(JSON.parse(api.text), { error: 'no_organization' })
})

test('/__insulin/me tells the account bar who is signed in and where things are', async () => {
  assert.equal((await h.client().get(h.url('captable', '/__insulin/me'))).status, 401)
  const person = await member(h, { name: 'Bar User', org: 'Bar Org' })
  const second = await h.org(person.client, 'Second Bar Org')
  await person.client.post(h.url('auth', '/orgs/switch'), { org_id: person.orgId })
  const response = await person.client.get(h.url('captable', '/__insulin/me'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const me = JSON.parse(response.text)
  assert.deepEqual(me.user, { name: 'Bar User', email: person.email })
  assert.deepEqual(me.organization, { id: person.orgId, name: 'Bar Org', role: 'OWNER', roleLabel: 'Owner' })
  assert.deepEqual(me.organizations.map((org) => [org.id, org.active]), [[person.orgId, true], [second, false]])
  assert.equal(me.links.members, h.url('auth', `/orgs/${person.orgId}`))
  assert.equal(me.links.apps, h.url('apex', '/'))
  assert.equal(me.links.account, h.url('auth', '/account'))
})

test('/__insulin/switch-org takes JSON or a form from the same host only', async () => {
  const person = await member()
  const other = await h.org(person.client, 'Switch Target')
  const own = new URL(h.url('captable')).origin
  const json = (orgId, origin = own) => person.client.post(h.url('captable', '/__insulin/switch-org'), {}, {
    origin, contentType: 'application/json', body: JSON.stringify({ orgId }), headers: { Accept: 'application/json' },
  })
  assert.equal((await json(person.orgId, h.url('auth').replace(/\/$/, ''))).status, 403, 'another host of the site')
  assert.equal((await json(person.orgId, 'http://evil.example')).status, 403)
  assert.equal((await json(person.orgId, null)).status, 403, 'no Origin')
  const plain = await person.client.post(h.url('captable', '/__insulin/switch-org'), {}, { contentType: 'text/plain', body: 'org_id=x' })
  assert.equal(plain.status, 415)
  const switched = await json(person.orgId)
  assert.equal(switched.status, 200)
  assert.equal(JSON.parse(switched.text).organization.id, person.orgId)
  assert.equal((await echo(person.client))['headers']['x-suger-organization-id'], person.orgId)
  const form = await person.client.post(h.url('captable', '/__insulin/switch-org'), { org_id: other })
  assert.equal(form.status, 303)
  assert.equal(form.location, '/')
  assert.equal((await echo(person.client))['headers']['x-suger-organization-id'], other)
})

test('/__insulin/logout signs out from an app page and says where to go next', async () => {
  const person = await member()
  const own = new URL(h.url('captable')).origin
  assert.equal((await person.client.post(h.url('captable', '/__insulin/logout'), {}, { origin: 'http://evil.example' })).status, 403)
  const out = await person.client.post(h.url('captable', '/__insulin/logout'), {}, { origin: own, headers: { Accept: 'application/json' } })
  assert.equal(out.status, 200)
  assert.deepEqual(JSON.parse(out.text), { ok: true, next: h.url('apex', '/') })
  assert.ok(out.cookies.some((line) => /^insulin_session=; Domain=insulinapps\.localhost; Path=\/; Max-Age=0/.test(line)))
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', person.id))[0].n, 0)
  assert.equal((await person.client.get(h.url('captable', '/api/echo'))).status, 401)
})

test('the account bar is CSP-friendly: same-origin script, shadow DOM, a linked stylesheet, no inline styles or HTML strings', async () => {
  const js = (await h.client().get(h.url('captable', '/__insulin/bar.js'))).text
  assert.match(js, /attachShadow\(\{ mode: 'closed' \}\)/)
  assert.match(js, /\/__insulin\/bar\.css/)
  for (const forbidden of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\.style\b/, /setAttribute\('style'/, /style=/, /<style/, /eval\(/, /new Function/]) {
    assert.doesNotMatch(js, forbidden)
  }
  assert.match(js, /fetch\('\/__insulin\/me'/)
  assert.match(js, /location\.assign/)
  const css = await h.client().get(h.url('captable', '/__insulin/bar.css'))
  assert.match(css.headers.get('content-type'), /^text\/css/)
  assert.match(css.text, /:host\(\[hidden\]\)/)
  assert.match(css.text, /prefers-color-scheme: dark/)
})

test('review 11: only real navigations are sent to sign in; fetches, assets and clients not asking for HTML get 401', async () => {
  const client = h.client()
  const target = h.url('captable', '/companies')
  assert.equal((await client.raw(target, { headers: NAVIGATE })).status, 302, 'a browser navigation')
  assert.equal((await client.raw(target, { headers: { Accept: 'text/html' } })).status, 302, 'no fetch metadata, asks for HTML')
  for (const headers of [
    { 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' },
    { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script', Accept: '*/*' },
    { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', Accept: 'image/avif,image/webp' },
    { Accept: '*/*' },
    {},
  ]) {
    const response = await client.raw(target, { headers })
    assert.equal(response.status, 401, JSON.stringify(headers))
    assert.deepEqual(JSON.parse(response.text), { error: 'unauthorized' })
  }
  assert.equal((await client.get(h.url('captable', '/assets/app.js'))).status, 401, 'fetch() from Node sends Sec-Fetch-Mode: cors')
})
