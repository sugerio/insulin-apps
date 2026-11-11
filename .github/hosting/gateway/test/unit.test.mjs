// Pure modules, imported straight from src/ (Node strips the TypeScript types).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkName, cleanText, normalizeEmail, passwordProblem } from '../src/validate.ts'
import {
  appRoleOf, baseRoleFor, canChangeRole, canHandleInvitation, canManageCustomRoles, canRemoveMember, canSeeMembers,
  grantableRoles, permissionsOf,
} from '../src/roles.ts'
import { accessFromRow, grantAccess, orgAccess } from '../src/access.ts'
import { accessPhrase, parseAccessForm } from '../src/orgs/access-forms.ts'
import {
  base64url, constantTimeEqual, derivedSecret, fromBase64url, hashPassword, isId, isToken, newId, randomToken, seal, unseal,
  verifyPassword,
} from '../src/crypto.ts'
import { cookieValues, serializeCookie, setCookieName, withoutCookies } from '../src/http/cookies.ts'
import { bindingName, isAppName, isGatewayAppPath, issuesUrlFrom, navigationPathProblem, parseNavigation, parsePermissions, parseSecretKey, parseSender, readConfig, isPublicPath, parsePublicPaths, publicPathProblem, scheduledProblem } from '../src/config.ts'
import { NAV_ICON_NAMES, isNavIconName } from '../src/nav-icons.ts'
import { NAVIGATION_ICONS, listApps, navigationPathProblem as listAppsNavigationPathProblem, readNavigation } from '../../../scripts/list-apps.mjs'
import { gatewayConfig } from '../scripts/app-config.mjs'
import { safeReturnTo } from '../src/http/return-to.ts'
import { createContext } from '../src/context.ts'
import { escapeHtml, html } from '../src/pages/html.ts'
import { checkIdToken, decodeJwtPayload } from '../src/auth/id-token.ts'
import { forwardRequest, identityHeaders, isNavigation, scheduleHeaders } from '../src/http/forward.ts'
import { tickApp, tickApps } from '../src/scheduled.ts'
import { logError } from '../src/log.ts'
import { appToken } from '../../../scripts/deploy-apps.mjs'
import {
  base32Decode, base32Encode, codeDigits, groupedSecret, hotp, matchTotp, newRecoveryCode, newTotpSecret,
  normalizeRecoveryCode, otpauthUri, timeStep,
} from '../src/auth/totp.ts'

test('TOTP: the RFC 6238 SHA-1 vectors, a window of one step either side, and base32 keys', async () => {
  const rfc = new TextEncoder().encode('12345678901234567890')
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(await hotp(rfc, timeStep(seconds * 1000), 8), expected, String(seconds))
  }
  const secret = base32Encode(rfc)
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'the RFC 4648 encoding of the test key')
  assert.deepEqual([...base32Decode(secret.toLowerCase().match(/.{1,4}/g).join(' '))], [...rfc], 'case and spaces are ignored')
  assert.equal(base32Decode('not base32!'), null)
  const now = 1_700_000_000_000
  const step = timeStep(now)
  for (const offset of [-1, 0, 1]) assert.equal(await matchTotp(secret, await hotp(rfc, step + offset), now), step + offset, `offset ${offset}`)
  for (const offset of [-2, 2]) assert.equal(await matchTotp(secret, await hotp(rfc, step + offset), now), null, `offset ${offset}`)
  assert.equal(newTotpSecret().length, 32, '20 random bytes in base32')
  assert.equal(codeDigits(' 123 456 '), '123456')
  assert.equal(codeDigits('12345'), null)
  assert.equal(groupedSecret('ABCDEFGHIJ'), 'ABCD EFGH IJ')
  assert.equal(otpauthUri('ABCD', 'ada+mfa@example.test'),
    'otpauth://totp/Insulin%20Apps:ada%2Bmfa%40example.test?secret=ABCD&issuer=Insulin%20Apps&algorithm=SHA1&digits=6&period=30')
})

