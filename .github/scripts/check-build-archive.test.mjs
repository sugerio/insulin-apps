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

test("an app with an engine carries the engine's bundle too, and nothing else of the app", () => {
  const roots = ['knowledge/.output', 'knowledge/engine/.output']
  assert.doesNotThrow(() => checkBuildArchiveMembers([
    'knowledge/.output/',
    'knowledge/.output/server/index.mjs',
    'knowledge/engine/.output/',
    'knowledge/engine/.output/worker/index.js',
  ].join('\n'), roots))
  for (const member of ['knowledge/engine/', 'knowledge/engine/src/index.ts', 'knowledge/engine/wrangler.jsonc', 'knowledge/engine', 'knowledge/package.json', 'knowledge/engine/.output/../x']) {
    assert.throws(() => checkBuildArchiveMembers(`${member}\n`, roots), /outside|unsafe path/, member)
  }
  assert.throws(() => checkBuildArchiveMembers('knowledge/.output/x\n', []), /Expected archive roots/)
})
