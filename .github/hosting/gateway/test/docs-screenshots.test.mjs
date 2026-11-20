// The docs' screenshot scripts (.github/hosting/docs/screenshots.mjs and knowledge-screenshots.mjs) need a local stack
// and Chrome, so nothing runs them here. TypeScript's checker reads them instead: a name used where it isn't declared
// (a `const` inside one block is out of reach of the next) would stop a run with a ReferenceError.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { PLATFORM_DOCS } from '../scripts/build-docs.mjs'

const SCRIPTS = ['screenshots.mjs', 'knowledge-screenshots.mjs'].map((name) => ts.sys.resolvePath(`${PLATFORM_DOCS}/${name}`))
// "Cannot find name 'x'", with or without "Did you mean 'y'?". Node's own globals (process, Buffer) have other codes.
const UNDECLARED = new Set([2304, 2552])

test('the docs\' screenshot scripts use only names declared where they use them', () => {
  const program = ts.createProgram(SCRIPTS, {
    allowJs: true, checkJs: true, noEmit: true, noResolve: true, types: [],
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
  })
  const undeclared = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && SCRIPTS.includes(diagnostic.file.fileName) && UNDECLARED.has(diagnostic.code))
    .map((diagnostic) => `${diagnostic.file.fileName.slice(PLATFORM_DOCS.length + 1)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
  assert.equal(program.getSourceFiles().filter((file) => SCRIPTS.includes(file.fileName)).length, SCRIPTS.length, 'both scripts are read')
  assert.deepEqual(undeclared, [])
})
