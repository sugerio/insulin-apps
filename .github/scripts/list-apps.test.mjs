import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { listApps, validateAppName } from './list-apps.mjs'

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
    { name: 'alpha-app', title: 'Alpha App', summary: 'First app', permissions: [] },
    { name: 'zebra', title: 'zebra', summary: 'Last app', permissions: [] },
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
