import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkDeploy as check, githubLastDeploy, githubLatestCheck, pushPaths } from './check-deploy.mjs'

const temporary = []

// Every part passed its latest check, on the release's own commit, unless a test says otherwise: `checks` maps a
// workflow file to its result, or to `{ result, sha }` for a run on another commit. `deployed` maps an app to the last
// release whose deploy of it succeeded.
const checkDeploy = ({ checks = {}, deployed = {}, ...options }) => check({
  latestCheck: async ({ workflow, commit }) => {
    const given = checks[workflow] ?? 'success'
    return typeof given === 'string' ? { result: given, sha: given === 'none' ? null : commit } : given
  },
  lastDeploy: async ({ app }) => deployed[app] ?? null,
  ...options,
})
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
  await write(root, {
    ...app('alpha'),
    ...app('beta'),
    '.github/hosting/gateway/migrations/0001_init.sql': 'CREATE TABLE users (id TEXT);\n',
    '.github/workflows/gateway.yml': 'name: Gateway\non:\n  push:\n    branches: [main]\n    paths:\n      - .github/hosting/gateway/**\n      - .github/workflows/gateway.yml\n',
    '.github/workflows/alpha.yml': "name: alpha\non:\n  push:\n    paths:\n      - 'alpha/**'\n      - \"shared/**\" # both quotes\n",
  })
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
    version: 'v0.1.4', commit: commits['v0.1.4'], latest: 'v0.1.4', apps: ['alpha'], gateway: true, images: [], held: [],
  })
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.4', apps: 'all' })).apps, ['alpha', 'beta', 'gamma'])
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.4', apps: ' gamma, alpha alpha ' })).apps, ['alpha', 'gamma'])
  const gatewayOnly = await checkDeploy({ root, version: 'v0.1.4', apps: '', gateway: true })
  assert.deepEqual([gatewayOnly.apps, gatewayOnly.gateway], [[], true])
  // `all` means the apps of the release deployed, not of main.
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.3', apps: 'all', gateway: false, rollback: true })).apps, ['alpha', 'beta'])
})

test('refuses a version that is not a release of main, and an app the release does not have', async () => {
  const { root, commits } = await repository()
  await assert.rejects(() => checkDeploy({ root, version: 'main' }), /"main" isn't a release such as v0\.1\.2/)
  await assert.rejects(() => checkDeploy({ root, version: '' }), /An empty version isn't a release/)
  await assert.rejects(() => checkDeploy({ root, version: 'v0.1.9' }), /There is no release v0\.1\.9/)
  await assert.rejects(() => checkDeploy({ root, version: 'v0.1.4', apps: 'alpha delta' }), /v0\.1\.4 has no app "delta"/)
  await assert.rejects(() => checkDeploy({ root, version: 'v0.1.3', apps: 'gamma', gateway: false, rollback: true }), /v0\.1\.3 has no app "gamma"/)

  // A tag on a commit that never reached main.
  git(root, 'switch', '--quiet', '--detach', commits['v0.1.1'])
  await write(root, { 'beta/src/api.ts': 'export default { side: true }\n' })
  git(root, 'commit', '--quiet', '-am', 'Not on main')
  git(root, 'tag', 'v0.0.9')
  await assert.rejects(() => checkDeploy({ root, version: 'v0.0.9', apps: 'beta', rollback: true }), /v0\.0\.9 \([0-9a-f]{40}\) isn't a commit of main/)
})

test('goes back to an earlier release only when everything it deploys keeps the latest migrations', async () => {
  const { root, commits } = await repository()
  // Beta's migrations never changed; the gateway's changed in v0.1.4.
  assert.equal((await checkDeploy({ root, version: 'v0.1.1', apps: 'beta', gateway: false, rollback: true })).commit, commits['v0.1.1'])
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.3', apps: 'beta', gateway: true, rollback: true }),
    /v0\.1\.3 is older than v0\.1\.4, and its \.github\/hosting\/gateway\/migrations differ\. Going back past a migration/,
  )
  // Alpha's changed in v0.1.3: v0.1.3 itself keeps them, v0.1.2 doesn't.
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.3', apps: 'alpha beta', gateway: false, rollback: true })).apps, ['alpha', 'beta'])
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.2', apps: 'alpha beta', gateway: false, rollback: true }),
    /its alpha\/src\/app\/db\/migrations differ\..*deploy v0\.1\.4, or a release with its migrations/,
  )
})

test('deploys only what passed its latest check: a release holds back the rest, and everything while the gateway is held', async () => {
  const { root } = await repository()
  const failing = await checkDeploy({ root, version: 'v0.1.4', apps: 'all', release: true, checks: { 'alpha.yml': 'failure', 'gamma.yml': 'pending' } })
  assert.deepEqual([failing.apps, failing.gateway], [['beta'], true])
  assert.deepEqual(failing.held, [{ name: 'alpha', check: 'failure' }, { name: 'gamma', check: 'pending' }])

  const blocked = await checkDeploy({ root, version: 'v0.1.4', apps: 'all', release: true, checks: { 'gateway.yml': 'failure' } })
  assert.deepEqual([blocked.apps, blocked.gateway], [[], false])
  assert.deepEqual(blocked.held.map(({ name, check }) => `${name}: ${check}`), [
    'the gateway: failure', 'alpha: waiting for the gateway', 'beta: waiting for the gateway', 'gamma: waiting for the gateway',
  ])
})

test("by hand, refuses an app or the gateway named whose latest check didn't pass, and leaves such an app out of all", async () => {
  const { root } = await repository()
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.4', apps: 'alpha beta', gateway: false, checks: { 'alpha.yml': 'failure' } }),
    /alpha's latest check at or before v0\.1\.4 is failure, so it can't be deployed/,
  )
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.4', apps: '', gateway: true, checks: { 'gateway.yml': 'cancelled' } }),
    /The gateway's latest check at or before v0\.1\.4 is cancelled, so it can't be deployed/,
  )
  const all = await checkDeploy({ root, version: 'v0.1.4', apps: 'all', checks: { 'gamma.yml': 'none' } })
  assert.deepEqual([all.apps, all.gateway, all.held], [['alpha', 'beta'], true, [{ name: 'gamma', check: 'none' }]])
})

