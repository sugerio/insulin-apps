#!/usr/bin/env node
// Refuses a pull request whose commit messages, title or body tell GitHub to skip workflows. Pull requests are squash
// merged, and the squash commit carries every commit message, so one such line anywhere starts no push workflow for the
// merge: nothing is checked on main, released or deployed (release.yml numbers only pushes whose runs passed).
//
// usage: node .github/scripts/check-commit-messages.mjs <base sha> <head sha>
// It reads the pull request's title and body from GITHUB_EVENT_PATH, when set. check-commit-messages.test.mjs tests it.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// GitHub's directives (docs: "Skipping workflow runs"), matched case-insensitively.
export const SKIP_DIRECTIVE = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^\s*skip-checks\s*:\s*true\s*$/im

/** Each place a directive appears: `{ where, line }`, `where` being a commit's short sha, "title" or "body". */
export function findSkipDirectives({ commits = [], title = '', body = '' }) {
  const found = []
  const scan = (where, text) => {
    for (const line of String(text ?? '').split('\n')) if (SKIP_DIRECTIVE.test(line)) found.push({ where, line: line.trim() })
  }
  for (const { sha, message } of commits) scan(sha.slice(0, 7), message)
  scan('title', title)
  scan('body', body)
  return found
}

/** The commits between base and head, each `{ sha, message }`. */
export function commitsBetween(base, head, cwd = process.cwd()) {
  const log = spawnSync('git', ['log', '--format=%H%x00%B%x01', `${base}..${head}`], { cwd, encoding: 'utf8' })
  if (log.status !== 0) throw new Error(`Couldn't list the commits ${base}..${head}: ${log.stderr.trim()}`)
  return log.stdout.split('\x01').map((entry) => entry.replace(/^\n/, '')).filter(Boolean).map((entry) => {
    const [sha, message] = entry.split('\x00')
    return { sha, message }
  })
}

function main() {
  const [base, head] = process.argv.slice(2)
  if (!base || !head) throw new Error('usage: node .github/scripts/check-commit-messages.mjs <base sha> <head sha>')
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const found = findSkipDirectives({ commits: commitsBetween(base, head), title: event.pull_request?.title, body: event.pull_request?.body })
  if (!found.length) {
    process.stdout.write('No commit message, title or body asks GitHub to skip workflows.\n')
    return
  }
  for (const { where, line } of found) {
    process.stdout.write(`::error::${where}: "${line}" would make GitHub start no push workflow for the merge, so it would be neither checked on main nor released. Reword it.\n`)
  }
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    process.stdout.write(`::error::${error.message}\n`)
    process.exitCode = 1
  }
}
