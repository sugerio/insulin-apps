import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { checkAppWorkflows } from './check-app-workflows.mjs'

const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

async function repository(appNames = ['alpha-app'], released = appNames) {
  const root = await mkdtemp(join(tmpdir(), 'app-workflows-'))
  temporary.push(root)
  await mkdir(join(root, '.github', 'workflows'), { recursive: true })
  await writeFile(join(root, '.github', 'workflows', 'release.yml'), release(released))
  for (const name of appNames) {
    await mkdir(join(root, name, 'src'), { recursive: true })
    await writeFile(join(root, name, 'package.json'), '{}\n')
    await writeFile(join(root, name, 'src', 'api.ts'), 'export default {}\n')
  }
  return root
}

function workflow(app, { path = `${app}/**`, configuredApp = app, template = './.github/workflows/app.yml', name = app } = {}) {
  return `name: ${name}\n\non:\n  push:\n    branches: [main]\n    paths:\n      - ${path}\n  pull_request:\n    paths:\n      - ${path}\n\njobs:\n  app:\n    uses: ${template}\n    with:\n      app: ${configuredApp}\n`
}

function release(names) {
  return `name: Release\n\non:\n  workflow_run:\n    workflows: [${names.join(', ')}]\n    types: [completed]\n    branches: [main]\n  schedule:\n    - cron: "23 * * * *"\n`
}

const CI = 'name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n\njobs: {}\n'

test('accepts one tiny shared-template workflow per discovered app', async () => {
  const root = await repository(['alpha-app', 'beta'])
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))
  await writeFile(join(root, '.github', 'workflows', 'beta.yml'), workflow('beta'))

  const result = await checkAppWorkflows(root)
  assert.deepEqual(result.apps, ['alpha-app', 'beta'])
})

test('reports a missing app workflow clearly', async () => {
  const root = await repository()
  await assert.rejects(
    () => checkAppWorkflows(root),
    /Missing workflow for app "alpha-app": \.github\/workflows\/alpha-app\.yml/,
  )
})

test('requires the shared template, matching app input, and app path filter', async () => {
  const root = await repository()
  await writeFile(
    join(root, '.github', 'workflows', 'alpha-app.yml'),
    workflow('alpha-app', { path: 'other/**', configuredApp: 'beta', template: './other.yml' }),
  )

  await assert.rejects(async () => checkAppWorkflows(root), (error) => {
    assert.match(error.message, /must call \.\/\.github\/workflows\/app\.yml/)
    assert.match(error.message, /must set app: alpha-app/)
    assert.match(error.message, /must include the path filter alpha-app\/\*\*/)
    return true
  })
})

test('rejects an app workflow that points at a missing app', async () => {
  const root = await repository()
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))
  await writeFile(join(root, '.github', 'workflows', 'removed.yml'), workflow('removed'))

  await assert.rejects(() => checkAppWorkflows(root), /removed\.yml points at missing app "removed"/)
})

test('requires release.yml to start after every workflow that runs on a push', async () => {
  const root = await repository(['alpha-app', 'beta'], ['CI', 'alpha-app'])
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))
  await writeFile(join(root, '.github', 'workflows', 'beta.yml'), workflow('beta'))
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), CI)
  // A reusable pipeline runs inside its callers' runs, so release.yml needn't name it.
  await writeFile(join(root, '.github', 'workflows', 'pipeline.yml'), 'name: Pipeline\non:\n  workflow_call:\n')

  await assert.rejects(async () => checkAppWorkflows(root), (error) => {
    assert.equal(
      error.message,
      'Workflow .github/workflows/beta.yml runs on a push, so release.yml must start after it: add "beta" to its workflow_run workflows',
    )
    return true
  })
})

test('rejects a release.yml trigger that names no workflow', async () => {
  const root = await repository(['alpha-app'], ['alpha-app', 'Gatewy'])
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))

  await assert.rejects(() => checkAppWorkflows(root), /release\.yml starts after "Gatewy", but no workflow has that name/)
})

test('reads inline triggers and a block list of release workflows', async () => {
  const root = await repository(['alpha-app'])
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), "name: 'CI'\non: [push, pull_request]\n")
  await writeFile(join(root, '.github', 'workflows', 'nightly.yml'), 'name: Nightly\non: schedule # not a push\n')
  await writeFile(
    join(root, '.github', 'workflows', 'release.yml'),
    'name: Release\non:\n  workflow_run:\n    workflows:\n      - CI\n      - "alpha-app"\n    types: [completed]\n',
  )

  const result = await checkAppWorkflows(root)
  assert.deepEqual(result.apps, ['alpha-app'])
})

test('requires release.yml', async () => {
  const root = await repository()
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))
  await rm(join(root, '.github', 'workflows', 'release.yml'))

  await assert.rejects(() => checkAppWorkflows(root), /Missing \.github\/workflows\/release\.yml/)
})

test("requires an app's workflow to be named after it, since release.yml deploys apps by their workflows' names", async () => {
  const root = await repository(['alpha-app'], ['Alpha'])
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app', { name: 'Alpha' }))

  await assert.rejects(async () => checkAppWorkflows(root), (error) => {
    assert.match(error.message, /alpha-app\.yml must be named alpha-app, so a release's notes and the Actions list name the app it checks/)
    assert.match(error.message, /alpha-app\.yml runs on a push, but only CI, Gateway and each app's own workflow may: a release waits for every workflow a push runs, so "Alpha" would hold back/)
    return true
  })
})

test('lets only CI, Gateway and the apps\' own workflows run on a push', async () => {
  const root = await repository(['alpha-app'], ['CI', 'Gateway', 'alpha-app', 'Docs'])
  await writeFile(join(root, '.github', 'workflows', 'alpha-app.yml'), workflow('alpha-app'))
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), CI)
  await writeFile(join(root, '.github', 'workflows', 'gateway.yml'), CI.replace('name: CI', 'name: Gateway'))
  await writeFile(join(root, '.github', 'workflows', 'docs.yml'), CI.replace('name: CI', 'name: Docs'))

  await assert.rejects(
    () => checkAppWorkflows(root),
    /^Error: Workflow \.github\/workflows\/docs\.yml runs on a push, but only CI, Gateway and each app's own workflow may: a release waits for every workflow a push runs, so "Docs" would hold back every release it fails$/,
  )
})
