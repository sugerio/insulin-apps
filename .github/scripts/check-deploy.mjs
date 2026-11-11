#!/usr/bin/env node
// Checks what deploy.yml was asked to deploy, before anything is built: the version is a release (a v* tag, which only
// release.yml creates) on a commit of main; the apps exist in that release; and going back to an earlier release keeps
// the latest release's migrations for everything it deploys, since a deploy can't undo a migration. deploy.yml then
// builds and deploys that commit, from GITHUB_OUTPUT: `commit`, `apps` (a JSON array) and `gateway` (true or false).
//
// usage: node .github/scripts/check-deploy.mjs <version> <apps> <gateway>
//   apps: names separated by spaces or commas, `all`, or empty for none; gateway: true or false.
// It runs in a clone with main's history and tags (actions/checkout with fetch-depth: 0), from main's own copy of this
// script, so an older release is checked by today's rules. check-deploy.test.mjs runs it against small repositories.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listApps } from './list-apps.mjs'

const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/
export const GATEWAY_MIGRATIONS = '.github/hosting/gateway/migrations'
export const appMigrations = (app) => `${app}/src/app/db/migrations`

export async function checkDeploy({ root = process.cwd(), version, apps = 'all', gateway = true, main = 'origin/main' }) {
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
  const selected = asked === 'all' ? known : [...new Set(asked.split(/[\s,]+/).filter(Boolean))].sort()
  const unknown = selected.filter((name) => !known.includes(name))
  if (unknown.length) throw new Error(`${version} has no app ${unknown.map((name) => JSON.stringify(name)).join(', ')}`)

  // Production runs at most the latest release, and its database has at most that release's migrations.
  const latest = (read('tag', '--list', 'v*') ?? '').split('\n').filter((tag) => VERSION.test(tag)).sort(byVersion).at(-1)
  const latestCommit = read('rev-parse', '--verify', '--quiet', `refs/tags/${latest}^{commit}`)
  if (latestCommit !== commit) {
    const folders = [...selected.map(appMigrations), ...(gateway ? [GATEWAY_MIGRATIONS] : [])]
    const changed = folders.filter((folder) => read('rev-parse', `${commit}:${folder}`) !== read('rev-parse', `${latestCommit}:${folder}`))
    if (changed.length) {
      throw new Error(
        `${version} is older than ${latest}, and its ${changed.join(', ')} differ. Going back past a migration needs the database ` +
          `restored first, which a deploy doesn't do: deploy ${latest}, or a release with its migrations.`,
      )
    }
  }
  return { version, commit, latest, apps: selected, gateway: Boolean(gateway) }
}

function byVersion(left, right) {
  const [a, b] = [left, right].map((tag) => tag.match(VERSION).slice(1).map(Number))
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

async function main() {
  const [version, apps = '', gateway = 'true'] = process.argv.slice(2)
  if (!['true', 'false'].includes(gateway)) throw new Error('usage: node .github/scripts/check-deploy.mjs <version> <apps> <true|false>')
  const result = await checkDeploy({ version, apps, gateway: gateway === 'true' })
  const lines = [`commit=${result.commit}`, `apps=${JSON.stringify(result.apps)}`, `gateway=${result.gateway}`]
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  const what = [...result.apps, ...(result.gateway ? ['the gateway'] : [])].join(', ') || 'nothing'
  const summary = `Deploying ${result.version} (${result.commit}): ${what}.`
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  process.stdout.write(`${summary}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stdout.write(`::error::${error.message}\n`)
    process.exitCode = 1
  })
}
