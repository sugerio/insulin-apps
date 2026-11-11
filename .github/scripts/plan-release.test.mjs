// Runs plan-release.sh, as release.yml's `plan` job does, against a fake GitHub CLI that answers from a small model of
// the repository: its v* tags and releases, and its pushes to main with the workflow runs each one started. The fake
// applies each call's --jq filter with jq, so the script's own filters are exercised.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'plan-release.sh')
const skip = spawnSync('jq', ['--version']).status === 0 ? false : 'needs jq on PATH'
const REPO = 'example/insulin-apps'
const BOT = 'github-actions[bot]'

// Answers `gh api <endpoint> [--paginate] [--jq <filter>]` from the model in $FAKE_GH_STATE; 404 like gh for anything
// it doesn't know. Run ids count up from 100 in push order, as GitHub's do.
const FAKE_GH = `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const args = process.argv.slice(2)
let endpoint, jq
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--jq') jq = args[++i]
  else if (args[i] !== '--paginate') endpoint = args[i]
}
const url = new URL(endpoint, 'https://api.test/')
const path = url.pathname.replace('/repos/' + state.repo + '/', '')
const query = url.searchParams
let id = 100
const runs = state.pushes.flatMap((push) =>
  push.runs.map(([name, status, conclusion]) => ({ id: id++, head_sha: push.sha, name, status, conclusion })),
)
const index = (sha) => state.pushes.findIndex((push) => push.sha === sha)
let body, match
if (args[0] !== 'api' || !endpoint) body = undefined
else if ((match = path.match(/^collaborators\\/([^/]+)\\/permission$/))) body = { permission: state.permission[match[1]] ?? 'read' }
else if (path === 'git/matching-refs/tags/v')
  body = state.tags.map(([name, sha]) => ({ ref: 'refs/tags/' + name, object: { type: 'commit', sha } }))
else if ((match = path.match(/^releases\\/tags\\/(.+)$/)) && state.releases[match[1]])
  body = { id: 1, author: { login: state.releases[match[1]] } }
else if (path === 'actions/runs' && query.get('branch') === 'main' && query.get('event') === 'push') {
  const perPage = Number(query.get('per_page') ?? 30)
  const page = Number(query.get('page') ?? 1)
  const listed = runs.filter((run) => !query.has('head_sha') || run.head_sha === query.get('head_sha')).reverse()
  body = { total_count: listed.length, workflow_runs: listed.slice((page - 1) * perPage, page * perPage) }
} else if ((match = path.match(/^compare\\/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$/))) {
  const [base, head] = [index(match[1]), index(match[2])]
  body = { status: base < 0 || head < 0 ? 'diverged' : head > base ? 'ahead' : head < base ? 'behind' : 'identical' }
}
if (body === undefined) {
  process.stderr.write('gh: Not Found (HTTP 404)\\n')
  process.exit(1)
}
process.stdout.write(jq ? execFileSync('jq', ['-r', jq], { input: JSON.stringify(body) }) : JSON.stringify(body) + '\\n')
`

let bin
const temporary = []
before(async () => {
  bin = await mkdtemp(join(tmpdir(), 'plan-release-bin-'))
  temporary.push(bin)
  await writeFile(join(bin, 'gh'), FAKE_GH)
  // Retries wait between attempts; the tests don't.
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
  await chmod(join(bin, 'gh'), 0o755)
  await chmod(join(bin, 'sleep'), 0o755)
})
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

const sha = (hex) => hex.repeat(40)
const passed = (name) => [name, 'completed', 'success']
const push = (hex, ...runs) => ({ sha: sha(hex), runs })
// A push that touched Cap Table: CI and captable ran.
const green = (hex) => push(hex, passed('CI'), passed('captable'))

async function plan({ tags = [], releases = {}, pushes = [], permission = {} }, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-release-'))
  temporary.push(dir)
  await mkdir(join(dir, 'runner'))
  const files = {
    FAKE_GH_STATE: join(dir, 'state.json'),
    GITHUB_OUTPUT: join(dir, 'output'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
  }
  await writeFile(files.FAKE_GH_STATE, JSON.stringify({ repo: REPO, tags, releases, pushes, permission }))
  for (const file of [files.GITHUB_OUTPUT, files.GITHUB_STEP_SUMMARY]) await writeFile(file, '')
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      ...files,
      GH_REPO: REPO,
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_ACTOR: 'release-admin',
      VERSION: '',
      RUNNER_TEMP: join(dir, 'runner'),
      ...env,
    },
  })
  const output = await readFile(files.GITHUB_OUTPUT, 'utf8')
  const planned = output.match(/^releases<<END_OF_RELEASES\n([^]*?)END_OF_RELEASES\n/m)
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    releases: planned ? planned[1].split('\n').filter(Boolean) : undefined,
    deployVersion: output.match(/^deploy-version=(.*)$/m)?.[1],
  }
}

