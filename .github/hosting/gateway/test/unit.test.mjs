// Pure modules, imported straight from src/ (Node strips the TypeScript types).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkName, cleanText, normalizeEmail, passwordProblem } from '../src/validate.ts'
import { canChangeRole, canHandleInvitation, canRemoveMember, canSeeMembers, grantableRoles } from '../src/roles.ts'
import {
  base64url, constantTimeEqual, fromBase64url, hashPassword, isId, isToken, newId, randomToken, verifyPassword,
} from '../src/crypto.ts'
import { cookieValues, serializeCookie, setCookieName, withoutCookies } from '../src/http/cookies.ts'
import { bindingName, isAppName, issuesUrlFrom, parseSender, readConfig } from '../src/config.ts'
import { safeReturnTo } from '../src/http/return-to.ts'
import { createContext } from '../src/context.ts'
import { escapeHtml, html } from '../src/pages/html.ts'
import { checkIdToken, decodeJwtPayload } from '../src/auth/google.ts'
import { forwardRequest, isNavigation } from '../src/proxy.ts'
import { logError } from '../src/log.ts'

test('e-mail addresses are trimmed, lower-cased and shape-checked', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace@Example.TEST '), 'ada.lovelace@example.test')
  for (const bad of ['', 'no-at-sign', 'a@b', 'two@@example.test', 'space in@example.test', 'a\n@example.test', `${'a'.repeat(250)}@example.test`, 42, null]) {
    assert.equal(normalizeEmail(bad), null, String(bad))
  }
})

test('names lose control characters and bidirectional overrides, and are 1-100 characters', () => {
  assert.equal(cleanText('  Ada\u0000 ‮Lovelace\r\n '), 'Ada Lovelace')
  assert.deepEqual(checkName('Ada'), { name: 'Ada' })
  assert.ok('problem' in checkName('   '))
  assert.ok('problem' in checkName('x'.repeat(101)))
  assert.deepEqual(checkName('é'.repeat(100)), { name: 'é'.repeat(100) })
})

test('passwords are 10 to 200 characters, without composition rules', () => {
  assert.equal(passwordProblem('aaaaaaaaaa'), null)
  assert.match(passwordProblem('short'), /at least 10/)
  assert.match(passwordProblem('a'.repeat(201)), /at most 200/)
  assert.match(passwordProblem(''), /Enter a password/)
})

test('roles follow the console order and the ADMIN limits', () => {
  assert.deepEqual(grantableRoles('OWNER'), ['OWNER', 'ADMIN', 'EDITOR', 'USER', 'VIEWER'])
  assert.deepEqual(grantableRoles('ADMIN'), ['ADMIN', 'EDITOR', 'USER', 'VIEWER'])
  assert.deepEqual(grantableRoles('EDITOR'), [])
  assert.equal(canChangeRole('ADMIN', 'EDITOR', 'ADMIN'), true)
  assert.equal(canChangeRole('ADMIN', 'EDITOR', 'OWNER'), false, 'ADMIN cannot grant OWNER')
  assert.equal(canChangeRole('ADMIN', 'OWNER', 'ADMIN'), false, 'ADMIN cannot change an OWNER')
  assert.equal(canChangeRole('OWNER', 'OWNER', 'VIEWER'), true)
  assert.equal(canRemoveMember('ADMIN', 'OWNER'), false)
  assert.equal(canRemoveMember('ADMIN', 'ADMIN'), true)
  assert.equal(canRemoveMember('EDITOR', 'VIEWER'), false)
  assert.equal(canSeeMembers('EDITOR'), true)
  assert.equal(canSeeMembers('USER'), false)
  assert.equal(canHandleInvitation('ADMIN', 'OWNER'), false)
})

test('PBKDF2 hashes use the documented format and verify in constant time', async () => {
  const stored = await hashPassword('correct horse battery staple')
  assert.match(stored, /^pbkdf2_sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/)
  assert.equal(await verifyPassword('correct horse battery staple', stored), true)
  assert.equal(await verifyPassword('correct horse battery stapler', stored), false)
  assert.equal(await verifyPassword('anything at all', 'pbkdf2_sha256$999999$AAAA$AAAA'), false)
  assert.equal(await verifyPassword('anything at all', 'not a hash'), false)
  assert.notEqual(await hashPassword('same password!'), await hashPassword('same password!'), 'salted')
})