test('recovery codes are 80 random bits in four groups, and typed ones normalize to the stored form', () => {
  const code = newRecoveryCode()
  assert.match(code, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/)
  assert.notEqual(newRecoveryCode(), code)
  assert.equal(normalizeRecoveryCode(code.toUpperCase().replaceAll('-', ' ')), code.replaceAll('-', ''))
  assert.equal(normalizeRecoveryCode('123456'), null)
  assert.equal(normalizeRecoveryCode('abcd-efgh-ijkl'), null)
})

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
  assert.deepEqual(grantableRoles('OWNER'), ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS'])
  assert.deepEqual(grantableRoles('ADMIN'), ['ADMIN', 'EDITOR', 'VIEWER', 'APPS'])
  assert.deepEqual(grantableRoles('EDITOR'), [])
  assert.deepEqual(grantableRoles('APPS'), [])
  assert.equal(canChangeRole('ADMIN', 'APPS', 'EDITOR'), true)
  assert.equal(canChangeRole('ADMIN', 'OWNER', 'APPS'), false, 'ADMIN cannot move an OWNER to specific apps')
  assert.equal(canChangeRole('ADMIN', 'EDITOR', 'ADMIN'), true)
  assert.equal(canChangeRole('ADMIN', 'EDITOR', 'OWNER'), false, 'ADMIN cannot grant OWNER')
  assert.equal(canChangeRole('ADMIN', 'OWNER', 'ADMIN'), false, 'ADMIN cannot change an OWNER')
  assert.equal(canChangeRole('OWNER', 'OWNER', 'VIEWER'), true)
  assert.equal(canRemoveMember('ADMIN', 'OWNER'), false)
  assert.equal(canRemoveMember('ADMIN', 'ADMIN'), true)
  assert.equal(canRemoveMember('EDITOR', 'VIEWER'), false)
  assert.equal(canSeeMembers('EDITOR'), true)
  assert.equal(canSeeMembers('VIEWER'), true, 'every organization role sees the people')
  assert.equal(canSeeMembers('APPS'), false)
  assert.equal(canHandleInvitation('ADMIN', 'OWNER'), false)
  assert.equal(canHandleInvitation('ADMIN', 'APPS'), true)
  assert.equal(canManageCustomRoles('OWNER'), true)
  assert.equal(canManageCustomRoles('ADMIN'), false, 'only owners edit custom roles')
  assert.deepEqual(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS'].map(appRoleOf), ['ADMIN', 'ADMIN', 'EDITOR', 'VIEWER', null])
})

const CATALOG = [
  { key: 'records.manage', label: 'Record changes', description: '', role: 'EDITOR' },
  { key: 'records.view', label: 'View records', description: '', role: 'EDITOR' },
  { key: 'own.view', label: 'See own', description: '', role: 'VIEWER' },
  { key: 'billing.manage', label: 'Billing', description: '', role: 'ADMIN' },
]
const APP = { name: 'captable', title: 'Cap Table', permissions: CATALOG }
const BARE = { name: 'ledger', title: 'Ledger', permissions: [] }

test('a built-in role has every permission at or below it, and a custom role is sent as the least role covering it', () => {
  assert.deepEqual(permissionsOf(APP, 'ADMIN'), ['records.manage', 'records.view', 'own.view', 'billing.manage'])
  assert.deepEqual(permissionsOf(APP, 'EDITOR'), ['records.manage', 'records.view', 'own.view'])
  assert.deepEqual(permissionsOf(APP, 'VIEWER'), ['own.view'])
  assert.equal(baseRoleFor(APP, ['own.view']), 'VIEWER')
  assert.equal(baseRoleFor(APP, ['records.view', 'own.view']), 'EDITOR')
  assert.equal(baseRoleFor(APP, ['billing.manage']), 'ADMIN')
  assert.equal(baseRoleFor(APP, ['dropped.permission']), 'VIEWER', 'unknown keys count for nothing')
})

