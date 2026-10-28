import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkBuildArchiveMembers } from './check-build-archive.mjs'

test('accepts only members rooted in the selected app output', () => {
  assert.doesNotThrow(() => checkBuildArchiveMembers([
    'captable/.output/',
    'captable/.output/server/',
    'captable/.output/server/index.mjs',
    'captable/.output/public/app.js',
  ].join('\n'), 'captable/.output'))

  assert.throws(
    () => checkBuildArchiveMembers('captable/.output/\ncaptable/package.json\n', 'captable/.output'),
    /outside/,
  )
  assert.throws(
    () => checkBuildArchiveMembers('captable/.output/../package.json\n', 'captable/.output'),
    /unsafe path/,
  )
  assert.throws(
    () => checkBuildArchiveMembers('/captable/.output/server/index.mjs\n', 'captable/.output'),
    /outside/,
  )
  assert.throws(() => checkBuildArchiveMembers('', 'captable/.output'), /empty/)
})
