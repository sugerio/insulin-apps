import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { NAVIGATION_ICONS, listApps, navigationPathProblem, publicPathProblem, readNavigation, scheduledProblem, validateAppName } from './list-apps.mjs'

const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

async function repository(apps) {
  const root = await mkdtemp(join(tmpdir(), 'list-apps-'))
  temporary.push(root)
  for (const [name, manifest] of Object.entries(apps)) {
    await mkdir(join(root, name, 'src'), { recursive: true })
    await writeFile(join(root, name, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(root, name, 'src', 'api.ts'), 'export default {}\n')
  }
  return root
}

test('discovers top-level apps in stable order with their public metadata', async () => {
  const root = await repository({
    zebra: { description: 'Last app' },
    'alpha-app': { displayName: 'Alpha App', description: 'First app' },
  })
  await mkdir(join(root, 'not-an-app'))

  assert.deepEqual(await listApps(root), [
    { name: 'alpha-app', title: 'Alpha App', summary: 'First app', permissions: [], publicPaths: [], scheduled: null, navigation: [], secrets: [] },
    { name: 'zebra', title: 'zebra', summary: 'Last app', permissions: [], publicPaths: [], scheduled: null, navigation: [], secrets: [] },
  ])
})

test("reads an app's permission catalog for custom roles, and refuses a malformed one", async () => {
  const permissions = [
    { key: 'records.manage', label: 'Record changes', description: 'Change records.', role: 'EDITOR' },
    { key: 'own.view', label: 'See own', role: 'VIEWER' },
  ]
  const root = await repository({ catalogued: { insulin: { permissions } } })
  assert.deepEqual((await listApps(root))[0].permissions, [permissions[0], { ...permissions[1], description: '' }])
  for (const [bad, message] of [
    [{ key: 'Bad Key', label: 'x', role: 'EDITOR' }, /key must match/],
    [{ key: 'a', label: 'x', role: 'OWNER' }, /role must be ADMIN, EDITOR or VIEWER/],
    [{ key: 'a', label: '', role: 'VIEWER' }, /label must be/],
    ['a', /must be an object/],
  ]) {
    const broken = await repository({ broken: { insulin: { permissions: [bad] } } })
    await assert.rejects(() => listApps(broken), message)
  }
  const twice = await repository({ twice: { insulin: { permissions: [permissions[1], permissions[1]] } } })
  await assert.rejects(() => listApps(twice), /listed twice/)
})

test('accepts the full app-name boundary', () => {
  for (const name of ['a', 'ab', 'cap-table', `a${'0'.repeat(31)}`]) assert.doesNotThrow(() => validateAppName(name))
})

test('rejects malformed and reserved app directory names clearly', async () => {
  for (const name of ['A', '-app', 'app-', 'two_words', `a${'0'.repeat(32)}`]) {
    assert.throws(() => validateAppName(name), /Invalid app directory name/)
  }
  for (const name of ['auth', 'www', 'support']) assert.throws(() => validateAppName(name), /is reserved/)

  const root = await repository({ auth: { displayName: 'Reserved' } })
  await assert.rejects(() => listApps(root), /App directory name "auth" is reserved/)
})

test('reports an invalid manifest instead of silently skipping the app', async () => {
  const root = await repository({ valid: {} })
  await writeFile(join(root, 'valid', 'package.json'), '{')
  await assert.rejects(() => listApps(root), /App "valid" has an invalid package.json/)
})

test('reads the paths an app opens to people without an account, and refuses any that reach the gateway or the whole API', async () => {
  const publicPaths = ['/sign', '/editor/', '/api/public/', '/assets/']
  const root = await repository({ signing: { insulin: { publicPaths } } })
  assert.deepEqual((await listApps(root))[0].publicPaths, publicPaths)
  for (const good of publicPaths) assert.equal(publicPathProblem(good), null, good)
  for (const bad of [
    '/', 'sign', '/api', '/api/', '/API/', '/api/__suger/x', '/__insulin/me', '/settings', '/settings/users', '/mcp', '/MCP/x',
    '/.well-known/', '/sign/../api', '/sign?x=1', '/sign#a', '/a//b', '/a\\b', '/a b', 42,
  ]) {
    assert.notEqual(publicPathProblem(bad), null, String(bad))
  }
  const broken = await repository({ broken: { insulin: { publicPaths: ['/api/'] } } })
  await assert.rejects(() => listApps(broken), /insulin\.publicPaths\[0\] must not cover every path or the whole API/)
  const many = await repository({ many: { insulin: { publicPaths: Array.from({ length: 11 }, (_, i) => `/p${i}`) } } })
  await assert.rejects(() => listApps(many), /at most 10/)
  const twice = await repository({ twice: { insulin: { publicPaths: ['/sign', '/sign'] } } })
  await assert.rejects(() => listApps(twice), /listed twice/)
})

test("reads the path an app's due work runs on, which must be under /api/ and never public or reserved", async () => {
  const root = await repository({ signing: { insulin: { publicPaths: ['/sign', '/api/public/'], scheduled: '/api/scheduled' } } })
  assert.equal((await listApps(root))[0].scheduled, '/api/scheduled')
  const publicPaths = ['/sign', '/api/public/', '/api/hooks']
  for (const good of ['/api/scheduled', '/api/jobs/due', '/api/hooksmith']) assert.equal(scheduledProblem(good, publicPaths), null, good)
  for (const bad of [
    '/api/', '/api', '/scheduled', 'api/scheduled', '/api/scheduled/', '/api/__suger/tick', '/API/__suger/tick', '/api/a/../b', '/api/a?b',
    '/api/a%2fb', '/api//a', '/api/public/tick', '/API/PUBLIC/tick', '/api/hooks', '/api/hooks/tick', '/sign', 42, null, ['/api/x'],
  ]) {
    assert.notEqual(scheduledProblem(bad, publicPaths), null, String(bad))
  }
  for (const [scheduled, message] of [
    ['/api/public/run', /insulin\.scheduled must not be one of the app's public paths or under one/],
    ['/settings/run', /insulin\.scheduled must be a path under \/api\//],
    ['/api/__suger/run', /insulin\.scheduled must not reach \/api\/__suger/],
    [['/api/a', '/api/b'], /insulin\.scheduled must be a path under \/api\//],
  ]) {
    const broken = await repository({ broken: { insulin: { publicPaths: ['/api/public/'], scheduled } } })
    await assert.rejects(() => listApps(broken), message, String(scheduled))
  }
})

test("reads an app's secret names, which carry its own prefix", async () => {
  const root = await repository({ 'e-sign': { insulin: { secrets: ['E_SIGN_KMS_KEY_ARN', 'E_SIGN_OTP_KEY'] } } })
  assert.deepEqual((await listApps(root))[0].secrets, ['E_SIGN_KMS_KEY_ARN', 'E_SIGN_OTP_KEY'])
  for (const bad of ['KMS_KEY', 'e_sign_lower', 'E_SIGN_', 'OTHER_APP_KEY', 'E_SIGN_BAD-NAME']) {
    const broken = await repository({ 'e-sign': { insulin: { secrets: [bad] } } })
    await assert.rejects(() => listApps(broken), /insulin\.secrets\[0\] must match/, bad)
  }
})

test("never hands an app the platform's own settings, or a name in another app's namespace", async () => {
  for (const name of ['cloudflare', 'google', 'turnstile', 'github', 'site', 'suger']) {
    const reserved = await repository({ [name]: { insulin: { secrets: [`${name.toUpperCase()}_API_TOKEN`] } } })
    await assert.rejects(() => listApps(reserved), /is reserved/, name)
  }
  // An app named after a word in a platform setting can't claim that setting: ORG_REQUEST_EMAIL is the gateway's.
  const org = await repository({ org: { insulin: { secrets: ['ORG_REQUEST_EMAIL'] } } })
  await assert.rejects(() => listApps(org), /insulin\.secrets\[0\] names a setting of the platform itself/)
  const both = await repository({ esign: { insulin: { secrets: ['ESIGN_PRO_KEY'] } }, 'esign-pro': { insulin: { secrets: ['ESIGN_PRO_KEY'] } } })
  await assert.rejects(() => listApps(both), /ESIGN_PRO_KEY belongs to app "esign-pro"/)
  const percent = await repository({ app1: { insulin: { publicPaths: ['/%5f%5finsulin/'] } } })
  await assert.rejects(() => listApps(percent), /percent sign/)
})

test("reads an app's navigation manifest, filling in the defaults", async () => {
  const navigation = [
    {
      key: 'envelopes', label: ' Envelopes ', icon: 'inbox', path: '/envelopes', group: 'Signing',
      children: [{ key: 'drafts', label: 'Drafts', icon: 'file-pen', path: '/envelopes?status=draft' }],
    },
    { key: 'templates', label: 'Templates', icon: 'files', path: '/templates', role: 'EDITOR' },
    { key: 'home', label: 'Home', icon: 'home', path: '/' },
    { key: 'mine', label: 'My holdings', icon: 'chart-pie', path: '/mine', maxRole: 'VIEWER' },
  ]
  const root = await repository({ signing: { insulin: { navigation } } })
  assert.deepEqual((await listApps(root))[0].navigation, [
    {
      key: 'envelopes', label: 'Envelopes', icon: 'inbox', path: '/envelopes', group: 'Signing', role: 'VIEWER', maxRole: 'ADMIN',
      children: [{ key: 'drafts', label: 'Drafts', icon: 'file-pen', path: '/envelopes?status=draft', group: null, role: 'VIEWER', maxRole: 'ADMIN' }],
    },
    { key: 'templates', label: 'Templates', icon: 'files', path: '/templates', group: null, role: 'EDITOR', maxRole: 'ADMIN', children: [] },
    { key: 'home', label: 'Home', icon: 'home', path: '/', group: null, role: 'VIEWER', maxRole: 'ADMIN', children: [] },
    { key: 'mine', label: 'My holdings', icon: 'chart-pie', path: '/mine', group: null, role: 'VIEWER', maxRole: 'VIEWER', children: [] },
  ])
  for (const icon of ['layout-dashboard', 'home', 'table', 'layers', 'chart-pie', 'shield', 'heart', 'users', 'building', 'file-text', 'award',
    'inbox', 'files', 'file-pen', 'signature', 'send', 'clock', 'check-circle', 'archive', 'settings', 'book-open', 'plug', 'key', 'bot',
    'folder', 'list', 'calendar', 'bell', 'search']) {
    assert.ok(NAVIGATION_ICONS.includes(icon), icon)
  }
  assert.equal(new Set(NAVIGATION_ICONS).size, NAVIGATION_ICONS.length, 'each icon once')
  assert.ok(Object.isFrozen(NAVIGATION_ICONS))
})

test('refuses a malformed navigation manifest, naming the item and field that are wrong', async () => {
  const item = (extra = {}) => ({ key: 'a', label: 'A', icon: 'list', path: '/a', ...extra })
  for (const [raw, message] of [
    [{}, /insulin\.navigation must be an array of at most 12/],
    [Array.from({ length: 13 }, (_, i) => item({ key: `k${i}` })), /at most 12/],
    [['a'], /insulin\.navigation\[0\] must be an object/],
    [[item({ key: 'Bad Key' })], /\[0\]\.key must match/],
    [[item({ key: 'a_b' })], /\[0\]\.key must match/],
    [[item({ key: '' })], /\[0\]\.key must match/],
    [[item(), item()], /\[1\]\.key "a" is listed twice/],
    [[item({ maxRole: 'OWNER' })], /\[0\]\.maxRole must be VIEWER, EDITOR or ADMIN/],
    [[item({ role: 'EDITOR', maxRole: 'VIEWER' })], /\[0\]\.maxRole must not be below its role/],
    [[item({ children: [item()] })], /children\[0\]\.key "a" is listed twice/],
    [[item({ label: '' })], /\[0\]\.label must be 1-40 characters/],
    [[item({ label: '   ' })], /\[0\]\.label must be 1-40 characters/],
    [[item({ label: 'x'.repeat(41) })], /\[0\]\.label must be 1-40 characters/],
    [[item({ icon: 'rocket' })], /\[0\]\.icon must be one of/],
    [[item({ icon: 'House' })], /\[0\]\.icon must be one of/],
    [[item({ path: 'a' })], /\[0\]\.path must be a path on the app's host/],
    [[item({ path: '/settings/users' })], /\[0\]\.path must not be one of the gateway's paths \(\/settings\)/],
    [[item({ path: '/__insulin/me' })], /must not be one of the gateway's paths \(\/__insulin\)/],
    [[item({ group: '' })], /\[0\]\.group must be 1-40 characters/],
    [[item({ group: 7 })], /\[0\]\.group must be 1-40 characters/],
    [[item({ role: 'OWNER' })], /\[0\]\.role must be VIEWER, EDITOR or ADMIN/],
    [[item({ role: 'viewer' })], /\[0\]\.role must be VIEWER, EDITOR or ADMIN/],
    [[item({ children: {} })], /\[0\]\.children must be an array of at most 12/],
    [[item({ children: Array.from({ length: 13 }, (_, i) => item({ key: `c${i}` })) })], /\[0\]\.children must be an array of at most 12/],
    [[item({ children: [item({ key: 'b', children: [] })] })], /\[0\]\.children\[0\] must not have children: the navigation has two levels/],
    [[item({ children: [item({ key: 'b', path: '/mcp' })] })], /\[0\]\.children\[0\]\.path must not be one of the gateway's paths \(\/mcp\)/],
    [[item({ roles: 'EDITOR' })], /\[0\]\.roles is not a navigation field/],
  ]) {
    assert.throws(() => readNavigation('signing', raw), message, JSON.stringify(raw).slice(0, 80))
  }
  assert.deepEqual(readNavigation('signing', undefined), [])
  assert.deepEqual(readNavigation('signing', []), [])
  const full = Array.from({ length: 12 }, (_, i) => item({ key: `k${i}`, children: Array.from({ length: 12 }, (_, j) => item({ key: `k${i}-${j}` })) }))
  assert.equal(readNavigation('signing', full).length, 12, '12 items of 12 children each')
  const broken = await repository({ broken: { insulin: { navigation: [item({ path: '/.well-known/x' })] } } })
  await assert.rejects(() => listApps(broken), /App "broken": insulin\.navigation\[0\]\.path must not be one of the gateway's paths/)
})

test("a navigation path stays on the app's host and off the gateway's paths", () => {
  for (const good of ['/', '/envelopes', '/envelopes/', '/envelopes?status=draft', '/a/b-c_d.e', '/search?q=a%20b&x=/settings', '/settingsx', '/mcpx', '/api/stakeholders']) {
    assert.equal(navigationPathProblem(good), null, good)
  }
  for (const bad of [
    '', 'envelopes', '//evil.example', '/\\evil.example', 'https://evil.example/', '/a b', '/a\tb', '/a#b', '/a\u0000', `/${'a'.repeat(200)}`,
    '/a//b', '/a/../b', '/./a', '/%2e%2e/a', '/a%2fb', '/settings', '/settings/', '/Settings/users', '/settings/anything', '/__insulin',
    '/__INSULIN/bar.js', '/mcp', '/mcp/', '/.well-known/oauth-protected-resource', '/api/__suger/x', 42, null, ['/a'],
  ]) {
    assert.notEqual(navigationPathProblem(bad), null, String(bad))
  }
})