test('access comes from the organization role, or from the grant for the app, never both', () => {
  assert.deepEqual(orgAccess(APP, 'OWNER'), { role: 'ADMIN', permissions: permissionsOf(APP, 'ADMIN'), label: 'Admin', source: 'org', admin: true, customRole: null })
  assert.equal(orgAccess(APP, 'EDITOR').admin, false)
  assert.equal(orgAccess(APP, 'APPS'), null)
  assert.deepEqual(orgAccess(BARE, 'VIEWER').permissions, [], 'an app without a catalog gets no permissions')
  const custom = grantAccess(APP, { role: 'CUSTOM', customRoleId: 'r1', customRoleName: 'Board', customPermissions: '["records.view","gone"]' })
  assert.deepEqual(custom, { role: 'EDITOR', permissions: ['records.view'], label: 'Board', source: 'app', admin: false, customRole: { id: 'r1', name: 'Board' } })
  assert.equal(grantAccess(APP, { role: 'CUSTOM', customRoleId: 'r2', customRoleName: 'All', customPermissions: '["billing.manage"]' }).admin, false,
    'a custom role never makes someone an app admin, even one sent as ADMIN')
  assert.equal(grantAccess(APP, { role: 'ADMIN', customRoleId: null, customRoleName: null, customPermissions: null }).admin, true)
  const row = (member_role, grant_role = null) => ({ member_role, grant_role, custom_role_id: null, custom_role_name: null, custom_permissions: null })
  assert.equal(accessFromRow(APP, row('APPS')), null, 'specific apps without this one')
  assert.equal(accessFromRow(APP, row('APPS', 'VIEWER')).role, 'VIEWER')
  assert.equal(accessFromRow(APP, row('EDITOR', 'VIEWER')).role, 'EDITOR', 'an organization role wins over a stray grant')
  assert.equal(accessFromRow(APP, null), null)
})

test('the identity headers carry the app role, the permissions of an app with a catalog, and how the request came', () => {
  const actor = { id: 'u1', email: 'ada@example.test', name: 'Ada Lovelace' }
  const app = { ...APP, appId: 'insulin-apps-captable' }
  const headers = identityHeaders(actor, 'o1', app, orgAccess(app, 'OWNER'), 'mcp')
  assert.equal(headers['x-suger-app-role'], 'ADMIN', 'owners are admins in every app')
  assert.equal(headers['x-suger-app-permissions'], 'records.manage records.view own.view billing.manage')
  assert.equal(headers['x-suger-access-via'], 'mcp')
  assert.equal(headers['x-suger-user-name'], 'Ada%20Lovelace')
  const bare = identityHeaders(actor, 'o1', { ...BARE, appId: 'insulin-apps-ledger' }, orgAccess(BARE, 'VIEWER'), 'browser')
  assert.equal('x-suger-app-permissions' in bare, false, 'no catalog, no permissions header')
})

test('access forms: an organization role alone, or specific apps with at least one app, within what the actor may give', () => {
  const config = { apps: [APP, BARE] }
  const customRoles = [{ id: 'r1', app: 'captable', name: 'Board' }]
  const form = (fields) => new URLSearchParams(fields)
  assert.deepEqual(parseAccessForm(config, form({ role: 'EDITOR' }), 'ADMIN', customRoles), { role: 'EDITOR', grants: [] })
  assert.deepEqual(parseAccessForm(config, form({ role: 'APPS', 'app:captable': 'custom:r1', 'app:ledger': 'VIEWER' }), 'ADMIN', customRoles), {
    role: 'APPS',
    grants: [{ app: 'captable', role: 'CUSTOM', customRoleId: 'r1' }, { app: 'ledger', role: 'VIEWER', customRoleId: null }],
  })
  assert.equal(parseAccessForm(config, form({ role: 'OWNER' }), 'ADMIN', customRoles).status, 403)
  assert.match(parseAccessForm(config, form({ role: 'APPS' }), 'OWNER', customRoles).problem, /at least one app/)
  assert.match(parseAccessForm(config, form({ role: 'VIEWER', 'app:ledger': 'EDITOR' }), 'OWNER', customRoles).problem, /Specific apps/)
  assert.match(parseAccessForm(config, form({ role: 'APPS', 'app:ledger': 'custom:r1' }), 'OWNER', customRoles).problem, /Ledger/, "another app's custom role")
  assert.match(parseAccessForm(config, form({ role: 'USER' }), 'OWNER', customRoles).problem, /Choose/, 'the retired role')
  assert.equal(accessPhrase(config, 'ADMIN', []), 'as Admin')
  assert.equal(accessPhrase(config, 'APPS', [{ app: 'captable', role: 'CUSTOM', custom_role_name: 'Board' }, { app: 'ledger', role: 'VIEWER', custom_role_name: null }]),
    'with access to Cap Table as Board and Ledger as Viewer')
})

