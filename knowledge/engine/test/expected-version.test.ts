// API 2: `expectedVersion` on imports and corrections (contract.ts, ExpectedVersion). Checked when the import applies,
// in the collection's serialized write path: when its try starts, and again in the commit's transaction. At any other
// version it fails with `version_changed`, learning nothing; without one nothing is checked.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCollection, doc, learn, log, makeEngine, outboxEvents, startImport, type TestEngine } from './helpers.ts'

const status = async (t: TestEngine, importId: string) => (await t.api('GET', `/v1/collections/c1/imports/${importId}`)).body
const collection = async (t: TestEngine) => (await t.api('GET', '/v1/collections/c1')).body

test('an import based on the collection\'s version commits; one without expectedVersion is never checked', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'base', [doc(1)])
  t.advance(6 * 60_000)
  const based = await startImport(t, 'c1', 'based', [doc(2)], undefined, { expectedVersion: 1 })
  assert.equal(based.status, 202)
  await t.drain('c1')
  assert.equal((await status(t, 'based')).state, 'committed')
  assert.equal((await status(t, 'based')).version, 2)
  t.advance(6 * 60_000)
  const unchecked = await learn(t, 'c1', 'unchecked', [doc(3)])
  assert.equal(unchecked.state, 'committed')
  assert.equal((await collection(t)).counts.documents, 3)
})

test('an import queued behind one that commits first fails with version_changed when its turn comes, and learns nothing', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'base', [doc(1)])
  t.advance(6 * 60_000)
  // Both are normal imports, so the second waits behind the first; both were written against version 1.
  assert.equal((await startImport(t, 'c1', 'first', [doc(2)])).status, 202)
  assert.equal((await startImport(t, 'c1', 'second', [doc(3)], undefined, { expectedVersion: 1 })).status, 202)
  await t.drain('c1')
  assert.equal((await status(t, 'first')).state, 'committed')
  const second = await status(t, 'second')
  assert.equal(second.state, 'failed')
  assert.equal(second.error.error, 'version_changed')
  assert.match(second.error.message, /it is at version 2 now, not 1, so nothing was learned/)
  assert.equal(second.version, null)
  const now = await collection(t)
  assert.equal(now.version, 2)
  assert.equal(now.counts.documents, 2)
  assert.equal(now.currentImport, null)
  const names = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.map((d: { name: string }) => d.name)
  assert.deepEqual(names.sort(), ['doc-1.md', 'doc-2.md'])
  const events = await outboxEvents(t)
  assert.ok(events.some((e) => e.type === 'import' && e.import.importId === 'second' && e.import.state === 'failed' && e.import.error?.error === 'version_changed'))
  assert.ok(!events.some((e) => e.type === 'committed' && e.importId === 'second'))
  // Found when its try started: no container job was started for it.
  const entries = await log(t, 'c1')
  assert.ok(entries.some((e: any) => e.event === 'import-version-changed' && e.importId === 'second' && e.expected === 1 && e.current === 2))
  assert.ok(!entries.some((e: any) => e.event === 'job-started' && e.importId === 'second'))
  // The collection goes on: a later import based on version 2 is learned.
  t.advance(6 * 60_000)
  assert.equal((await startImport(t, 'c1', 'third', [doc(4)], undefined, { expectedVersion: 2 })).status, 202)
  await t.drain('c1')
  assert.equal((await status(t, 'third')).state, 'committed')
})

test('a change committed while an import learns (stop using needs no container) fails it at the commit, keeping nothing', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'base', [doc(1)])
  t.advance(6 * 60_000)
  const [first] = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  t.cloud.jobPolls = 5
  assert.equal((await startImport(t, 'c1', 'late', [doc(2)], undefined, { expectedVersion: 1 })).status, 202)
  for (let i = 0; i < 40 && !['reading', 'learning'].includes((await status(t, 'late')).state); i++) await t.drain('c1', { steps: 1 })
  assert.ok(['reading', 'learning'].includes((await status(t, 'late')).state), 'the import is past its start check')
  const stopped = await t.api('PATCH', `/v1/collections/c1/documents/${first.documentId}`, { active: false })
  assert.equal(stopped.body.state, 'committed')
  assert.equal(stopped.body.version, 2)
  await t.drain('c1')
  const late = await status(t, 'late')
  assert.equal(late.state, 'failed')
  assert.equal(late.error.error, 'version_changed')
  assert.match(late.error.message, /it is at version 2 now, not 1/)
  const now = await collection(t)
  assert.equal(now.version, 2)
  assert.equal(now.counts.documents, 1)
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.length, 2)
})

test('a correction based on an earlier version fails with version_changed; one based on the current version commits', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'base', [doc(1)])
  t.advance(6 * 60_000)
  const note = (noteId: string) => ({ noteId, title: 'Fix', text: 'The gateway port is 9001.', outdated: [] })
  const stale = await t.api('POST', '/v1/collections/c1/corrections', { importId: 'stale-fix', note: note('n-stale'), expectedVersion: 0 })
  assert.equal(stale.status, 202, 'not checked when submitted')
  await t.drain('c1')
  assert.equal((await status(t, 'stale-fix')).state, 'failed')
  assert.equal((await status(t, 'stale-fix')).error.error, 'version_changed')
  const fresh = await t.api('POST', '/v1/collections/c1/corrections', { importId: 'fresh-fix', note: note('n-fresh'), expectedVersion: 1 })
  assert.equal(fresh.status, 202)
  await t.drain('c1')
  assert.equal((await status(t, 'fresh-fix')).state, 'committed')
  assert.equal((await collection(t)).version, 2)
})

test('expectedVersion must be a whole number; an id the engine already has answers its import first, whatever the body says', async () => {
  const t = makeEngine()
  await createCollection(t)
  for (const bad of [-1, 1.5, '1']) {
    const refused = await startImport(t, 'c1', `bad-${String(bad)}`.replace('.', '-'), [doc(1)], undefined, { expectedVersion: bad })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error, 'bad_request')
  }
  const accepted = await startImport(t, 'c1', 'once', [doc(2)], undefined, { expectedVersion: 0 })
  assert.equal(accepted.status, 202)
  await t.drain('c1')
  assert.equal((await status(t, 'once')).state, 'committed')
  // Sent again after the collection moved on, even with a body the engine would refuse: the import it has.
  const again = await t.api('POST', '/v1/collections/c1/imports', { importId: 'once', files: [], notes: [], small: false, expectedVersion: 'stale' })
  assert.equal(again.status, 200)
  assert.equal(again.body.state, 'committed')
  assert.equal(again.body.version, 1)
})