test('tokens and ids are random, well-formed and recognised', () => {
  const token = randomToken()
  assert.equal(token.length, 43)
  assert.ok(isToken(token))
  assert.equal(isToken(`${token}x`), false)
  assert.notEqual(randomToken(), token)
  const id = newId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a version 4 UUID')
  assert.ok(isId(id))
  assert.notEqual(newId(), id)
  assert.equal(isId(id.toUpperCase()), false)
  assert.equal(isId(`${id}x`), false)
  assert.equal(isId('org_x'), false)
  assert.deepEqual([...fromBase64url(base64url(new Uint8Array([0, 255, 62, 63])))], [0, 255, 62, 63])
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('abc', 'abd'), false)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
})

test('cookies: reading, stripping the session cookie, naming Set-Cookie headers', () => {
  const header = 'a=1; insulin_session=secret; b=2; INSULIN_SESSION=other; insulin_session=again'
  assert.deepEqual(cookieValues(header, 'insulin_session'), ['secret', 'again'])
  assert.equal(withoutCookies(header, new Set(['insulin_session'])), 'a=1; b=2')
  assert.equal(withoutCookies('insulin_session=x', new Set(['insulin_session'])), null)
  assert.equal(setCookieName(' Insulin_Session=x; Path=/'), 'insulin_session')
  assert.equal(serializeCookie('n', 'v', { domain: 'example.test', path: '/', maxAge: 60, secure: true, httpOnly: true, sameSite: 'Lax' }),
    'n=v; Domain=example.test; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax')
})

test('HTML is escaped unless it was built with the html tag', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  const name = '<img src=x onerror=alert(1)>'
  assert.equal(html`<p>${name}</p>`.value, '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.equal(html`<div>${html`<b>${name}</b>`}</div>`.value, '<div><b>&lt;img src=x onerror=alert(1)&gt;</b></div>')
  assert.equal(html`${['<i>', html`<i>`]}`.value, '&lt;i&gt;<i>')
})

test('configuration: app names, bindings, sender, and failing closed', () => {
  assert.ok(isAppName('captable'))
  assert.ok(isAppName('a'))
  assert.equal(isAppName('auth'), false)
  assert.equal(isAppName('-x'), false)
  assert.equal(isAppName('Captable'), false)
  assert.equal(bindingName('cap-table'), 'APP_CAP_TABLE')
  assert.deepEqual(parseSender('Insulin Apps <No-Reply@Example.test>'), { email: 'no-reply@example.test', name: 'Insulin Apps' })
  assert.deepEqual(parseSender('no-reply@example.test'), { email: 'no-reply@example.test', name: 'Insulin Apps' })
  assert.equal(parseSender('Broken <not an address>'), null)
  assert.equal(issuesUrlFrom([{ source: 'https://github.com/example/insulin-apps/tree/main/captable' }]), 'https://github.com/example/insulin-apps/issues')

  const binding = { prepare() {}, limit() {}, send() {}, fetch() {} }
  const env = {
    DB: binding, RL_AUTH: binding, RL_APP: binding, EMAIL: binding, APP_CAPTABLE: binding,
    SITE_DOMAIN: 'example.test', SITE_APPS: [{ name: 'captable', title: 'Cap Table', binding: 'APP_CAPTABLE' }],
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test',
  }
  const ok = readConfig(env)
  assert.equal(ok.ok, true)
  assert.equal(ok.config.apps[0].appId, 'insulin-apps-captable')
  assert.equal(ok.config.testMode, false)
  assert.equal(readConfig({ ...env, SITE_APPS: JSON.stringify(env.SITE_APPS) }).ok, true, 'SITE_APPS as a JSON string')
  for (const [change, problem] of [
    [{ SITE_DOMAIN: undefined }, 'SITE_DOMAIN'],
    [{ TURNSTILE_SECRET_KEY: '' }, 'TURNSTILE_SECRET_KEY'],
    [{ GOOGLE_CLIENT_ID: 'id' }, 'GOOGLE_CLIENT_SECRET'],
    [{ SITE_APPS: '[not json' }, 'SITE_APPS'],
    [{ SITE_APPS: [{ name: 'auth' }] }, 'SITE_APPS[0].name'],
    [{ SITE_APPS: [{ name: 'captable', binding: 'APP_OTHER' }] }, 'SITE_APPS[0].binding'],
    [{ EMAIL: undefined }, 'EMAIL'],
    [{ DB: undefined }, 'DB'],
    [{ EMAIL_FROM: 'nope' }, 'EMAIL_FROM'],
  ]) {
    const result = readConfig({ ...env, ...change })
    assert.equal(result.ok, false, problem)
    assert.ok(result.problems.some((entry) => entry.startsWith(problem)), `${problem}: ${result.problems}`)
  }
  const local = { ...env, SITE_DOMAIN: 'insulinapps.localhost', EMAIL: undefined, SITE_ENV: 'test' }
  assert.equal(readConfig(local).ok, true, 'test mode captures mail instead')
  assert.equal(readConfig(local).config.testMode, true)
  for (const [change, why] of [
    [{ SITE_ENV: 'test' }, 'test mode on a real domain'],
    [{ SITE_ENV: 'production' }, 'any other value'],
    [{ SITE_ENV: 'development', SITE_DOMAIN: 'insulinapps.localhost' }, 'not "test", even on localhost'],
  ]) {
    const result = readConfig({ ...env, ...change })
    assert.equal(result.ok, false, why)
    assert.ok(result.problems.some((problem) => problem.startsWith('SITE_ENV')), why)
  }
  assert.equal(readConfig({ ...env, SITE_ENV: '  ' }).ok, true, 'blank is unset')
})