test("reads a workflow's newest push run on main at or before the release, through gh", async () => {
  const { root, commits } = await repository()
  // A commit after v0.1.4, on main: its run doesn't cover v0.1.4.
  await write(root, { 'beta/src/api.ts': 'export default { later: true }\n' })
  git(root, 'commit', '--quiet', '-am', 'Later')
  const later = git(root, 'rev-parse', 'HEAD')
  const bin = await mkdtemp(join(tmpdir(), 'check-deploy-gh-'))
  temporary.push(bin)
  // Answers page 1 with the runs in $FAKE_RUNS (newest first, already in the script's --jq format), later pages empty.
  await writeFile(join(bin, 'gh'), '#!/bin/sh\ncase "$*" in *"page=1 "*) printf "%s" "$FAKE_RUNS" ;; esac\n')
  await chmod(join(bin, 'gh'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    process.env.FAKE_RUNS = [`${later} completed failure`, `${commits['v0.1.3']} completed success`, `${commits['v0.1.1']} in_progress null`].join('\n')
    const latest = (version) => githubLatestCheck({ root, repository: 'example/insulin-apps', workflow: 'alpha.yml', commit: commits[version] })
    assert.deepEqual(await latest('v0.1.4'), { result: 'success', sha: commits['v0.1.3'] }, 'the later failure is past v0.1.4')
    assert.deepEqual(await latest('v0.1.3'), { result: 'success', sha: commits['v0.1.3'] })
    assert.deepEqual(await latest('v0.1.2'), { result: 'pending', sha: commits['v0.1.1'] }, 'only the run at v0.1.1 covers v0.1.2, and it is still going')
    process.env.FAKE_RUNS = ''
    assert.deepEqual(await latest('v0.1.4'), { result: 'none', sha: null })
  } finally {
    process.env.PATH = path
    delete process.env.FAKE_RUNS
  }
})

test('holds back a part whose files changed after its latest run, as when a push started no run', async () => {
  const { root, commits } = await repository()
  const at = (version, result = 'success') => ({ result, sha: commits[version] })
  // Alpha's migration changed in v0.1.3, after its run at v0.1.2; beta hasn't changed since its run at v0.1.1.
  const apps = await checkDeploy({
    root, version: 'v0.1.4', apps: 'all', gateway: false, release: true,
    checks: { 'alpha.yml': at('v0.1.2'), 'beta.yml': at('v0.1.1') },
  })
  assert.deepEqual(apps.apps, ['beta', 'gamma'])
  assert.deepEqual(apps.held, [{ name: 'alpha', check: 'not run since a change' }])
  // The gateway's run at v0.1.3 doesn't cover v0.1.4's gateway migration, so nothing deploys.
  const gateway = await checkDeploy({ root, version: 'v0.1.4', apps: 'all', release: true, checks: { 'gateway.yml': at('v0.1.3') } })
  assert.deepEqual([gateway.apps, gateway.gateway, gateway.held[0]], [[], false, { name: 'the gateway', check: 'not run since a change' }])
  // By hand, the same refuses a part named.
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.4', apps: 'alpha', gateway: false, checks: { 'alpha.yml': at('v0.1.2') } }),
    /alpha's latest check at or before v0\.1\.4 is not run since a change/,
  )
})

