// What apps can use beyond D1 (DESIGN.md §8): public paths for people without an account, and the mail relay.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { APPS, NAVIGATE, SECRET_KEY, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { appToken } from '../../../scripts/deploy-apps.mjs'

const PUBLIC_APPS = APPS.map((app) => (app.name === 'captable' ? { ...app, publicPaths: ['/sign', '/api/public/', '/assets/'] } : app))

let h
before(async () => { h = await startGateway({ apps: PUBLIC_APPS }) })
after(async () => { await h?.close() })

const BAR = '<script src="/__insulin/bar.js" defer></script>'

async function newOrg(harness) {
  const id = randomUUID()
  await harness.sql('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?1, ?2, 1, 1)', id, 'Relay Org')
  return id
}

function relay(harness, { token = appToken(SECRET_KEY, 'captable'), orgId, body, contentType = 'application/json', method = 'POST', site = 'apex' } = {}) {
  return harness.client().request(harness.url(site, '/__insulin/mail'), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'x-suger-organization-id': orgId } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  })
}

const message = (overrides = {}) => ({ to: uniqueEmail('signer'), subject: 'Your signing code', text: 'Your code is 123456.', ...overrides })

test('a public path is forwarded with no identity at all, whoever asks, and with no credential passed on', async () => {
  const anonymous = await h.client().get(h.url('captable', '/api/public/echo?x=1'), {
    headers: { 'x-suger-user-id': 'spoofed', 'x-suger-organization-id': 'spoofed', 'x-suger-app-role': 'ADMIN', Authorization: 'Bearer forged-token' },
  })
  assert.equal(anonymous.status, 200)
  const seen = JSON.parse(anonymous.text).headers
  assert.equal(seen['x-suger-access-via'], 'public')
  assert.equal(seen['x-suger-app-id'], 'insulin-apps-captable')
  for (const name of ['x-suger-user-id', 'x-suger-organization-id', 'x-suger-app-role', 'x-suger-app-permissions', 'x-suger-user-email', 'authorization']) {
    assert.equal(seen[name], undefined, name)
  }

  const person = await h.user()
  await h.org(person.client, 'Public Path Org')
  const signedIn = await person.client.get(h.url('captable', '/api/public/echo'), { headers: { Cookie: 'app_pref=dark' } })
  const forwarded = JSON.parse(signedIn.text)
  assert.equal(forwarded.headers['x-suger-access-via'], 'public', 'a signed-in person on a public path is nobody in particular')
  assert.equal(forwarded.headers['x-suger-user-id'], undefined)
  assert.doesNotMatch(forwarded.cookie ?? '', /insulin_session/, 'the session cookie never goes with it')
})

test('a public page keeps its own headers and gets no account bar; the paths around it still need a session', async () => {
  const page = await h.client().raw(h.url('captable', '/sign'), { headers: NAVIGATE })
  assert.equal(page.status, 200)
  assert.ok(!page.text.includes(BAR), 'no account bar where nobody is signed in')
  assert.equal(page.headers['content-security-policy'], 'frame-ancestors https://host.example.test', 'the app\'s frame-ancestors stay')
  assert.match(page.text, /&quot;x-suger-access-via&quot;:&quot;public&quot;/)

  assert.equal((await h.client().get(h.url('captable', '/sign/step-2'))).status, 200, 'below an entry without a slash')
  assert.equal((await h.client().get(h.url('captable', '/api/echo'))).status, 401, 'the rest of the API needs a session')
  assert.equal((await h.client().get(h.url('captable', '/signature'))).status, 401, 'a match is at a segment boundary')
  assert.equal((await h.client().get(h.url('captable', '/api/public'))).status, 401, 'an entry ending in / covers what is below it only')
  assert.equal((await h.client().get(h.url('captable', '/sign/%2e%2e/api/echo'))).status, 401, 'an encoded dot segment is never public')
  assert.equal((await h.client().get(h.url('captable', '/sign/a%2Fb'))).status, 401, 'nor an encoded slash')
})

