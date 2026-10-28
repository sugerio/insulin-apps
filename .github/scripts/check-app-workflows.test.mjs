import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { checkAppWorkflows } from './check-app-workflows.mjs'

const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

async function repository(appNames = ['alpha-app']) {
  const root = await mkdtemp(join(tmpdir(), 'app-workflows-'))
  temporary.push(root)
  await mkdir(join(root, '.github', 'workflows'), { recursive: true })
  for (const name of appNames) {
    await mkdir(join(root, name, 'src'), { recursive: true })
    await writeFile(join(root, name, 'package.json'), '{}\n')
    await writeFile(join(root, name, 'src', 'api.ts'), 'export default {}\n')
  }
  return root
}

function workflow(app, { path = `${app}/**`, configuredApp = app, template = './.github/workflows/app.yml' } = {}) {
  return `name: ${app}\n\non:\n  pull_request:\n    paths:\n      - ${path}\n\njobs:\n  app:\n    uses: ${template}\n    with:\n      app: ${configuredApp}\n`
}

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
