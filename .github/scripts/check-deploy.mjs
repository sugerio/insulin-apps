#!/usr/bin/env node
// Checks what deploy-release.yml was asked to deploy, before anything is built: the version is a release (a v* tag,
// which only release.yml creates) on a commit of main; the apps exist in that release; each app, and the gateway,
// passed its latest check at or before that commit; and going back to an earlier release keeps the latest release's
// migrations for everything it deploys, since a deploy can't undo a migration. deploy-release.yml then builds and
// deploys that commit, from GITHUB_OUTPUT: `commit`, `apps` (a JSON array) and `gateway` (true or false).
//
// A check is the newest push run on main of the app's workflow (`<app>.yml`) or of `gateway.yml` whose commit is the
// release's or an earlier one. It covers the release only if nothing that workflow watches (its push paths, and the
// workflow itself) changed between the two commits, since a push can start no run (`[skip ci]`, or a workflow edited
// not to run). One that failed, was cancelled, is still running, doesn't cover the release or doesn't exist holds that
// part back: a release (--release) deploys the rest and says what it held, and deploys nothing while the gateway is
// held, so no app goes out ahead of a gateway that can't follow it. By hand, an app or the gateway asked for by name
// is refused instead, and `all` leaves out the apps held back.
//
// A release older than the latest one goes back. Its own deploy does nothing then, since the newer release deploys
// everything that passed; by hand it needs --rollback.
//
// usage: node .github/scripts/check-deploy.mjs <version> <apps> <gateway> [--release] [--rollback]
//   apps: names separated by spaces or commas, `all`, or empty for none; gateway: true or false.
// It runs in a clone with main's history and tags (actions/checkout with fetch-depth: 0), from main's own copy of this
// script, so an older release is checked by today's rules, with `gh` reading the workflow runs (GH_TOKEN with
// actions: read). check-deploy.test.mjs runs it against small repositories.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listApps } from './list-apps.mjs'

const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/
const PASSED = new Set(['success', 'skipped'])
export const GATEWAY_WORKFLOW = 'gateway.yml'
export const GATEWAY_MIGRATIONS = '.github/hosting/gateway/migrations'
export const appMigrations = (app) => `${app}/src/app/db/migrations`

export async function checkDeploy({
  root = process.cwd(), version, apps = 'all', gateway = true, release = false, rollback = false, main = 'origin/main',
  repository = process.env.GITHUB_REPOSITORY, latestCheck = githubLatestCheck,
}) {
  root = resolve(root)
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const read = (...args) => {
    const result = git(...args)
    return result.status === 0 ? result.stdout.trim() : null
  }

  if (!VERSION.test(version ?? '')) throw new Error(`${version ? JSON.stringify(version) : 'An empty version'} isn't a release such as v0.1.2`)
  const commit = read('rev-parse', '--verify', '--quiet', `refs/tags/${version}^{commit}`)
  if (!commit) throw new Error(`There is no release ${version}`)
  if (!read('rev-parse', '--verify', '--quiet', `${main}^{commit}`)) throw new Error(`Couldn't find ${main}`)
  if (git('merge-base', '--is-ancestor', commit, main).status !== 0) {
    throw new Error(`${version} (${commit}) isn't a commit of main`)
  }

  // The apps of the release itself, read from a worktree of its commit.
  const temporary = mkdtempSync(join(tmpdir(), 'insulin-apps-release-'))
  const tree = join(temporary, 'release')
  let known
  try {
    const added = git('worktree', 'add', '--detach', '--quiet', tree, commit)
    if (added.status !== 0) throw new Error(`Couldn't check out ${version}: ${added.stderr.trim()}`)
    known = (await listApps(tree)).map(({ name }) => name)
  } finally {
    git('worktree', 'remove', '--force', tree)
    rmSync(temporary, { recursive: true, force: true })
  }
  const asked = String(apps ?? '').trim()
  const everyApp = asked === 'all'
  let selected = everyApp ? known : [...new Set(asked.split(/[\s,]+/).filter(Boolean))].sort()
  const unknown = selected.filter((name) => !known.includes(name))
  if (unknown.length) throw new Error(`${version} has no app ${unknown.map((name) => JSON.stringify(name)).join(', ')}`)

  // Production runs at most the latest release, and its database has at most that release's migrations.
  const latest = (read('tag', '--list', 'v*') ?? '').split('\n').filter((tag) => VERSION.test(tag)).sort(byVersion).at(-1)
  const latestCommit = read('rev-parse', '--verify', '--quiet', `refs/tags/${latest}^{commit}`)
  const goesBack = latestCommit !== commit
  if (goesBack && release) {
    return { version, commit, latest, apps: [], gateway: false, held: [{ name: 'everything', check: `${latest} is newer and deploys it` }] }
  }
  if (goesBack && !rollback) {
    throw new Error(`${version} is older than the latest release, ${latest}. To retry a deploy, deploy ${latest}; ask for a rollback only to go back to ${version} on purpose`)
  }

  // Only code that passed its check deploys.
  const held = []
  const check = async (workflow, app) => {
    const { result, sha } = await latestCheck({ root, repository, workflow, commit })
    if (!PASSED.has(result) || sha === commit) return result
    const watched = [...new Set([...watchedPaths(read, workflow, sha, app), ...watchedPaths(read, workflow, commit, app)])]
    return git('diff', '--quiet', sha, commit, '--', ...watched).status === 0 ? result : 'not run since a change'
  }
  if (gateway) {
    const result = await check(GATEWAY_WORKFLOW)
    if (!PASSED.has(result)) {
      if (!release) throw new Error(`The gateway's latest check at or before ${version} is ${result}, so it can't be deployed`)
      held.push({ name: 'the gateway', check: result }, ...selected.map((name) => ({ name, check: 'waiting for the gateway' })))
      return { version, commit, latest, apps: [], gateway: false, held }
    }
  }
  const passing = []
  for (const name of selected) {
    const result = await check(`${name}.yml`, name)
    if (PASSED.has(result)) passing.push(name)
    else if (release || everyApp) held.push({ name, check: result })
    else throw new Error(`${name}'s latest check at or before ${version} is ${result}, so it can't be deployed`)
  }
  selected = passing

  if (goesBack) {
    const folders = [...selected.map(appMigrations), ...(gateway ? [GATEWAY_MIGRATIONS] : [])]
    const changed = folders.filter((folder) => read('rev-parse', `${commit}:${folder}`) !== read('rev-parse', `${latestCommit}:${folder}`))
    if (changed.length) {
      throw new Error(
        `${version} is older than ${latest}, and its ${changed.join(', ')} differ. Going back past a migration needs the database ` +
          `restored first, which a deploy doesn't do: deploy ${latest}, or a release with its migrations.`,
      )
    }
  }
  return { version, commit, latest, apps: selected, gateway: Boolean(gateway), held }
}

