// Tests for check-public-content.mjs (node --test scripts/check-public-content.test.mjs).
//
// Every sample is synthetic and assembled at run time: this file is scanned too, so it must not contain what it
// tests for.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findHits, run } from './check-public-content.mjs'

const email = (local, domain) => [local, domain].join('@')
const pem = (label) => `${'-'.repeat(5)}BEGIN ${label}${'-'.repeat(5)}`
const hex32 = 'a1b2c3d4'.repeat(4)
const uuid = ['a1b2c3d4', 'e5f6', '4a7b', '8c9d', 'e0f1a2b3c4d5'].join('-')
const homePath = ['', 'home', 'alex', 'notes.txt'].join('/')
const awsKey = (prefix) => prefix + 'ABCDEFGHIJKLMNOP'
const rulesIn = (text) => findHits(text).map((hit) => hit.rule)
// A string literal as code writes it: q('ab') is 'ab'. Samples of literals joined with + are built from it, so that
// this file never joins two literals itself.
const q = (text, quote = "'") => quote + text + quote
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const temporary = []
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'public-content-'))
  temporary.push(dir)
  return dir
}

/** A Git repository with these files staged: { path: text | Buffer | { link: target } }. */
function repository(files) {
  const root = tempDir()
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root })
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    if (content && typeof content === 'object' && 'link' in content) symlinkSync(content.link, full)
    else writeFileSync(full, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** A deny list outside every test repository. */
function denyList(lines) {
  const path = join(tempDir(), 'deny-list.txt')
  writeFileSync(path, lines.join('\n'))
  return path
}

test('email: real addresses in their common forms', () => {
  for (const sample of [
    email('alice', 'corp.co.uk'),
    email('Bob.Smith+tag', 'Corp.COM'),
    email('"alice smith"', 'corp.com'),
    email('\\"alice smith\\"', 'corp.com'),
    email('ünïcode', 'bücher.de'),
    email('user', 'пример.рф'),
    email('user', 'xn--bcher-kva.de'),
    email('user', 'xn--e1afmkfd.xn--p1ai'),
    `https://${email('token', 'git.corp.com')}/team/repo.git`,
  ]) {
    assert.deepEqual(rulesIn(sample), ['email'], sample)
  }
})

test('email: reserved domains and look-alikes pass', () => {
  for (const sample of [
    email('x', 'example.com'),
    email('y', 'mail.example.org'),
    email('z', 'Example.NET'),
    email('w', 'acme.example'),
    email('v', 'corp.test'),
    email('u', 'host.invalid'),
    email('t', 'bücher.example'),
    email('"quoted name"', 'example.net'),
    email('vite', '8.3.0'),
    `npm:${email('lightningcss-wasm', '1.33.0')}`,
    '"@acme/ui": "1.0.0"',
    "import { app } from '@acme/ui/server'",
    'https://registry.npmjs.org/@acme/ui/-/ui-1.0.0.tgz',
    email('user', 'intranet'), // single-label hosts pass: a documented limit
  ]) {
    assert.deepEqual(rulesIn(sample), [], sample)
  }
})

test('aws-key: long-term and temporary key ids', () => {
  assert.deepEqual(rulesIn(`key = ${awsKey('AKIA')}`), ['aws-key'])
  assert.deepEqual(rulesIn(awsKey('ASIA')), ['aws-key'])
  assert.deepEqual(rulesIn(`X${awsKey('AKIA')}`), [])
  assert.deepEqual(rulesIn(awsKey('AKIA').toLowerCase()), [])
})

test('private-key: private keys only, not certificates or public keys', () => {
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
    assert.deepEqual(rulesIn(pem(label)), ['private-key'], label)
  }
  assert.deepEqual(rulesIn(`${'PuTTY-User-Key-File-'}3: ssh-ed25519`), ['private-key'])
  for (const label of ['CERTIFICATE', 'PUBLIC KEY', 'RSA PUBLIC KEY', 'PGP PUBLIC KEY BLOCK', 'CERTIFICATE REQUEST']) {
    assert.deepEqual(rulesIn(pem(label)), [], label)
  }
})

test('cloudflare-id: only the value of its own key, on the same line or a following one', () => {
  for (const sample of [
    `account_id = "${hex32}"`,
    `{ "databaseId": "${uuid}" }`,
    `CLOUDFLARE_ACCOUNT_ID=${hex32}`,
    `zone_id: ${hex32}`,
    `--account-id ${hex32}`,
    `namespace_id = '${uuid.toUpperCase()}'`,
  ]) {
    assert.deepEqual(rulesIn(sample), ['cloudflare-id'], sample)
  }
  const split = findHits(`{\n  "database_id":\n    "${uuid}"\n}`)
  assert.deepEqual(split.map(({ rule, line }) => [rule, line]), [['cloudflare-id', 3]])
  for (const sample of [
    `org_id = "${hex32}"`,
    `account_id = "acme", stakeholder_id = "${uuid}"`,
    `account_id = "${hex32}${hex32}"`,
    `accountIdentifier = "${hex32}"`,
  ]) {
    assert.deepEqual(rulesIn(sample), [], sample)
  }
})