function ctxFor(url, { testMode = false } = {}) {
  const binding = { prepare() {}, limit() {}, send() {}, fetch() {} }
  const result = readConfig({
    DB: binding, RL_AUTH: binding, RL_APP: binding, EMAIL: binding, APP_CAPTABLE: binding,
    SITE_DOMAIN: testMode ? 'insulinapps.localhost' : 'example.test', SITE_APPS: [{ name: 'captable' }],
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test', ...(testMode ? { SITE_ENV: 'test' } : {}),
  })
  return createContext(new Request(url), {}, { waitUntil() {} }, result.config)
}

test('return_to accepts only the site\'s own hosts, with the request\'s scheme and no credentials', () => {
  const ctx = ctxFor('https://auth.example.test/login')
  assert.equal(safeReturnTo(ctx, 'https://captable.example.test/companies?x=1'), 'https://captable.example.test/companies?x=1')
  assert.equal(safeReturnTo(ctx, 'https://example.test/'), 'https://example.test/')
  assert.equal(safeReturnTo(ctx, 'https://auth.example.test/invitations/x'), 'https://auth.example.test/invitations/x')
  for (const bad of [
    'https://evil.example/', 'http://captable.example.test/', 'https://user:pass@captable.example.test/', '/relative',
    '//evil.example/', 'javascript:alert(1)', 'https://captable.example.test.evil.example/', 'https://ledger.example.test/',
    'https://evil.example\\@captable.example.test/', 'https://captable.example.test:8443/', '',
  ]) {
    assert.equal(safeReturnTo(ctx, bad), null, bad)
  }
  const local = ctxFor('http://auth.insulinapps.localhost:8787/login', { testMode: true })
  assert.equal(safeReturnTo(local, 'http://captable.insulinapps.localhost:8787/'), 'http://captable.insulinapps.localhost:8787/')
  assert.equal(safeReturnTo(local, 'http://captable.insulinapps.localhost:9999/'), null)
})

test('the context relaxes cookies only for SITE_ENV=test on http://*.localhost', () => {
  assert.equal(ctxFor('http://auth.insulinapps.localhost:8787/', { testMode: true }).relaxed, true)
  assert.equal(ctxFor('https://auth.insulinapps.localhost/', { testMode: true }).relaxed, false)
  assert.equal(ctxFor('http://auth.example.test/').relaxed, false)
  assert.equal(ctxFor('http://auth.example.test/').scheme, 'https:')
})

function idToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`
}

test('Google ID token claims are checked one by one', () => {
  const now = Math.floor(Date.now() / 1000)
  const good = { iss: 'https://accounts.google.com', aud: 'client', exp: now + 300, nonce: 'n'.repeat(43), email_verified: true, email: 'Ada@Example.test', sub: '1234', name: 'Ada' }
  assert.deepEqual(decodeJwtPayload(idToken(good)), good)
  assert.equal(decodeJwtPayload('not.a.jwt!'), null)
  assert.deepEqual(checkIdToken(good, 'client', 'n'.repeat(43), now), { sub: '1234', email: 'ada@example.test', name: 'Ada' })
  assert.ok(checkIdToken({ ...good, iss: 'accounts.google.com' }, 'client', 'n'.repeat(43), now))
  for (const [change, why] of [
    [{ iss: 'https://evil.example' }, 'issuer'],
    [{ aud: 'other' }, 'audience'],
    [{ aud: ['client', 'other'] }, 'audience list without azp'],
    [{ exp: now - 1 }, 'expired'],
    [{ nonce: 'x'.repeat(43) }, 'nonce'],
    [{ email_verified: false }, 'unverified email'],
    [{ email_verified: 'true' }, 'email_verified must be the boolean true'],
    [{ email: undefined }, 'no email'],
    [{ sub: undefined }, 'no subject'],
  ]) {
    assert.equal(checkIdToken({ ...good, ...change }, 'client', 'n'.repeat(43), now), null, why)
  }
  assert.ok(checkIdToken({ ...good, aud: ['client', 'other'], azp: 'client' }, 'client', 'n'.repeat(43), now))
})

test('forwarded requests lose x-suger-* headers and the session cookie, keep everything else', async () => {
  const incoming = new Request('https://captable.example.test/api/x?y=1', {
    method: 'POST',
    headers: { 'X-Suger-User-Id': 'spoofed', 'x-SUGER-app-role': 'OWNER', 'X-Suger-Custom': 'anything', Cookie: 'a=1; insulin_session=s; b=2', 'Content-Type': 'text/plain' },
    body: 'payload',
  })
  const forwarded = forwardRequest(incoming, { 'x-suger-user-id': 'usr_real', 'x-suger-app-role': 'VIEWER' })
  assert.equal(forwarded.url, 'https://captable.example.test/api/x?y=1')
  assert.equal(forwarded.method, 'POST')
  assert.equal(forwarded.headers.get('x-suger-user-id'), 'usr_real')
  assert.equal(forwarded.headers.get('x-suger-app-role'), 'VIEWER')
  assert.equal(forwarded.headers.get('x-suger-custom'), null)
  assert.equal(forwarded.headers.get('cookie'), 'a=1; b=2')
  assert.equal(forwarded.headers.get('content-type'), 'text/plain')
  assert.equal(await forwarded.text(), 'payload')
})

test('a navigation is GET or HEAD with Sec-Fetch-Mode: navigate, or, without fetch metadata, an Accept asking for HTML', () => {
  const request = (headers, method = 'GET') => new Request('https://captable.example.test/x', { method, headers })
  assert.equal(isNavigation(request({ 'Sec-Fetch-Mode': 'navigate' })), true)
  assert.equal(isNavigation(request({ 'Sec-Fetch-Mode': 'navigate' }, 'HEAD')), true)
  assert.equal(isNavigation(request({ Accept: 'text/html,application/xhtml+xml' })), true)
  assert.equal(isNavigation(request({ 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' })), false, 'metadata wins over Accept')
  assert.equal(isNavigation(request({ 'Sec-Fetch-Mode': 'no-cors' })), false)
  assert.equal(isNavigation(request({ Accept: 'application/json' })), false)
  assert.equal(isNavigation(request({})), false)
  assert.equal(isNavigation(request({ 'Sec-Fetch-Mode': 'navigate' }, 'POST')), false)
})

test('error logs carry a known error name, an identifier-like kind and code, and never the message', () => {
  const lines = []
  const original = console.error
  console.error = (line) => lines.push(line)
  try {
    logError('failed', new Error('D1_ERROR: UNIQUE constraint failed: users.email for someone@example.test at https://x.example.test/?token=abc'), { user: 'u1' })
    const coded = new Error('send failed for someone@example.test')
    coded.code = 'E_SENDER_NOT_VERIFIED'
    logError('mail', coded)
    class LeakyError extends Error { name = 'Leaky someone@example.test' }
    logError('odd', new LeakyError('x'))
    logError('thrown', 'a string with someone@example.test')
  } finally {
    console.error = original
  }
  assert.deepEqual(JSON.parse(lines[0]), { event: 'failed', user: 'u1', error: 'Error', kind: 'D1_ERROR' })
  assert.deepEqual(JSON.parse(lines[1]), { event: 'mail', error: 'Error', code: 'E_SENDER_NOT_VERIFIED' })
  assert.deepEqual(JSON.parse(lines[2]), { event: 'odd', error: 'unknown' })
  assert.deepEqual(JSON.parse(lines[3]), { event: 'thrown', error: 'unknown' })
  assert.ok(lines.every((line) => !line.includes('@') && !line.includes('token')))
})