/**
 * The paths a workflow watches at a commit, as git pathspecs: its push paths, the workflow file itself and, for an app,
 * the app's directory. A push trigger without paths watches everything.
 */
export function watchedPaths(read, workflow, commit, app) {
  const file = `.github/workflows/${workflow}`
  const paths = pushPaths(read('show', `${commit}:${file}`) ?? '')
  if (paths && !paths.length) return ['.']
  return [file, ...(app ? [`${app}/**`] : []), ...(paths ?? [])].map((path) => `:(glob)${path}`)
}

/** A workflow's `on.push.paths`: the list, [] for a push trigger without paths, or null without a push trigger. */
export function pushPaths(text) {
  const lines = text.split(/\r?\n/)
  const blank = (line) => /^\s*(?:#.*)?$/.test(line)
  const on = lines.findIndex((line) => /^["']?on["']?:\s*(?:#.*)?$/.test(line))
  if (on < 0) return null
  let push = -1
  for (let i = on + 1; i < lines.length && (blank(lines[i]) || /^\s/.test(lines[i])); i++) {
    if (/^\s+push:\s*(?:#.*)?$/.test(lines[i])) { push = i; break }
  }
  if (push < 0) return null
  const indent = lines[push].match(/^\s*/)[0].length
  for (let i = push + 1; i < lines.length; i++) {
    if (blank(lines[i])) continue
    if (lines[i].match(/^\s*/)[0].length <= indent) break
    if (!/^\s+paths:\s*(?:#.*)?$/.test(lines[i])) continue
    const paths = []
    for (let j = i + 1; j < lines.length; j++) {
      if (blank(lines[j])) continue
      const item = lines[j].match(/^\s*-\s*(["']?)(.*?)\1\s*(?:#.*)?$/)
      if (!item) break
      paths.push(item[2])
    }
    return paths
  }
  return []
}

/**
 * A workflow's newest push run on main at or before `commit`: `{ result, sha }`, where the result is its conclusion,
 * `pending` while it runs, or `none` (and no sha) when GitHub lists no such run. Reads at most 1,000 runs, newest first.
 */
export async function githubLatestCheck({ root, repository, workflow, commit }) {
  if (!repository) throw new Error('GITHUB_REPOSITORY is needed to read the workflow runs')
  for (let page = 1; page <= 10; page++) {
    const listed = spawnSync('gh', [
      'api', `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&event=push&per_page=100&page=${page}`,
      '--jq', '.workflow_runs[] | "\\(.head_sha) \\(.status) \\(.conclusion)"',
    ], { cwd: root, encoding: 'utf8' })
    if (listed.status !== 0) throw new Error(`Couldn't read the runs of ${workflow}: ${listed.stderr.trim()}`)
    const runs = listed.stdout.split('\n').filter(Boolean).map((line) => line.split(' '))
    if (!runs.length) break
    for (const [sha, status, conclusion] of runs) {
      const covers = sha === commit || spawnSync('git', ['merge-base', '--is-ancestor', sha, commit], { cwd: root }).status === 0
      if (covers) return { result: status === 'completed' ? conclusion : 'pending', sha }
    }
  }
  return { result: 'none', sha: null }
}

function byVersion(left, right) {
  const [a, b] = [left, right].map((tag) => tag.match(VERSION).slice(1).map(Number))
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

async function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter((arg) => arg.startsWith('--')))
  const [version, apps = '', gateway = 'true'] = args.filter((arg) => !arg.startsWith('--'))
  if (!['true', 'false'].includes(gateway) || [...flags].some((flag) => !['--release', '--rollback'].includes(flag))) {
    throw new Error('usage: node .github/scripts/check-deploy.mjs <version> <apps> <true|false> [--release] [--rollback]')
  }
  const result = await checkDeploy({ version, apps, gateway: gateway === 'true', release: flags.has('--release'), rollback: flags.has('--rollback') })
  const lines = [`commit=${result.commit}`, `apps=${JSON.stringify(result.apps)}`, `gateway=${result.gateway}`]
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  const what = [...result.apps, ...(result.gateway ? ['the gateway'] : [])].join(', ') || 'nothing'
  const summary = [`Deploying ${result.version} (${result.commit}): ${what}.`]
  for (const { name, check } of result.held) {
    summary.push(`Held back: ${name} (latest check: ${check}), which keeps the version it runs.`)
    process.stdout.write(`::warning::${result.version}: ${name} is held back (latest check: ${check}).\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`)
  process.stdout.write(`${summary.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stdout.write(`::error::${error.message}\n`)
    process.exitCode = 1
  })
}