test('local-path and idp-id', () => {
  assert.deepEqual(rulesIn(`see ${homePath}`), ['local-path'])
  assert.deepEqual(rulesIn(`file://${homePath}`), ['local-path'])
  assert.deepEqual(rulesIn(`https://example.com${homePath}`), [])
  assert.deepEqual(rulesIn(`https://accounts.google.com/o/saml2/idp?${'idp'}id=C01abc23`), ['idp-id'])
})

test('hits carry their line numbers', () => {
  const text = ['first', `second ${email('a', 'corp.com')}`, '', `fourth ${homePath}`].join('\n')
  assert.deepEqual(findHits(text).map(({ rule, line }) => [rule, line]), [['email', 2], ['local-path', 4]])
})

test('joined strings: literals joined with + are checked joined, on one line or across lines', () => {
  const split = [q('/ho'), ' + ', q('me/alex/notes.txt')].join('')
  assert.deepEqual(rulesIn(split.replace(' + ', ', ')), [])
  assert.deepEqual(findHits(split).map(({ rule, joined }) => [rule, joined]), [['local-path', true]])
  assert.deepEqual(rulesIn([q('alice@', '"'), ' + ', q('corp.com', '"')].join('')), ['email'])
  assert.deepEqual(rulesIn([q('ali'), ' + ', q('ce@cor', '`'), ' + ', q('p.com', '"')].join('')), ['email'])
  const across = ['first line\nconst home = ', q('/ho', '"'), ' +\n  ', q('me/al'), ' +\n  ', q('ex/notes.txt', '`'), '\n'].join('')
  assert.deepEqual(findHits(across).map(({ rule, line }) => [rule, line]), [['local-path', 2]])
})

test('joined strings: a find inside one literal is reported once; other ways of assembling a value are missed', () => {
  assert.deepEqual(findHits([q(email('alice', 'corp.com')), ' + ', q('!')].join('')).map(({ rule, joined }) => [rule, joined === true]), [['email', false]])
  for (const sample of [
    [q('/ho'), ' + dir + ', q('me/alex')].join(''),
    ['`/ho${', q(''), '}me/alex`'].join(''),
    `[${[q('/ho'), q('me/alex')].join(', ')}].join('')`,
  ]) {
    assert.deepEqual(rulesIn(sample), [], sample)
  }
})

test('joined strings: the output says the text is split, and never repeats it', () => {
  const root = repository({
    'src/paths.ts': `const home = ${[q('/ho'), ' + ', q('me/alex')].join('')}\n`,
    'src/names.ts': `export const owner =\n  ${[q('Freya Lind'), ' +\n  ', q('qvist')].join('')}\n`,
  })
  const { code, out, err } = run(['--deny-list', denyList(['freya lindqvist'])], { root, allowed: [] })
  const output = [...out, ...err].join('\n')
  assert.equal(code, 1)
  assert.deepEqual(err.slice(0, -1).sort(), [
    'src/names.ts:2: deny-list: remove the text that matches line 1 of the deny list (it is split into strings joined with +)',
    'src/paths.ts:1: local-path: use a path relative to the repository (it is split into strings joined with +)',
  ])
  for (const value of ['lindqvist', 'alex']) assert.ok(!output.toLowerCase().includes(value), `the output repeats ${value}`)
})

test('output names file, line, rule and fix, and never what it found', () => {
  const found = [email('alice', 'corp.com'), awsKey('AKIA'), homePath]
  const root = repository({
    'docs/notes.md': `# Notes\n\nContact ${found[0]}\nKey ${found[1]}\nSee ${found[2]}\nFreya Lindqvist approved.\n`,
    'docs/freya-lindqvist/grant.md': 'Nothing to see.\n',
  })
  const deny = denyList(['# private names', '', 'freya lindqvist', 'Freya-Lindqvist'])
  const { code, out, err } = run(['--deny-list', deny], { root, allowed: [] })
  const output = [...out, ...err].join('\n')
  assert.equal(code, 1)
  assert.match(output, /^docs\/notes\.md:3: email: use an address at example\.com/m)
  assert.match(output, /^docs\/notes\.md:4: aws-key: /m)
  assert.match(output, /^docs\/notes\.md:5: local-path: /m)
  assert.match(output, /^docs\/notes\.md:6: deny-list: remove the text that matches line 3 of the deny list$/m)
  assert.match(output, /^docs\/…\/grant\.md \(its path\): deny-list: remove the text that matches line 4 of the deny list$/m)
  for (const value of [...found, 'freya', 'lindqvist', deny]) {
    assert.ok(!output.toLowerCase().includes(value.toLowerCase()), `the output repeats ${value}`)
  }
})