test("goes back only by hand, when asked to: a release's own deploy of an older version does nothing", async () => {
  const { root } = await repository()
  const stale = await checkDeploy({ root, version: 'v0.1.3', apps: 'all', release: true })
  assert.deepEqual([stale.apps, stale.gateway, stale.held], [[], false, [{ name: 'everything', check: 'v0.1.4 is newer and deploys it' }]])
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.3', apps: 'beta', gateway: false }),
    /v0\.1\.3 is older than the latest release, v0\.1\.4\. To retry a deploy, deploy v0\.1\.4; ask for a rollback only to go back to v0\.1\.3 on purpose/,
  )
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.3', apps: 'beta', gateway: false, rollback: true })).apps, ['beta'])
})

test("reads a workflow's push paths: a list, none for a push without paths, or no push trigger", () => {
  assert.deepEqual(pushPaths("on:\n  push:\n    branches: [main]\n    paths:\n      - 'a/**'\n      - \"b/c\" # note\n\n      - d\n  pull_request:\n    paths:\n      - x\n"), ['a/**', 'b/c', 'd'])
  assert.deepEqual(pushPaths('on:\n  push:\n    branches: [main]\n  pull_request:\n    paths:\n      - x\n'), [])
  assert.equal(pushPaths('on:\n  workflow_dispatch:\n  pull_request:\n'), null)
  assert.equal(pushPaths(''), null)
})

// --- Engines (DESIGN.md §12.1) ------------------------------------------------------------------------------------

/** The synthetic engine (fixtures/engine) as the files of an app `kappa`'s engine/, for a repository. */
function engineApp() {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'engine')
  const files = {
    'kappa/package.json': JSON.stringify({ insulin: { engine: 'engine/', engineApi: 1 } }),
    'kappa/src/api.ts': 'export default {}\n',
    'kappa/src/app/db/migrations/0000_init.sql': 'CREATE TABLE records (id TEXT);\n',
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[`kappa/engine/${relative(fixture, path)}`] = readFileSync(path, 'utf8').replaceAll('insulin-apps-alpha-engine', 'insulin-apps-kappa-engine')
    }
  }
  walk(fixture)
  return files
}

// Main with releases of kappa: v0.1.1 adds it; v0.1.2 changes only its engine's Worker code; v0.1.3 changes a file its
// image copies; v0.1.4 adds a Durable Object migration.
async function engineRepository() {
  const root = await mkdtemp(join(tmpdir(), 'check-deploy-engine-'))
  temporary.push(root)
  git(root, 'init', '--quiet', '--initial-branch=main')
  await write(root, { ...engineApp(), '.github/hosting/gateway/migrations/0001_init.sql': 'CREATE TABLE users (id TEXT);\n' })
  const commits = { 'v0.1.1': release(root, 'v0.1.1') }
  await write(root, { 'kappa/engine/src/index.ts': 'export default { changed: true }\n' })
  commits['v0.1.2'] = release(root, 'v0.1.2')
  await write(root, { 'kappa/engine/container/server/main.py': 'print("changed")\n' })
  commits['v0.1.3'] = release(root, 'v0.1.3')
  const config = readFileSync(join(root, 'kappa/engine/wrangler.jsonc'), 'utf8')
  await write(root, { 'kappa/engine/wrangler.jsonc': config.replace('{ "tag": "v1", "new_sqlite_classes": ["CollectionEngine", "Capacity"] },', '{ "tag": "v1", "new_sqlite_classes": ["CollectionEngine", "Capacity"] },\n    { "tag": "v2", "new_sqlite_classes": ["Outbox"] },') })
  commits['v0.1.4'] = release(root, 'v0.1.4')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { root, commits }
}

