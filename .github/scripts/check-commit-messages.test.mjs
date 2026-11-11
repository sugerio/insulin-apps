import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commitsBetween, findSkipDirectives } from './check-commit-messages.mjs'

const temporary = []
after(async () => Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))))

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Commit Test',
  GIT_AUTHOR_EMAIL: 'commits@example.test',
  GIT_COMMITTER_NAME: 'Commit Test',
  GIT_COMMITTER_EMAIL: 'commits@example.test',
}
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('finds every skip directive GitHub honors, in commits, the title and the body, whatever the case', () => {
  const commits = [
    { sha: 'a'.repeat(40), message: 'Fix the gate\n\nA push with [skip ci] starts no run.' },
    { sha: 'b'.repeat(40), message: 'Tidy\n\n[CI SKIP]' },
    { sha: 'c'.repeat(40), message: 'Docs\n\nskip-checks: true' },
    { sha: 'd'.repeat(40), message: 'Plain change\n\nNothing to skip here; skip-checks is a trailer name.' },
  ]
  assert.deepEqual(findSkipDirectives({ commits, title: 'Release [no ci]', body: 'Also [skip actions] and [actions skip].' }), [
    { where: 'aaaaaaa', line: 'A push with [skip ci] starts no run.' },
    { where: 'bbbbbbb', line: '[CI SKIP]' },
    { where: 'ccccccc', line: 'skip-checks: true' },
    { where: 'title', line: 'Release [no ci]' },
    { where: 'body', line: 'Also [skip actions] and [actions skip].' },
  ])
  assert.deepEqual(findSkipDirectives({ commits: [commits[3]], title: 'Ship it', body: 'A push whose message tells GitHub to skip its workflows.' }), [])
})

test("reads the commits between a pull request's base and head, with their whole messages", async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-messages-'))
  temporary.push(root)
  git(root, 'init', '--quiet', '--initial-branch=main')
  await writeFile(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'Base')
  const base = git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'b.txt'), 'b\n')
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'First\n\nBody line one.\nBody line two.')
  await writeFile(join(root, 'c.txt'), 'c\n')
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', 'Second\n\nA mention of [skip ci] in passing.')
  const commits = commitsBetween(base, 'HEAD', root)
  assert.deepEqual(commits.map(({ message }) => message.trim()), ['Second\n\nA mention of [skip ci] in passing.', 'First\n\nBody line one.\nBody line two.'])
  assert.deepEqual(findSkipDirectives({ commits }).map(({ line }) => line), ['A mention of [skip ci] in passing.'])
  assert.throws(() => commitsBetween('no-such-ref', 'HEAD', root), /Couldn't list the commits no-such-ref\.\.HEAD/)
})
