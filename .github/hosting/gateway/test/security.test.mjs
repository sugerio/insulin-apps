// Origin and content-type checks, security headers, return_to, rate limits, Turnstile, e-mail caps, logs, the
// development mail page, the www and https redirects, and failing closed without configuration.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, TOKENS, siteverify, startGateway, uniqueEmail, uniqueIp } from './helpers/harness.mjs'

const PAGE_CSP = "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

let h
let production
let limited
before(async () => {
  ;[h, production, limited] = await Promise.all([
    startGateway(),
    startGateway({ mode: 'production' }),
    startGateway({ authLimit: 3 }),
  ])
})
after(async () => { await Promise.all([h?.close(), production?.close(), limited?.close()]) })

test('auth POSTs need this host\'s own Origin: foreign, missing, null and cross-site requests get 403', async () => {
  const { email } = await h.user()
  const login = h.url('auth', '/login')
  const fields = { email, password: PASSWORD, 'cf-turnstile-response': TOKENS.login }
  for (const [origin, headers, why] of [
    ['http://evil.example', {}, 'foreign origin'],
    [null, {}, 'no Origin'],
    ['null', {}, 'opaque origin'],
    [h.url('apex').replace(/\/$/, ''), {}, 'another host of the site'],
    [h.url('auth').replace(/\/$/, ''), { 'Sec-Fetch-Site': 'cross-site' }, 'browser says cross-site'],
  ]) {
    const response = await h.client().post(login, fields, { origin, headers })
    assert.equal(response.status, 403, why)
    assert.equal(response.cookies.length, 0, why)
  }
  const { client, id } = await h.user()
  assert.equal((await client.post(h.url('auth', '/orgs/new'), { name: 'Forged' }, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await client.post(h.url('auth', '/logout'), {}, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM orgs WHERE created_by = ?1', id))[0].n, 0)
  assert.equal((await h.client().post(login, fields, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 303)
})

test('auth POSTs take small url-encoded forms only', async () => {
  const login = h.url('auth', '/login')
  assert.equal((await h.client().post(login, {}, { contentType: 'application/json', body: '{"email":"a@example.test"}' })).status, 415)
  assert.equal((await h.client().post(login, {}, { contentType: 'multipart/form-data; boundary=x', body: '--x--' })).status, 415)
  assert.equal((await h.client().post(login, {}, { contentType: null, body: 'email=a' })).status, 415)
  assert.equal((await h.client().post(login, { email: 'x'.repeat(17 * 1024) })).status, 413)
})

test('pages carry the strict CSP and the other security headers; only the apex pages may be indexed', async () => {
  const client = production.client()
  for (const path of ['/login', '/signup', '/forgot-password']) {
    const page = await client.get(production.url('auth', path))
    assert.equal(page.headers.get('content-security-policy'), PAGE_CSP)
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin')
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(page.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains')
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.equal(page.headers.get('x-robots-tag'), 'noindex')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.doesNotMatch(page.text, /<script>|<style|style="| on[a-z]+="/, `${path}: no inline scripts, styles or handlers`)
  }
  for (const path of ['/', '/privacy', '/terms']) {
    const page = await client.get(production.url('apex', path))
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('x-robots-tag'), null, `${path} is indexable`)
    assert.equal(page.headers.get('content-security-policy'), PAGE_CSP)
  }
  const me = await client.get(production.url('auth', '/__insulin/me'))
  assert.equal(me.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(me.headers.get('cache-control'), 'no-store')
  assert.match((await client.get(production.url('auth', '/signup'))).text, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer><\/script>/)
  assert.doesNotMatch((await client.get(production.url('apex', '/terms'))).text, /challenges\.cloudflare\.com/, 'Turnstile only where a form needs it')
})

test('return_to pointing anywhere but the site is ignored', async () => {
  const { email } = await h.user()
  const page = await h.client().get(h.url('auth', `/login?return_to=${encodeURIComponent('https://evil.example/phish')}`))
  assert.doesNotMatch(page.text, /evil\.example/)
  for (const bad of ['https://evil.example/', 'http://user:pw@captable.insulinapps.localhost/', 'https://captable.insulinapps.localhost/', '//evil.example', 'javascript:alert(1)']) {
    const signedIn = await h.signIn(h.client(), { email, returnTo: bad })
    assert.equal(signedIn.status, 303, bad)
    assert.equal(signedIn.location, h.url('auth', '/'), bad)
  }
  const good = await h.signIn(h.client(), { email, returnTo: h.url('apex', '/') })
  assert.match(good.text, /url=http:\/\/insulinapps\.localhost\//)
})

test('RL_AUTH: per IP and per email address', async () => {
  const ip = uniqueIp()
  const statuses = []
  for (let i = 0; i < 4; i += 1) statuses.push((await limited.signIn(limited.client({ ip }), { email: uniqueEmail('rl-ip'), password: 'wrong password!' })).status)
  assert.deepEqual(statuses, [401, 401, 401, 429])
  const email = uniqueEmail('rl-email')
  const byEmail = []
  for (let i = 0; i < 4; i += 1) byEmail.push((await limited.signIn(limited.client(), { email, password: 'wrong password!' })).status)
  assert.deepEqual(byEmail, [401, 401, 401, 429], 'a new IP each time, the same address')
  const page = await limited.signIn(limited.client({ ip }), { email: uniqueEmail('rl-page') })
  assert.match(page.text, /Too many attempts/)
  const googleIp = uniqueIp()
  const starts = []
  for (let i = 0; i < 4; i += 1) starts.push((await limited.client({ ip: googleIp }).get(limited.url('auth', '/auth/google/start'))).status)
  assert.deepEqual(starts, [302, 302, 302, 429], 'Google start has its own per-IP counter')
})

test('Turnstile: outside SITE_ENV=test the token must be for the auth host', async () => {
  production.outbound.turnstile = () => ({ success: true, hostname: 'evil.example', action: 'signup' })
  const wrongHost = await production.signUp(production.client(), { email: uniqueEmail('host') })
  assert.equal(wrongHost.status, 400)
  production.outbound.turnstile = siteverify
  assert.equal((await production.signUp(production.client(), { email: uniqueEmail('host-ok') })).status, 200)
  h.outbound.turnstile = () => ({ success: true, hostname: 'example.com', action: 'signup' })
  assert.equal((await h.signUp(h.client(), { email: uniqueEmail('test-host') })).status, 200, 'test keys answer example.com')
  h.outbound.turnstile = siteverify
  production.outbound.turnstile = () => new Response('unavailable', { status: 503 })
  assert.equal((await production.signUp(production.client(), { email: uniqueEmail('down') })).status, 400, 'fails closed')
  production.outbound.turnstile = siteverify
})

test('Cloudflare\'s dummy Turnstile secret is answered locally only when SITE_ENV=test', async () => {
  const dummy = '1x0000000000000000000000000000000AA'
  const [local, deployed] = await Promise.all([
    startGateway({ vars: { TURNSTILE_SECRET_KEY: dummy } }),
    startGateway({ mode: 'production', vars: { TURNSTILE_SECRET_KEY: dummy } }),
  ])
  try {
    assert.equal((await local.signUp(local.client(), { email: uniqueEmail('dummy'), turnstile: 'XXXX.DUMMY.TOKEN.XXXX' })).status, 200)
    assert.equal((await local.signUp(local.client(), { email: uniqueEmail('dummy-bad'), turnstile: 'something else' })).status, 400)
    assert.equal(local.outbound.to('https://challenges.cloudflare.com').length, 0, 'no network call')
    await deployed.signUp(deployed.client(), { email: uniqueEmail('dummy-prod'), turnstile: 'XXXX.DUMMY.TOKEN.XXXX' })
    assert.equal(deployed.outbound.to('https://challenges.cloudflare.com').length, 1, 'production always asks siteverify')
  } finally {
    await Promise.all([local.close(), deployed.close()])
  }
})

test('at most 5 emails per recipient per hour, without changing the answer', async () => {
  const { email } = await h.user()
  const pages = []
  for (let i = 0; i < 7; i += 1) pages.push(await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot }))
  for (const page of pages) assert.equal(page.text, pages[0].text)
  await h.waitForMail(email, 5)
  await new Promise((accept) => setTimeout(accept, 300))
  assert.equal((await h.mails(email)).length, 5, 'the confirmation plus four resets; the rest were capped')
  assert.match(h.logText(), /"event":"mail_capped"/)
})

test('logs carry event names and ids, never addresses, passwords, tokens or cookies', async () => {
  const email = uniqueEmail('log-check')
  const client = h.client()
  await h.signUp(client, { email, password: 'a password for logs' })
  const link = await h.link(email, '/verify-email')
  await h.confirm(client, email)
  await h.signIn(h.client(), { email, password: 'wrong password!!' })
  const text = h.logText()
  assert.match(text, /"event":"email_verified"/)
  assert.ok(!text.includes(email), 'no address')
  assert.ok(!text.includes('a password for logs'), 'no password')
  assert.ok(!text.includes(new URL(link).searchParams.get('token')), 'no token')
  assert.ok(!text.includes(client.jar.get('insulin_session').value), 'no session cookie')
  assert.doesNotMatch(text, /@example\.test/)
})

test('the captured-mail page exists only for SITE_ENV=test on *.localhost', async () => {
  const page = await h.client().get(h.url('auth', '/__insulin/dev/mail'))
  assert.equal(page.status, 200)
  assert.match(page.text, /Captured mail/)
  const json = await h.client().get(h.url('apex', '/__insulin/dev/mail?format=json'))
  assert.ok(Array.isArray(JSON.parse(json.text).mails))
  assert.equal((await production.client().get(production.url('auth', '/__insulin/dev/mail'))).status, 404)
})

test('www redirects to the apex with the same path and query, and never touches sessions or apps', async () => {
  const { client, id } = await h.user()
  const old = Date.now() - 2 * 60 * 60 * 1000
  await h.sql('UPDATE sessions SET last_seen_at = ?1 WHERE user_id = ?2', old, id)
  const local = await client.get(`http://www.${h.domain}:8787/companies/x?tab=1&q=a%20b`, { headers: { Cookie: client.jar.header(new URL(h.url('apex'))) } })
  assert.equal(local.status, 301)
  assert.equal(local.location, `http://${h.domain}:8787/companies/x?tab=1&q=a%20b`)
  assert.equal(local.cookies.length, 0)
  assert.equal((await h.sql('SELECT last_seen_at FROM sessions WHERE user_id = ?1', id))[0].last_seen_at, old, 'the session was not even read')
  const deployed = await production.client().get('https://www.example.test/terms?x=1')
  assert.equal(deployed.status, 301)
  assert.equal(deployed.location, 'https://example.test/terms?x=1')
  assert.equal(deployed.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains')
  assert.equal((await production.client().get('http://www.example.test/a')).location, 'https://example.test/a', 'one hop from http too')
  assert.equal((await production.client().request('https://www.example.test/__insulin/me', { method: 'POST' })).status, 301)
})

test('production answers only over https: plain http redirects (GET) or is refused', async () => {
  const get = await production.client().get('http://auth.example.test/login?x=1')
  assert.equal(get.status, 301)
  assert.equal(get.location, 'https://auth.example.test/login?x=1')
  const post = await production.client().post('http://auth.example.test/login', { email: 'a@example.test' })
  assert.equal(post.status, 400)
  assert.equal((await production.client().get('https://elsewhere.example/')).status, 404, 'a host outside the site')
})

test('without required configuration every host answers 503 and redirects nowhere; the stylesheet still loads', async () => {
  for (const options of [
    { vars: { TURNSTILE_SECRET_KEY: undefined } },
    { vars: { GOOGLE_CLIENT_SECRET: undefined } },
    { vars: { SITE_APPS: '{"not": "a list"}' } },
    { mode: 'production', omit: ['EMAIL'] },
    { omit: ['DB'] },
    { omit: ['RL_APP'] },
  ]) {
    const broken = await startGateway(options)
    try {
      for (const site of ['apex', 'auth', 'captable']) {
        const response = await broken.client().get(broken.url(site, '/'))
        assert.equal(response.status, 503, `${JSON.stringify(options)} ${site}`)
        assert.equal(response.location, null)
        assert.match(response.text, /not configured yet/)
      }
      assert.equal((await broken.client().post(broken.url('auth', '/login'), { email: 'a@example.test' })).status, 503)
      const css = await broken.client().get(broken.url('auth', '/__insulin/gateway.css'))
      assert.equal(css.status, 200)
      assert.match(broken.logText(), /"event":"config_invalid"/)
    } finally {
      await broken.close()
    }
  }
})

test('review 7: SITE_ENV anywhere but a .localhost domain is a configuration error', async () => {
  for (const options of [
    { mode: 'test', vars: { SITE_DOMAIN: 'example.test' } },
    { mode: 'production', vars: { SITE_ENV: 'test' } },
    { mode: 'production', vars: { SITE_ENV: 'staging' } },
  ]) {
    const broken = await startGateway(options)
    try {
      for (const site of ['apex', 'auth', 'captable']) {
        const response = await broken.client().get(broken.url(site, '/'))
        assert.equal(response.status, 503, `${JSON.stringify(options)} ${site}`)
        assert.match(response.text, /not configured yet/)
      }
      assert.match(broken.logText(), /"problems":"[^"]*SITE_ENV/)
      assert.equal((await broken.client().get(broken.url('auth', '/__insulin/dev/mail'))).status, 503, 'no captured mail either')
    } finally {
      await broken.close()
    }
  }
})

test('review 9: each form\'s Turnstile widget carries its own action, and a token works only for that form', async () => {
  const pages = { '/signup': 'signup', '/login': 'login', '/resend-verification': 'resend', '/forgot-password': 'forgot' }
  for (const [path, action] of Object.entries(pages)) {
    const page = await h.client().get(h.url('auth', path))
    assert.match(page.text, new RegExp(`class="cf-turnstile"[^>]*data-action="${action}"`), path)
  }
  const pending = uniqueEmail('confirm-first')
  await h.signUp(h.client(), { email: pending })
  assert.match((await h.signIn(h.client(), { email: pending })).text, /data-action="resend"/, 'the resend form under "Confirm your email first"')

  const { email } = await h.user()
  assert.equal((await h.signUp(h.client(), { email: uniqueEmail('wrong-action'), turnstile: TOKENS.login })).status, 400, 'a login token on sign-up')
  assert.equal((await h.signIn(h.client(), { email, turnstile: TOKENS.signup })).status, 400, 'a sign-up token on sign-in')
  assert.equal((await h.client().post(h.url('auth', '/resend-verification'), { email, 'cf-turnstile-response': TOKENS.forgot })).status, 400)
  assert.equal((await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.resend })).status, 400)
  assert.equal((await h.signIn(h.client(), { email })).status, 303, 'the right action passes')
  assert.match(h.logText(), /"event":"turnstile_wrong_action","expected":"signup"/)
})

test('review 12: every response gets HSTS over https and the common headers, assets and redirects included; http assets upgrade', async () => {
  const client = production.client()
  const responses = [
    await client.get(production.url('auth', '/__insulin/gateway.css')),
    await client.get(production.url('captable', '/__insulin/bar.js')),
    await client.get(production.url('auth', '/__insulin/nope')),
    await client.get('https://www.example.test/x'),
    await client.get(production.url('auth', '/orgs/new')),
  ]
  for (const response of responses) {
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains', `${response.status}`)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin')
    assert.ok(response.headers.get('content-security-policy'))
  }
  const plain = await client.get('http://auth.example.test/__insulin/gateway.css')
  assert.equal(plain.status, 301)
  assert.equal(plain.location, 'https://auth.example.test/__insulin/gateway.css')
})

test('review 12 and 13: configuration errors and uncaught failures get the same headers; the log names the failure, not its message', async () => {
  const unconfigured = await startGateway({ mode: 'production', omit: ['RL_APP'] })
  try {
    const response = await unconfigured.client().get(unconfigured.url('auth', '/'))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await unconfigured.client().get('http://auth.example.test/__insulin/gateway.css')).status, 301, 'http upgrades before anything else')
  } finally {
    await unconfigured.close()
  }

  const failing = await startGateway({ mode: 'production' })
  try {
    // A broken database: any lookup of a session throws, and nothing catches it until index.ts.
    await failing.sql('DROP TABLE sessions')
    const response = await failing.client().get(failing.url('auth', '/'), { headers: { Cookie: `insulin_session=${'a'.repeat(43)}` } })
    assert.equal(response.status, 500)
    assert.match(response.text, /Something went wrong/)
    for (const [name, value] of [
      ['strict-transport-security', 'max-age=63072000; includeSubDomains'], ['x-content-type-options', 'nosniff'],
      ['referrer-policy', 'strict-origin'], ['cache-control', 'no-store'], ['x-frame-options', 'DENY'],
    ]) {
      assert.equal(response.headers.get(name), value, name)
    }
    const line = failing.logs.map((entry) => entry.message).find((message) => message.includes('"event":"unhandled_error"'))
    assert.ok(line, 'logged')
    assert.match(line, /"error":"Error"/)
    assert.match(line, /"kind":"D1_ERROR"/)
    assert.doesNotMatch(line, /no such table|sessions|message/, 'no exception message')
  } finally {
    await failing.close()
  }
})

test('review 13: housekeeping deletes expired sessions, spent links and old mail records, a bounded batch after each write', async () => {
  const { id } = await h.user()
  const now = Date.now()
  const old = now - 3 * 24 * 60 * 60 * 1000
  for (let i = 0; i < 250; i += 1) await h.sql("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES (?1, 'verify_email', NULL, ?2)", `old-${i}`, old)
  await h.sql("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES ('recent', 'verify_email', NULL, ?1)", now)
  for (let i = 0; i < 5; i += 1) {
    await h.sql('INSERT INTO sessions (id_hash, user_id, active_org_id, credential_version, created_at, last_seen_at, expires_at) VALUES (?1, ?2, NULL, 0, ?3, ?3, ?4)', `expired-session-${i}`, id, old, now - 1)
    await h.sql("INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?1, ?2, 'reset_password', 'gone@example.test', ?3, ?4)", `expired-token-${i}`, id, old, now - 1)
  }
  const oldRows = async () => (await h.sql('SELECT COUNT(*) AS n FROM mail_log WHERE created_at = ?1', old))[0].n
  const settle = async (predicate) => {
    for (let attempt = 0; attempt < 100 && !(await predicate()); attempt += 1) await new Promise((accept) => setTimeout(accept, 30))
  }
  await h.signIn(h.client(), { email: uniqueEmail('nobody-housekeeping'), password: 'not a real account' })
  await settle(async () => (await oldRows()) <= 50)
  assert.equal(await oldRows(), 50, 'at most 200 mail-log rows per run')
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM sessions WHERE id_hash LIKE 'expired-session-%'"))[0].n, 0)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM email_tokens WHERE token_hash LIKE 'expired-token-%'"))[0].n, 0)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM mail_log WHERE recipient_hash = 'recent'"))[0].n, 1, 'recent records stay')
  await h.signIn(h.client(), { email: uniqueEmail('nobody-housekeeping'), password: 'not a real account' })
  await settle(async () => (await oldRows()) === 0)
  assert.equal(await oldRows(), 0, 'the next write finishes the backlog')
})

test('review 13: with a cron trigger, the scheduled handler runs the same cleanup in larger batches', async () => {
  const old = Date.now() - 3 * 24 * 60 * 60 * 1000
  for (let i = 0; i < 300; i += 1) await h.sql("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES (?1, 'invitation', NULL, ?2)", `scheduled-${i}`, old)
  const worker = await h.mf.getWorker('gateway')
  const result = await worker.scheduled({ cron: '17 3 * * *' })
  assert.equal(result.outcome, 'ok')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await h.sql("SELECT COUNT(*) AS n FROM mail_log WHERE recipient_hash LIKE 'scheduled-%'"))[0].n === 0) break
    await new Promise((accept) => setTimeout(accept, 30))
  }
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM mail_log WHERE recipient_hash LIKE 'scheduled-%'"))[0].n, 0)
})