test('permission catalogs and the secret key are checked, and fail closed when malformed', () => {
  const problems = []
  assert.deepEqual(parsePermissions(CATALOG, 'p', problems).map((permission) => permission.key), CATALOG.map((permission) => permission.key))
  assert.deepEqual(problems, [])
  parsePermissions([{ key: 'Bad Key', label: 'x', role: 'EDITOR' }, { key: 'a', label: 'x', role: 'OWNER' }, { key: 'b', role: 'VIEWER' }], 'p', problems)
  assert.deepEqual(problems, ['p[0]', 'p[1]', 'p[2]'])
  assert.deepEqual(parsePermissions(undefined, 'p', []), [])
  assert.equal(parseSecretKey(Buffer.alloc(32, 7).toString('base64')).length, 32)
  assert.equal(parseSecretKey(Buffer.alloc(16).toString('base64')), null)
  assert.equal(parseSecretKey('not base64!'), null)
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

test('sealed secrets open only with the same key and purpose, and derived secrets are stable per subject', async () => {
  const key = new Uint8Array(32).fill(1)
  const sealed = await seal(key, 'totp', 'JBSWY3DPEHPK3PXP')
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/)
  assert.notEqual(await seal(key, 'totp', 'JBSWY3DPEHPK3PXP'), sealed, 'a fresh IV each time')
  assert.equal(await unseal(key, 'totp', sealed), 'JBSWY3DPEHPK3PXP')
  assert.equal(await unseal(key, 'integration', sealed), null, 'another purpose')
  assert.equal(await unseal(new Uint8Array(32).fill(2), 'totp', sealed), null, 'another key')
  assert.equal(await unseal(key, 'totp', `${sealed.slice(0, -2)}AA`), null, 'tampered')
  assert.equal(await unseal(key, 'totp', 'plain text'), null)
  assert.equal(await derivedSecret(key, 'app-token', 'captable'), await derivedSecret(key, 'app-token', 'captable'))
  assert.notEqual(await derivedSecret(key, 'app-token', 'captable'), await derivedSecret(key, 'app-token', 'ledger'))
})

test('the deploy derives each app\'s SUGER_APP_TOKEN exactly as the gateway checks it', async () => {
  const key = Buffer.alloc(32, 0x5a)
  for (const app of ['captable', 'ledger']) assert.equal(appToken(key.toString('base64'), app), await derivedSecret(key, 'app-token', app), app)
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
    DB: binding, RL_AUTH: binding, RL_APP: binding, RL_PUBLIC: binding, EMAIL: binding, APP_CAPTABLE: binding,
    SITE_DOMAIN: 'example.test', SITE_APPS: [{ name: 'captable', title: 'Cap Table', binding: 'APP_CAPTABLE' }],
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test',
  }
  const ok = readConfig(env)
  assert.equal(ok.ok, true)
  assert.equal(ok.config.apps[0].appId, 'insulin-apps-captable')
  assert.equal(ok.config.testMode, false)
  assert.equal(readConfig({ ...env, SITE_APPS: JSON.stringify(env.SITE_APPS) }).ok, true, 'SITE_APPS as a JSON string')
  // The optional addresses: normalized when usable, ignored (never fatal) when not.
  assert.equal(ok.config.orgRequestEmail, null)
  assert.equal(readConfig({ ...env, ORG_REQUEST_EMAIL: ' Requests@Example.TEST ' }).config.orgRequestEmail, 'requests@example.test')
  for (const unusable of ['not an address', 'two@@example.test', '   ']) {
    const result = readConfig({ ...env, ORG_REQUEST_EMAIL: unusable })
    assert.equal(result.ok, true, unusable)
    assert.equal(result.config.orgRequestEmail, null, unusable)
  }
  for (const [change, problem] of [
    [{ SITE_DOMAIN: undefined }, 'SITE_DOMAIN'],
    [{ TURNSTILE_SECRET_KEY: '' }, 'TURNSTILE_SECRET_KEY'],
    [{ GOOGLE_CLIENT_ID: 'id' }, 'GOOGLE_CLIENT_SECRET'],
    [{ SITE_APPS: '[not json' }, 'SITE_APPS'],
    [{ SITE_APPS: [{ name: 'auth' }] }, 'SITE_APPS[0].name'],
    [{ SITE_APPS: [{ name: 'captable', binding: 'APP_OTHER' }] }, 'SITE_APPS[0].binding'],
    [{ EMAIL: undefined }, 'EMAIL'],
    [{ DB: undefined }, 'DB'],
    [{ RL_PUBLIC: undefined }, 'RL_PUBLIC'],
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
    DB: binding, RL_AUTH: binding, RL_APP: binding, RL_PUBLIC: binding, EMAIL: binding, APP_CAPTABLE: binding,
    SITE_DOMAIN: testMode ? 'insulinapps.localhost' : 'example.test', SITE_APPS: [{ name: 'captable' }],
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test', ...(testMode ? { SITE_ENV: 'test' } : {}),
  })
  return createContext(new Request(url), {}, { waitUntil() {} }, result.config)
}

test('return_to accepts only the site\'s own hosts, with the request\'s scheme and no credentials', () => {
  const ctx = ctxFor('https://example.test/login')
  assert.equal(safeReturnTo(ctx, 'https://captable.example.test/companies?x=1'), 'https://captable.example.test/companies?x=1')
  assert.equal(safeReturnTo(ctx, 'https://example.test/'), 'https://example.test/')
  assert.equal(safeReturnTo(ctx, 'https://example.test/invitations/x'), 'https://example.test/invitations/x')
  for (const bad of [
    'https://auth.example.test/invitations/x',
    'https://evil.example/', 'http://captable.example.test/', 'https://user:pass@captable.example.test/', '/relative',
    '//evil.example/', 'javascript:alert(1)', 'https://captable.example.test.evil.example/', 'https://ledger.example.test/',
    'https://evil.example\\@captable.example.test/', 'https://captable.example.test:8443/', '',
  ]) {
    assert.equal(safeReturnTo(ctx, bad), null, bad)
  }
  const local = ctxFor('http://insulinapps.localhost:8787/login', { testMode: true })
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

test('public paths: the same rule as the deploy, matched at segment boundaries, never reaching a reserved path', () => {
  for (const good of ['/sign', '/editor/', '/api/public/', '/assets/']) assert.equal(publicPathProblem(good), null, good)
  for (const bad of ['/', '/api', '/api/', '/API', '/api/__suger', '/__insulin/x', '/settings', '/Settings/users', '/mcp', '/.well-known/x',
    'sign', '/a/../b', '/a?b', '/a#b', '/a//b', '/a b', 7, null]) {
    assert.notEqual(publicPathProblem(bad), null, String(bad))
  }
  const problems = []
  assert.deepEqual(parsePublicPaths(['/sign', '/api/', '/sign'], 'p', problems), ['/sign'])
  assert.deepEqual(problems, ['p[1]', 'p[2]'], 'a refused or repeated entry is a problem, not ignored')
  assert.deepEqual(parsePublicPaths(undefined, 'p', []), [])
  const tooMany = []
  parsePublicPaths(Array.from({ length: 11 }, (_, i) => `/p${i}`), 'p', tooMany)
  assert.equal(tooMany.length, 1)

  const app = { publicPaths: ['/sign', '/api/public/'] }
  for (const path of ['/sign', '/sign/', '/sign/step', '/api/public/', '/api/public/codes/1']) assert.equal(isPublicPath(app, path), true, path)
  for (const path of ['/signature', '/api/public', '/api/echo', '/', '/sign/%2e%2e/api/echo', '/sign/%2E%2E', '/sign/a%2fb', '/sign/%zz']) {
    assert.equal(isPublicPath(app, path), false, path)
  }
  assert.equal(isPublicPath({ publicPaths: [] }, '/sign'), false)

  const binding = { prepare() {}, limit() {}, send() {}, fetch() {} }
  const env = {
    DB: binding, RL_AUTH: binding, RL_APP: binding, RL_PUBLIC: binding, EMAIL: binding, APP_CAPTABLE: binding, SITE_DOMAIN: 'example.test',
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test',
  }
  assert.deepEqual(readConfig({ ...env, SITE_APPS: [{ name: 'captable', publicPaths: ['/sign'] }] }).config.apps[0].publicPaths, ['/sign'])
  const refused = readConfig({ ...env, SITE_APPS: [{ name: 'captable', publicPaths: ['/settings/'] }] })
  assert.equal(refused.ok, false, 'a malformed list fails closed')
  assert.ok(refused.problems.includes('SITE_APPS[0].publicPaths[0]'))
})

test("the gateway's paths on an app host: its settings addresses (People, Integrations, API access, Connect AI) and below", () => {
  for (const path of ['/settings/users', '/settings/users/', '/settings/users/invite', '/settings/integrations', '/settings/integrations/credentials',
    '/settings/api', '/settings/api/', '/settings/api/clients', '/settings/connect-ai', '/settings/connect-ai/agents/x/disconnect']) {
    assert.equal(isGatewayAppPath(path), true, path)
  }
  for (const path of ['/settings', '/settings/', '/settings/apis', '/settings/api-keys', '/settings/connect-ai-help', '/settings/profile', '/api/settings/api',
    '/Settings/api', '/x/settings/api', '/']) {
    assert.equal(isGatewayAppPath(path), false, path)
  }
})

test("an app's scheduled path: one path under /api/, never reserved, never public; anything else fails closed", () => {
  const publicPaths = ['/sign', '/api/public/', '/api/hooks']
  for (const good of ['/api/scheduled', '/api/jobs/due', '/api/hooksmith']) assert.equal(scheduledProblem(good, publicPaths), null, good)
  for (const bad of [
    '/api/', '/api', '/scheduled', 'api/scheduled', '/api/scheduled/', '/api/__suger/tick', '/api/__SUGER/tick', '/api/a/../b',
    '/api/a?b', '/api/a%2fb', '/api//a', '/api/a b', '/api/public/tick', '/API/Public/tick', '/api/hooks', '/api/hooks/tick',
    '/sign', 42, ['/api/scheduled'], '',
  ]) {
    assert.notEqual(scheduledProblem(bad, publicPaths), null, String(bad))
  }

  const binding = { prepare() {}, limit() {}, send() {}, fetch() {} }
  const env = {
    DB: binding, RL_AUTH: binding, RL_APP: binding, RL_PUBLIC: binding, EMAIL: binding, APP_CAPTABLE: binding, SITE_DOMAIN: 'example.test',
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test',
  }
  const declared = readConfig({ ...env, SITE_APPS: [{ name: 'captable', publicPaths: ['/api/public/'], scheduled: '/api/scheduled' }] })
  assert.equal(declared.config.apps[0].scheduled, '/api/scheduled')
  assert.equal(readConfig({ ...env, SITE_APPS: [{ name: 'captable' }] }).config.apps[0].scheduled, null, 'most apps have none')
  assert.equal(readConfig({ ...env, SITE_APPS: [{ name: 'captable', scheduled: null }] }).config.apps[0].scheduled, null)
  for (const scheduled of ['/api/public/tick', '/mcp', '/api/__suger/x', '/api/', 7]) {
    const refused = readConfig({ ...env, SITE_APPS: [{ name: 'captable', publicPaths: ['/api/public/'], scheduled }] })
    assert.equal(refused.ok, false, `${scheduled} fails closed`)
    assert.ok(refused.problems.includes('SITE_APPS[0].scheduled'), String(scheduled))
  }
})

test("an app's navigation: the gateway bundles exactly list-apps.mjs's icons, and checks a manifest as it does", () => {
  assert.deepEqual([...NAV_ICON_NAMES], [...NAVIGATION_ICONS], 'src/nav-icons.ts and list-apps.mjs list the same icons')
  assert.equal(isNavIconName('inbox'), true)
  for (const name of ['Inbox', 'rocket', '', null, 7]) assert.equal(isNavIconName(name), false, String(name))
  for (const path of ['/', '/envelopes', '/envelopes?status=draft', '/search?q=a%20b', '/settingsx', '//evil.example', '/settings', '/Settings/users',
    '/__insulin/me', '/mcp', '/.well-known/x', '/api/__suger/x', '/a#b', '/a b', '/a\\b', '/a/../b', '/a%2fb', '/a//b', 'a', 42]) {
    assert.equal(navigationPathProblem(path), listAppsNavigationPathProblem(path), `the same verdict on ${JSON.stringify(path)}`)
  }

  const manifest = [
    { key: 'envelopes', label: 'Envelopes', icon: 'inbox', path: '/envelopes', group: 'Signing', children: [{ key: 'drafts', label: 'Drafts', icon: 'file-pen', path: '/envelopes?status=draft' }] },
    { key: 'templates', label: 'Templates', icon: 'files', path: '/templates', role: 'EDITOR' },
  ]
  const problems = []
  assert.deepEqual(parseNavigation(readNavigation('esign', manifest), 'nav', problems), readNavigation('esign', manifest), "list-apps.mjs's output passes unchanged")
  assert.deepEqual(parseNavigation(manifest, 'nav', problems), readNavigation('esign', manifest), 'defaults filled in the same way')
  assert.deepEqual(problems, [])
  assert.deepEqual(parseNavigation(undefined, 'nav', problems), [])
  for (const [raw, problem] of [
    [{}, 'nav (expected an array of at most 12)'],
    [Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: 'A', icon: 'list', path: '/a' })), 'nav (expected an array of at most 12)'],
    [[{ key: 'a', label: 'A', icon: 'rocket', path: '/a' }], 'nav[0]'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/settings/users' }], 'nav[0]'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/a', role: 'OWNER' }], 'nav[0]'],
    [[{ key: 'a', label: '', icon: 'list', path: '/a' }], 'nav[0]'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/a', group: '' }], 'nav[0]'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/a' }, { key: 'a', label: 'B', icon: 'list', path: '/b' }], 'nav[1]'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/a', children: 'x' }], 'nav[0].children (expected an array of at most 12)'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/a', children: [{ key: 'b', label: 'B', icon: 'list', path: '/b', children: [] }] }], 'nav[0].children[0]'],
    [[{ key: 'a', label: 'A', icon: 'list', path: '/a', children: [{ key: 'b', label: 'B', icon: 'list', path: '/mcp' }] }], 'nav[0].children[0]'],
  ]) {
    const found = []
    parseNavigation(raw, 'nav', found)
    assert.ok(found.includes(problem), `${JSON.stringify(raw).slice(0, 90)}: ${found.join(', ')}`)
  }

  const binding = { prepare() {}, limit() {}, send() {}, fetch() {} }
  const env = {
    DB: binding, RL_AUTH: binding, RL_APP: binding, RL_PUBLIC: binding, EMAIL: binding, APP_CAPTABLE: binding, SITE_DOMAIN: 'example.test',
    TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', EMAIL_FROM: 'no-reply@example.test',
  }
  const old = readConfig({ ...env, SITE_APPS: JSON.stringify([{ name: 'captable', title: 'Cap Table', binding: 'APP_CAPTABLE', permissions: [], publicPaths: [], scheduled: null }]) })
  assert.equal(old.ok, true, 'a SITE_APPS from before the navigation manifest still loads')
  assert.deepEqual(old.config.apps[0].navigation, [])
  const declared = readConfig({ ...env, SITE_APPS: [{ name: 'captable', navigation: manifest }] })
  assert.deepEqual(declared.config.apps[0].navigation, readNavigation('captable', manifest))
  const refused = readConfig({ ...env, SITE_APPS: [{ name: 'captable', navigation: [{ key: 'a', label: 'A', icon: 'list', path: '/__insulin/me' }] }] })
  assert.equal(refused.ok, false, 'a malformed manifest fails closed, like the other fields')
  assert.ok(refused.problems.includes('SITE_APPS[0].navigation[0]'))
})