test("an engine's Durable Object migrations only move forward: a rollback past one is refused, as for D1", async () => {
  const { root } = await engineRepository()
  await assert.rejects(
    () => checkDeploy({ root, version: 'v0.1.3', apps: 'kappa', gateway: false, rollback: true }),
    /v0\.1\.3 is older than v0\.1\.4, and its kappa\/engine\/wrangler\.jsonc Durable Object migrations differ\. Going back past a migration needs the database restored first/,
  )
  // v0.1.4 itself, and going back to it from nothing newer, is fine; so is a release with the same migrations.
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.4', apps: 'kappa', gateway: false })).apps, ['kappa'])
  await write(root, { 'kappa/engine/src/index.ts': 'export default { later: true }\n' })
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'Release v0.1.5')
  git(root, 'tag', 'v0.1.5')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.deepEqual((await checkDeploy({ root, version: 'v0.1.4', apps: 'kappa', gateway: false, rollback: true })).apps, ['kappa'])
})

test('PLT-04: a release builds the engine image only when its inputs changed since the last release that deployed the app; by hand, always', async () => {
  const { root } = await engineRepository()
  const images = async (version, deployed, options = {}) => (await checkDeploy({ root, version, apps: 'all', gateway: false, deployed: { kappa: deployed }, ...options })).images
  // v0.1.2 changed only the engine's Worker: an unchanged engine keeps its image (and so its digest).
  git(root, 'tag', '-d', 'v0.1.3', 'v0.1.4')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'v0.1.2')
  assert.deepEqual(await images('v0.1.2', 'v0.1.1', { release: true }), [], 'unchanged since v0.1.1')
  assert.deepEqual(await images('v0.1.2', null, { release: true }), ['kappa'], 'never deployed: build it')
  assert.deepEqual(await images('v0.1.2', 'v0.1.1'), ['kappa'], 'a deploy by hand always builds it')
  const { root: later } = await engineRepository()
  const laterImages = async (version, deployed, options = {}) => (await checkDeploy({ root: later, version, apps: 'all', gateway: false, deployed: { kappa: deployed }, ...options })).images
  assert.deepEqual(await laterImages('v0.1.4', 'v0.1.2', { release: true }), ['kappa'], 'v0.1.3 changed a file the image copies')
  assert.deepEqual(await laterImages('v0.1.4', 'v0.1.3', { release: true }), [], 'a migration is the Worker\'s, not the image\'s')
  // An app held back builds nothing.
  assert.deepEqual(await laterImages('v0.1.4', 'v0.1.2', { release: true, checks: { 'kappa.yml': 'failure' } }), [])
})

test("reads the last release whose deploy of an app succeeded from the deploy jobs' names, through gh", async () => {
  const bin = await mkdtemp(join(tmpdir(), 'check-deploy-gh-'))
  temporary.push(bin)
  // Runs: release.yml's and deploy.yml's, each a page; jobs by run id.
  await writeFile(join(bin, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *workflows/release.yml/runs*) printf "%s\\n" "2026-11-03T10:00:00Z 30" "2026-11-01T10:00:00Z 10" ;;',
    '  *workflows/deploy.yml/runs*) printf "%s\\n" "2026-11-02T10:00:00Z 20" ;;',
    '  *runs/30/jobs*) printf "%s\\n" "success deploy / Check the release" "failure deploy / Deploy kappa v0.1.3" "success deploy / Deploy kappa-two v0.1.3" ;;',
    '  *runs/20/jobs*) printf "%s\\n" "success deploy / Deploy kappa v0.1.2" ;;',
    '  *runs/10/jobs*) printf "%s\\n" "success deploy / Deploy kappa v0.1.1" ;;',
    'esac',
    '',
  ].join('\n'))
  await chmod(join(bin, 'gh'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const last = (app) => githubLastDeploy({ root: bin, repository: 'example/insulin-apps', app })
    assert.equal(await last('kappa'), 'v0.1.2', "v0.1.3's deploy failed; a deploy by hand of v0.1.2 is the latest that succeeded")
    assert.equal(await last('kappa-two'), 'v0.1.3')
    assert.equal(await last('lambda'), null)
  } finally {
    process.env.PATH = path
  }
})
