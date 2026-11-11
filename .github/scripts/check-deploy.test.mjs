import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { checkDeploy } from './check-deploy.mjs'

const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release@example.test',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release@example.test',
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
}

function release(root, version) {
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', `Release ${version}`)
  git(root, 'tag', version)
  return git(root, 'rev-parse', 'HEAD')
}

const app = (name) => ({
  [`${name}/package.json`]: '{}\n',
  [`${name}/src/api.ts`]: 'export default {}\n',
  [`${name}/src/app/db/migrations/0000_init.sql`]: 'CREATE TABLE records (id TEXT);\n',
})

// Main with four releases: v0.1.1 has apps alpha and beta, v0.1.2 changes alpha's code, v0.1.3 adds an alpha migration,
// and v0.1.4 adds a gateway migration and the app gamma.
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'check-deploy-'))
  temporary.push(root)
  git(root, 'init', '--quiet', '--initial-branch=main')
  await write(root, { ...app('alpha'), ...app('beta'), '.github/hosting/gateway/migrations/0001_init.sql': 'CREATE TABLE users (id TEXT);\n' })
  const commits = { 'v0.1.1': release(root, 'v0.1.1') }
  await write(root, { 'alpha/src/api.ts': 'export default { changed: true }\n' })
  commits['v0.1.2'] = release(root, 'v0.1.2')
  await write(root, { 'alpha/src/app/db/migrations/0001_more.sql': 'ALTER TABLE records ADD COLUMN note TEXT;\n' })
  commits['v0.1.3'] = release(root, 'v0.1.3')
  await write(root, { '.github/hosting/gateway/migrations/0002_more.sql': 'ALTER TABLE users ADD COLUMN name TEXT;\n', ...app('gamma') })
  commits['v0.1.4'] = release(root, 'v0.1.4')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { root, commits }
}

test('deploys the named apps of a release, every app with all, and the gateway as asked', async () => {
  const { root, commits } = await repository()
  assert.deepEqual(await checkDeploy({ root, version: 'v0.1.4', apps: 'alpha' }), {
    version: 'v0.1.4', commit: commits['v0.1.4'], latest: 'v0.1.4', apps: ['alpha'], gateway: true,
  })
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.4', apps: 'all' })).apps, ['alpha', 'beta', 'gamma'])
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.4', apps: ' gamma, alpha alpha ' })).apps, ['alpha', 'gamma'])
  const gatewayOnly = await checkDeploy({ root, version: 'v0.1.4', apps: '', gateway: true })
  assert.deepEqual([gatewayOnly.apps, gatewayOnly.gateway], [[], true])
  // `all` means the apps of the release deployed, not of main.
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.3', apps: 'all', gateway: false })).apps, ['alpha', 'beta'])
})

test('refuses a version that is not a release of main, and an app the release does not have', async () => {
  const { root, commits } = await repository()
  await assert.rejects(() => checkDeploy({ root, version: 'main' }), /"main" isn't a release such as v0\.1\.2/)
  await assert.rejects(() => checkDeploy({ root, version: '' }), /An empty version isn't a release/)
  await assert.rejects(() => checkDeploy({ root, version: 'v0.1.9' }), /There is no release v0\.1\.9/)
  await assert.rejects(() => checkDeploy({ root, version: 'v0.1.4', apps: 'alpha delta' }), /v0\.1\.4 has no app "delta"/)
  await assert.rejects(() => checkDeploy({ root, version: 'v0.1.3', apps: 'gamma', gateway: false }), /v0\.1\.3 has no app "gamma"/)

  // A tag on a commit that never reached main.
  git(root, 'switch', '--quiet', '--detach', commits['v0.1.1'])
  await write(root, { 'beta/src/api.ts': 'export default { side: true }\n' })
  git(root, 'commit', '--quiet', '-am', 'Not on main')
  git(root, 'tag', 'v0.0.9')
  await assert.rejects(() => checkDeploy({ root, version: 'v0.0.9', apps: 'beta' }), /v0\.0\.9 \([0-9a-f]{40}\) isn't a commit of main/)
})

test('goes back to an earlier release only when everything it deploys keeps the latest migrations', async () => {
  const { root, commits } = await repository()
  // Beta's migrations never changed; the gateway's changed in v0.1.4.
  assert.equal((await checkDeploy({ root, version: 'v0.1.1', apps: 'beta', gateway: false })).commit, commits['v0.1.1'])
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.3', apps: 'beta', gateway: true }),
    /v0\.1\.3 is older than v0\.1\.4, and its \.github\/hosting\/gateway\/migrations differ\. Going back past a migration/,
  )
  // Alpha's changed in v0.1.3: v0.1.3 itself keeps them, v0.1.2 doesn't.
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.3', apps: 'alpha beta', gateway: false })).apps, ['alpha', 'beta'])
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.2', apps: 'alpha beta', gateway: false }),
    /its alpha\/src\/app\/db\/migrations differ\..*deploy v0\.1\.4, or a release with its migrations/,
  )
})