test('deny list: comments and blank lines are ignored; case and compatibility forms match', () => {
  const root = repository({ 'a.txt': 'ＦＲＥＹＡ ＬＩＮＤＱＶＩＳＴ\n' })
  assert.equal(run(['--deny-list', denyList(['# a comment', '', 'freya lindqvist'])], { root, allowed: [] }).code, 1)
  assert.equal(run(['--deny-list', denyList(['# freya lindqvist'])], { root, allowed: [] }).code, 0)
})

test('deny list: refused inside the repository, and its path is never printed', () => {
  const root = repository({ 'a.txt': 'hello\n' })
  const inside = join(root, 'private-names.txt')
  writeFileSync(inside, 'someone\n')
  const missing = join(tempDir(), 'missing-names.txt')
  for (const args of [['--deny-list', inside], [`--deny-list=${missing}`]]) {
    const { code, out, err } = run(args, { root, allowed: [] })
    const output = [...out, ...err].join('\n')
    assert.equal(code, 2)
    assert.ok(!output.includes('private-names') && !output.includes('missing-names'), output)
  }
})

test('ALLOWED: a file is exempt only while its SHA-256 matches', () => {
  const bridge = 'export const origins = ["https://console.acme-platform.example"]\n'
  const root = repository({ 'src/bridge.tsx': bridge })
  const deny = denyList(['acme-platform'])
  const allowed = [{ file: 'src/bridge.tsx', sha256: sha256(bridge), why: 'a verbatim platform file' }]
  assert.equal(run(['--deny-list', deny], { root, allowed }).code, 0)
  writeFileSync(join(root, 'src/bridge.tsx'), `${bridge}// edited\n`)
  const { code, err } = run(['--deny-list', deny], { root, allowed })
  assert.equal(code, 1)
  assert.match(err.join('\n'), /^src\/bridge\.tsx:1: deny-list: /m)
  assert.match(err.join('\n'), /^src\/bridge\.tsx: allow-list: it has changed since its SHA-256 was pinned/m)
})

test('ALLOWED: a pinned line is exempt once, and only that line', () => {
  const pinned = 'Copyright (c) 2026 Acme Platform Inc'
  const deny = denyList(['acme platform'])
  const allowed = [{ file: 'LICENSE', lineSha256: sha256(pinned), why: 'the copyright holder' }]
  assert.equal(run(['--deny-list', deny], { root: repository({ LICENSE: `MIT License\n\n${pinned}\n` }), allowed }).code, 0)

  const another = run(['--deny-list', deny], { root: repository({ LICENSE: `MIT License\n\n${pinned}\nAcme Platform again\n` }), allowed })
  assert.equal(another.code, 1)
  assert.deepEqual(another.err.slice(0, -1), ['LICENSE:4: deny-list: remove the text that matches line 1 of the deny list'])

  const twice = run(['--deny-list', deny], { root: repository({ LICENSE: `${pinned}\n${pinned}\n` }), allowed })
  assert.equal(twice.code, 1)
  assert.equal(twice.err.filter((line) => /^LICENSE:\d+: deny-list: /.test(line)).length, 2)
  assert.match(twice.err.join('\n'), /^LICENSE: allow-list: it has its pinned line 2 times instead of once/m)
})

test('ALLOWED: an entry whose file is not tracked is stale', () => {
  const root = repository({ 'a.txt': 'hello\n' })
  const { code, err } = run([], { root, allowed: [{ file: 'gone.txt', sha256: sha256(''), why: 'gone' }] })
  assert.equal(code, 1)
  assert.match(err.join('\n'), /^gone\.txt: allow-list: it is not a tracked file/m)
})

test('binary files are skipped; a symlink is checked by its target path', () => {
  const root = repository({
    'bin/blob.dat': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(email('alice', 'corp.com'))]),
    'docs/link': { link: homePath },
  })
  const { code, err } = run([], { root, allowed: [] })
  assert.equal(code, 1)
  assert.deepEqual(err.slice(0, -1), ['docs/link:1: local-path: use a path relative to the repository'])
  assert.match(err.at(-1), /1 binary or unreadable skipped/)
})

test('the command line: --help, bad arguments (never echoed), and running it directly', () => {
  assert.equal(run(['--help']).code, 0)
  for (const args of [['--deny-list'], ['--denylist=private-names.txt'], ['--deny-list', 'a.txt', 'private-names.txt']]) {
    const { code, err } = run(args)
    assert.equal(code, 2, args.join(' '))
    assert.ok(!err.join('\n').includes('private-names'), err.join('\n'))
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-public-content.mjs')
  const direct = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(direct.status, 0)
  assert.match(direct.stdout, /^usage: /)
})