test("the gateway's own paths win over an app's public paths", async () => {
  assert.equal((await h.client().get(h.url('captable', '/__insulin/me'))).status, 401)
  assert.equal((await h.client().get(h.url('captable', '/settings/users'))).status, 302)
  const mcp = await h.client().request(h.url('captable', '/mcp'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(mcp.status, 401)
  assert.match(mcp.headers.get('www-authenticate') ?? '', /resource_metadata/)
})

test('public paths are rate-limited per IP address', async () => {
  const limited = await startGateway({ apps: PUBLIC_APPS, appLimit: 2 })
  try {
    const client = limited.client()
    assert.equal((await client.get(limited.url('captable', '/api/public/echo'))).status, 200)
    assert.equal((await client.get(limited.url('captable', '/api/public/echo'))).status, 200)
    const third = await client.get(limited.url('captable', '/api/public/echo'))
    assert.equal(third.status, 429)
    assert.equal(third.headers.get('retry-after'), '60')
    assert.equal((await limited.client().get(limited.url('captable', '/api/public/echo'))).status, 200, 'another address has its own allowance')
  } finally {
    await limited.close()
  }
})

test('the mail relay takes one message from an app with its token, for an existing organization', async () => {
  const orgId = await newOrg(h)
  assert.equal((await relay(h, { token: null, orgId, body: message() })).status, 401)
  assert.equal((await relay(h, { token: 'not-the-token', orgId, body: message() })).status, 401)
  assert.equal((await relay(h, { token: appToken(Buffer.alloc(32, 1).toString('base64'), 'captable'), orgId, body: message() })).status, 401, "another key's token")
  assert.equal((await relay(h, { orgId: 'not-an-id', body: message() })).status, 400)
  const unknown = await relay(h, { orgId: randomUUID(), body: message() })
  assert.equal(unknown.status, 404)
  assert.deepEqual(JSON.parse(unknown.text), { error: 'unknown_organization' })
  for (const body of [message({ to: 'nobody' }), message({ subject: '' }), message({ subject: 'x'.repeat(201) }), message({ text: '' }),
    message({ text: 'x'.repeat(20_001) }), message({ html: 'x'.repeat(100_001) }), message({ replyTo: 'not an address' }), '{not json']) {
    const refused = await relay(h, { orgId, body })
    assert.equal(refused.status, 400, typeof body === 'string' ? body : JSON.stringify(body).slice(0, 60))
    assert.deepEqual(JSON.parse(refused.text), { error: 'invalid_request' })
  }
  assert.equal((await relay(h, { orgId, body: message(), contentType: 'text/plain' })).status, 400)
  assert.equal((await relay(h, { orgId, body: message(), method: 'GET' })).status, 405)
  assert.equal((await relay(h, { orgId, body: message(), site: 'captable' })).status, 404, 'the apex only')

  const sent = message({ html: '<p>Your code is <b>123456</b>.</p>' })
  const accepted = await relay(h, { orgId, body: sent })
  assert.equal(accepted.status, 202)
  assert.deepEqual(JSON.parse(accepted.text), { status: 'sent' })
  const [captured] = await h.mails(sent.to)
  assert.deepEqual({ subject: captured.subject, text: captured.text, html: captured.html }, { subject: sent.subject, text: sent.text, html: sent.html })
  const [logged] = await h.sql('SELECT kind, org_id FROM mail_log WHERE org_id = ?1', orgId)
  assert.deepEqual(logged, { kind: 'app:captable', org_id: orgId })
  assert.doesNotMatch(h.logText(), new RegExp(sent.to.replace(/[.+]/g, '\\$&')), 'logs never name the recipient')
})

test("the mail relay keeps to apps' per-recipient cap, apart from the gateway's own, and to the daily caps", async () => {
  const orgId = await newOrg(h)
  const to = uniqueEmail('capped')
  for (let i = 0; i < 10; i += 1) assert.equal((await relay(h, { orgId, body: message({ to }) })).status, 202)
  const capped = await relay(h, { orgId, body: message({ to }) })
  assert.equal(capped.status, 429)
  assert.deepEqual(JSON.parse(capped.text), { error: 'rate_limited' })
  // The gateway's own mail to that address isn't crowded out: a sign-up confirmation still goes.
  assert.equal((await h.signUp(h.client(), { email: to })).status, 200)
  assert.ok((await h.mails(to)).some((mail) => /verify-email/.test(mail.text)), "an app's mail never uses up room the gateway's own messages need")

  const busy = await newOrg(h)
  const now = Date.now()
  for (let i = 0; i < 500; i += 50) {
    const rows = Array.from({ length: 50 }, (_, j) => `('h${i + j}', 'app:captable', '${busy}', ${now - 1000})`).join(', ')
    await h.sql(`INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES ${rows}`)
  }
  assert.equal((await relay(h, { orgId: busy, body: message() })).status, 429, 'the daily cap for this organization and app')
  assert.equal((await relay(h, { orgId, body: message() })).status, 202, 'another organization has its own')

  const others = await newOrg(h)
  for (let i = 0; i < 5000; i += 250) {
    const rows = Array.from({ length: 250 }, (_, j) => `('g${i + j}', 'app:captable', 'org-${(i + j) % 40}', ${now - 1000})`).join(', ')
    await h.sql(`INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES ${rows}`)
  }
  assert.equal((await relay(h, { orgId: others, body: message() })).status, 429, 'the daily cap for the app across organizations')
  await h.sql("DELETE FROM mail_log WHERE recipient_hash LIKE 'g%'")
})

test('without GATEWAY_SECRET_KEY the relay says it is not set up', async () => {
  const unkeyed = await startGateway({ apps: PUBLIC_APPS, vars: { GATEWAY_SECRET_KEY: undefined } })
  try {
    const response = await relay(unkeyed, { orgId: await newOrg(unkeyed), body: message() })
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.text), { error: 'not_configured' })
  } finally {
    await unkeyed.close()
  }
})

test("in production the relay sends from the site's address, named after the app, with the app's reply-to", async () => {
  const production = await startGateway({ mode: 'production', apps: PUBLIC_APPS })
  try {
    const orgId = await newOrg(production)
    const sent = message({ replyTo: 'sender@example.test' })
    assert.equal((await relay(production, { orgId, body: sent })).status, 202)
    const [mail] = (await production.sentMail()).filter((entry) => entry.to === sent.to)
    assert.deepEqual(mail.from, { email: 'no-reply@example.test', name: 'Cap Table via Insulin Apps' })
    assert.equal(mail.replyTo, 'sender@example.test')
    assert.equal(mail.text, sent.text)
    assert.equal('html' in mail, false, 'no HTML part when the app sent none')
  } finally {
    await production.close()
  }
})