test('numbers main\'s newest green push v0.1.1 when there is no release yet', { skip }, async () => {
  const result = await plan({ pushes: [green('a'), green('b'), push('c', passed('CI'), ['captable', 'in_progress', null])] })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [`v0.1.1 ${sha('b')} - CI, captable`])
})

test('plans nothing before the first green push', { skip }, async () => {
  const result = await plan({ pushes: [push('a', passed('CI'), ['captable', 'completed', 'failure'])] })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [])
  assert.match(result.log, /No push to main is green yet/)
})

test('numbers each green push in order and gives a failed or cancelled one no version', { skip }, async () => {
  const result = await plan({
    tags: [['v0.1.1', sha('a')]],
    releases: { 'v0.1.1': BOT },
    pushes: [
      green('a'),
      green('b'),
      push('c', passed('CI'), ['captable', 'completed', 'failure']),
      push('d', passed('CI'), passed('captable'), ['esign', 'completed', 'cancelled']),
      push('e', passed('CI'), passed('Gateway')),
    ],
  })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [
    `v0.1.2 ${sha('b')} v0.1.1 CI, captable`,
    `v0.1.3 ${sha('e')} v0.1.2 CI, Gateway`,
  ])
  assert.match(result.log, new RegExp(`for ${sha('c')} \\(captable \\(failure\\)\\): no version`))
  assert.match(result.log, new RegExp(`for ${sha('d')} \\(esign \\(cancelled\\)\\): no version`))
})

test('counts a skipped run as passed', { skip }, async () => {
  const result = await plan({
    tags: [['v0.1.1', sha('a')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), push('b', passed('CI'), ['esign', 'completed', 'skipped'])],
  })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [`v0.1.2 ${sha('b')} v0.1.1 CI, esign`])
})

test('stops at a push whose runs are still going, so a later run numbers it and what follows', { skip }, async () => {
  const state = {
    tags: [['v0.1.1', sha('a')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), green('b'), push('c', passed('CI'), ['captable', 'queued', null]), green('d')],
  }
  const first = await plan(state)
  assert.equal(first.status, 0, first.log)
  assert.deepEqual(first.releases, [`v0.1.2 ${sha('b')} v0.1.1 CI, captable`])
  assert.match(first.log, new RegExp(`still running for ${sha('c')} \\(captable \\(queued\\)\\); a later run numbers it`))

  // Once `publish` has tagged v0.1.2 and the captable run has finished, the next run carries on from v0.1.2.
  state.tags.push(['v0.1.2', sha('b')])
  state.releases['v0.1.2'] = BOT
  state.pushes[2].runs[1] = passed('captable')
  const second = await plan(state)
  assert.equal(second.status, 0, second.log)
  assert.deepEqual(second.releases, [
    `v0.1.3 ${sha('c')} v0.1.2 CI, captable`,
    `v0.1.4 ${sha('d')} v0.1.3 CI, captable`,
  ])

  // And a run after that, or one that GitHub ran late, plans nothing again.
  state.tags.push(['v0.1.3', sha('c')], ['v0.1.4', sha('d')])
  Object.assign(state.releases, { 'v0.1.3': BOT, 'v0.1.4': BOT })
  const third = await plan(state)
  assert.equal(third.status, 0, third.log)
  assert.deepEqual(third.releases, [])
})

test('finishes a version that was tagged but not published, then carries on', { skip }, async () => {
  const result = await plan({
    tags: [['v0.1.1', sha('a')], ['v0.1.2', sha('b')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), green('b'), green('c')],
  })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [
    `v0.1.2 ${sha('b')} v0.1.1 CI, captable`,
    `v0.1.3 ${sha('c')} v0.1.2 CI, captable`,
  ])
})

test('sorts versions by number, not text', { skip }, async () => {
  const tags = Array.from({ length: 10 }, (_, i) => [`v0.1.${i + 1}`, sha('a')])
  const result = await plan({
    tags,
    releases: Object.fromEntries(tags.map(([name]) => [name, BOT])),
    pushes: [green('a'), green('b')],
  })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [`v0.1.11 ${sha('b')} v0.1.10 CI, captable`])
})