test("a local run's gateway config carries each app's navigation, as the deploy's does", async () => {
  const apps = await listApps()
  const local = await gatewayConfig(apps.map(({ name }) => name))
  for (const app of apps) {
    const entry = local.vars.SITE_APPS.find(({ name }) => name === app.name)
    assert.deepEqual(entry.navigation, app.navigation, app.name)
    assert.equal('secrets' in entry, false, `${app.name}: never the names of its secrets`)
  }
})

test("the tick: POST to the app's own host with the app id and schedule only, a timeout, and a log of app and status", async () => {
  assert.deepEqual(scheduleHeaders({ appId: 'insulin-apps-esign' }), { 'x-suger-app-id': 'insulin-apps-esign', 'x-suger-access-via': 'schedule' })
  const seen = []
  const app = (name, scheduled, fetch) => ({ name, appId: `insulin-apps-${name}`, host: `${name}.example.test`, scheduled, service: fetch ? { fetch } : null })
  const answering = (status) => async (request) => { seen.push(request); return new Response('{}', { status }) }
  const lines = []
  const original = console.log
  console.log = (line) => lines.push(JSON.parse(line))
  try {
    await tickApp({ testMode: false }, app('esign', '/api/scheduled', answering(200)))
    const [request] = seen
    assert.equal(request.method, 'POST')
    assert.equal(request.url, 'https://esign.example.test/api/scheduled')
    assert.deepEqual([...request.headers].sort(), [['x-suger-access-via', 'schedule'], ['x-suger-app-id', 'insulin-apps-esign']])
    assert.equal(request.body, null, 'an empty body')
    assert.ok(request.signal instanceof AbortSignal, 'with a timeout')

    const hanging = (request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)))
    await tickApp({ testMode: false }, app('slow', '/api/scheduled', hanging), 20)
    await tickApp({ testMode: false }, app('broken', '/api/scheduled', async () => { throw new TypeError('synthetic') }))
    assert.deepEqual(lines, [
      { event: 'app_scheduled', app: 'esign', status: 200 },
      { event: 'app_scheduled', app: 'slow', status: 'timeout' },
      { event: 'app_scheduled', app: 'broken', status: 'unreachable' },
    ])

    lines.length = 0
    seen.length = 0
    const work = []
    tickApps({ testMode: true, apps: [app('a', '/api/scheduled', answering(204)), app('b', null, answering(200)), app('c', '/api/tick', null)] }, (promise) => work.push(promise))
    assert.equal(work.length, 1, 'only an app with a path and a binding')
    await Promise.all(work)
    assert.equal(seen[0].url, 'http://a.example.test/api/scheduled', 'http only on a local test domain')
  } finally {
    console.log = original
  }
})
