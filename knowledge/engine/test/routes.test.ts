// The route table against the contract (BUILD.md, "The engine contract"), the organization header, and isolation:
// another organization's collection answers exactly like an unknown one.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ORG_HEADER } from '../src/contract.ts'
import { ROUTES, TEST_ROUTES, matchRoute } from '../src/routes.ts'
import { OTHER_ORG, createCollection, doc, learn, makeEngine } from './helpers.ts'

// Copied from BUILD.md's table: every route the app may call.
const CONTRACT = [
  'PUT /v1/collections/:cid',
  'GET /v1/collections/:cid',
  'POST /v1/collections/:cid/wake',
  'PUT /v1/collections/:cid/inbox/:fileId',
  'POST /v1/collections/:cid/inbox/keep',
  'POST /v1/collections/:cid/imports',
  'GET /v1/collections/:cid/imports/:importId',
  'POST /v1/collections/:cid/search',
  'POST /v1/answer',
  'GET /v1/collections/:cid/documents',
  'GET /v1/collections/:cid/documents/:docId',
  'PATCH /v1/collections/:cid/documents/:docId',
  'DELETE /v1/collections/:cid/documents/:docId',
  'GET /v1/collections/:cid/facts',
  'POST /v1/collections/:cid/corrections',
  'GET /v1/collections/:cid/restore-points',
  'GET /v1/collections/:cid/restore-points/:version/preview',
  'POST /v1/collections/:cid/restore-points/:version/go-back',
  'POST /v1/collections/:cid/undo',
  'POST /v1/collections/:cid/exports',
  'POST /v1/collections/:cid/import-export',
  'DELETE /v1/collections/:cid/imports/:importId',
  'GET /v1/collections/:cid/exports/:exportId',
  'DELETE /v1/collections/:cid',
  'POST /v1/orgs/:org/purge',
  'POST /v1/orgs/:org/hold',
  'GET /v1/outbox',
  'GET /v1/health',
]

const concrete = (path: string) =>
  path.replace(':cid', 'c1').replace(':fileId', 'f1').replace(':importId', 'i1').replace(':docId', 'd1').replace(':version', '1').replace(':exportId', 'e1').replace(':org', 'org-acme')

test('the route table is exactly the contract', () => {
  assert.deepEqual(ROUTES.map((r) => `${r.method} ${r.path}`).sort(), [...CONTRACT].sort())
  for (const line of CONTRACT) {
    const [method, path] = line.split(' ')
    const match = matchRoute(method, concrete(path))
    assert.ok(match && match !== 'method_not_allowed', line)
  }
  // The contract file's own header names the organization header the routes use.
  assert.match(readFileSync(new URL('../src/contract.ts', import.meta.url), 'utf8'), /x-knowledge-org/)
  assert.equal(ORG_HEADER, 'x-knowledge-org')
})

test('every collection route needs x-knowledge-org (400); unknown routes answer 404; test routes exist only when enabled', async () => {
  const t = makeEngine()
  for (const line of CONTRACT.filter((l) => !l.endsWith('/v1/outbox') && !l.endsWith('/v1/health'))) {
    const [method, path] = line.split(' ')
    const res = await t.api(method, concrete(path), method === 'GET' ? undefined : {}, { org: null })
    assert.equal(res.status, 400, line)
    assert.equal(res.body.error, 'bad_request', line)
  }
  assert.equal((await t.api('GET', '/v1/outbox', undefined, { org: null })).status, 200)
  const health = await t.api('GET', '/v1/health', undefined, { org: null })
  assert.equal(health.status, 200)
  assert.equal(typeof health.body.engine, 'string')
  assert.doesNotMatch(health.body.engine, /[0-9a-f]{32}|sha256:/)
  assert.equal((await t.api('GET', '/v1/nothing')).status, 404)
  assert.equal((await t.api('GET', '/v1/collections/c1/unknown')).status, 404)

  const production = makeEngine({ testControls: false })
  await createCollection(production)
  assert.equal((await production.api('POST', '/v1/collections/c1/__test/destroy-container')).status, 404)
  assert.ok(TEST_ROUTES.every((r) => r.path.includes('__test')))
  assert.equal((await production.api('GET', '/v1/__test/objects')).status, 404)
  const counts = await t.api('GET', '/v1/__test/objects')
  assert.deepEqual(counts.body, { inbox: 0, text: 0, exports: 0, backups: 0 })
})

test("org isolation: another organization's collection id answers 404 on every route, like an unknown one (ACC-13)", async () => {
  const t = makeEngine()
  await createCollection(t, 'c1')
  await learn(t, 'c1', 'imp-1', [doc(1)])
  const [document] = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  for (const line of CONTRACT.filter((l) => l.includes(':cid'))) {
    const [method, pattern] = line.split(' ')
    const path = concrete(pattern).replace('/d1', `/${document.documentId}`)
    if (method === 'PUT' && pattern === '/v1/collections/:cid') continue // creating is the one write; see below
    const foreign = await t.api(method, path, method === 'GET' || method === 'DELETE' ? undefined : { importId: 'x', query: 'q', exportId: 'e', active: false }, { org: OTHER_ORG })
    const unknown = await t.api(method, path.replace('/c1', '/c-unknown'), method === 'GET' || method === 'DELETE' ? undefined : { importId: 'x', query: 'q', exportId: 'e', active: false })
    assert.equal(foreign.status, 404, `${line} from another organization`)
    assert.equal(foreign.body.error, 'not_found', line)
    assert.equal(unknown.status, 404, `${line} unknown id`)
  }
  // The other organization's PUT makes its own collection with that id; the first one is untouched.
  const theirs = await createCollection(t, 'c1', OTHER_ORG)
  assert.equal(theirs.version, 0)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 1)
  assert.equal((await t.api('GET', '/v1/collections/c1/documents', undefined, { org: OTHER_ORG })).body.documents.length, 0)
  // A purge names its organization in the header too.
  assert.equal((await t.api('POST', '/v1/orgs/org-acme/purge', {}, { org: OTHER_ORG })).status, 404)
})

test('bad input answers 400 with a plain message', async () => {
  const t = makeEngine()
  await createCollection(t)
  const cases: [string, string, unknown][] = [
    ['PUT', '/v1/collections/c1', { settings: { awakeMinutes: 0 } }],
    ['PUT', '/v1/collections/c1', { settings: { keepReady: { timeZone: 'Mars/Olympus', days: [1], start: '09:00', hours: 2, paused: false } } }],
    ['PUT', '/v1/collections/c1', { settings: { keepReady: { timeZone: 'Europe/Berlin', days: [1], start: '09:00', hours: 4, paused: false } } }],
    ['POST', '/v1/collections/c1/search', { query: '' }],
    ['POST', '/v1/collections/c1/search', { query: 'x', topK: 50 }],
    ['POST', '/v1/collections/c1/imports', { importId: 'bad id!', files: [] }],
    ['POST', '/v1/collections/c1/imports', { importId: 'ok', files: [], notes: [] }],
    ['GET', '/v1/collections/c1/restore-points/zero/preview', undefined],
  ]
  for (const [method, path, body] of cases) {
    const res = await t.api(method, path, body)
    assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`)
    assert.equal(typeof res.body.message, 'string')
  }
})