test('by hand, only an admin can start a new minor version, after numbering the waiting pushes', { skip }, async () => {
  const state = {
    tags: [['v0.1.1', sha('a')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), green('b')],
    permission: { 'release-admin': 'admin', 'release-writer': 'write' },
  }
  const byHand = { GITHUB_EVENT_NAME: 'workflow_dispatch', VERSION: 'v0.2.0' }

  const refused = await plan(state, { ...byHand, GITHUB_ACTOR: 'release-writer' })
  assert.equal(refused.status, 1)
  assert.match(refused.log, /Only an admin .* release-writer has write/)
  assert.equal(refused.releases, undefined)

  const released = await plan(state, byHand)
  assert.equal(released.status, 0, released.log)
  assert.deepEqual(released.releases, [`v0.1.2 ${sha('b')} v0.1.1 CI, captable`, `v0.2.0 ${sha('b')} v0.1.2 -`])

  const skipping = await plan(state, { ...byHand, VERSION: 'v0.3.0' })
  assert.equal(skipping.status, 1)
  assert.match(skipping.log, /v0\.3\.0 isn't the next minor \(v0\.2\.0\) or major \(v1\.0\.0\) version after v0\.1\.2/)
  assert.equal(skipping.releases, undefined)
})

test('by hand, refuses while a push still has runs going', { skip }, async () => {
  const result = await plan(
    {
      tags: [['v0.1.1', sha('a')]],
      releases: { 'v0.1.1': BOT },
      pushes: [green('a'), push('b', ['CI', 'in_progress', null])],
      permission: { 'release-admin': 'admin' },
    },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', VERSION: 'v0.2.0' },
  )
  assert.equal(result.status, 1)
  assert.match(result.log, /still running for b{40} \(CI \(in_progress\)\); run this again/)
  assert.equal(result.releases, undefined)
})

test('refuses to number anything after a v* tag that names no commit', { skip }, async () => {
  const result = await plan({ tags: [['v0.1.1', 'not-a-commit']], pushes: [green('a')] })
  assert.equal(result.status, 1)
  assert.match(result.log, /v0\.1\.1 isn't a tag on a commit/)
  assert.equal(result.releases, undefined)
})

test('deploys the newest version planned, and nothing when none is', { skip }, async () => {
  const several = await plan({
    tags: [['v0.1.1', sha('a')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), push('b', passed('CI'), passed('Gateway')), push('c', passed('CI')), push('d', passed('CI'), ['esign', 'completed', 'failure'])],
  })
  assert.equal(several.status, 0, several.log)
  assert.deepEqual(several.releases, [`v0.1.2 ${sha('b')} v0.1.1 CI, Gateway`, `v0.1.3 ${sha('c')} v0.1.2 CI`])
  assert.equal(several.deployVersion, 'v0.1.3')

  const nothing = await plan({ tags: [['v0.1.1', sha('a')]], releases: { 'v0.1.1': BOT }, pushes: [green('a')] })
  assert.deepEqual([nothing.releases, nothing.deployVersion], [[], ''])
})

test('finishes a tagged but unpublished version only once its push is green', { skip }, async () => {
  const result = await plan({
    // v0.1.2 is a tag on a push whose captable run failed, as an admin could make one.
    tags: [['v0.1.1', sha('a')], ['v0.1.2', sha('b')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), push('b', passed('CI'), ['captable', 'completed', 'failure']), green('c')],
  })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [`v0.1.3 ${sha('c')} v0.1.2 CI, captable`])
  assert.equal(result.deployVersion, 'v0.1.3')
  assert.match(result.log, /v0\.1\.2 is tagged on b{40}, whose workflows haven't all passed \(captable \(failure\)\): no release for it/)
})

test('by hand past a backlog GitHub no longer lists, releases and deploys the newest green push', { skip }, async () => {
  // More runs since v0.1.1 than the ten pages of 100 the script reads.
  const many = Array.from({ length: 1001 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, 'c'), runs: [passed('CI')] }))
  const newest = 'f'.repeat(40)
  const result = await plan(
    {
      tags: [['v0.1.1', sha('a')]],
      releases: { 'v0.1.1': BOT },
      pushes: [green('a'), ...many, { sha: newest, runs: [passed('CI'), passed('captable')] }],
      permission: { 'release-admin': 'admin' },
    },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', VERSION: 'v0.2.0' },
  )
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [`v0.2.0 ${newest} v0.1.1 CI, captable`])
  assert.equal(result.deployVersion, 'v0.2.0')
})

test("gives no version to a push CI didn't run on, even when its other runs passed", { skip }, async () => {
  const result = await plan({
    tags: [['v0.1.1', sha('a')]],
    releases: { 'v0.1.1': BOT },
    pushes: [green('a'), push('b', passed('captable')), green('c')],
  })
  assert.equal(result.status, 0, result.log)
  assert.deepEqual(result.releases, [`v0.1.2 ${sha('c')} v0.1.1 CI, captable`])
  assert.match(result.log, new RegExp(`Not every workflow passed for ${sha('b')}`))
})
