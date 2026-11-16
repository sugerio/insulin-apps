// The organization hold (the app's hard stop on awake hours, enforced here) and settings revisions.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORG, OTHER_ORG, ask, createCollection, doc, learn, makeEngine, outboxEvents, startImport } from './helpers.ts'

const DAY = 24 * 60 * 60_000

test('a held organization starts no container: questions answer "held", running ones stop, and the hold lifts', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  await createCollection(t, 'other', OTHER_ORG)
  await learn(t, 'other', 'imp-o', [doc(9)], OTHER_ORG)
  assert.equal(t.container('c1').running, true)
  const until = new Date(t.now() + DAY).toISOString()
  const held = await t.api('POST', `/v1/orgs/${ORG}/hold`, { until })
  assert.deepEqual([held.status, held.body], [200, { held: true, until }])
  assert.equal((await t.api('POST', `/v1/orgs/${ORG}/hold`, { until }, { org: OTHER_ORG })).status, 404, 'the header names the organization')
  await t.drain('c1')
  assert.equal(t.container('c1').running, false, 'the running container stopped')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'held')
  const startsBefore = t.cloud.starts.length
  const answer = await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 1' })
  assert.equal(answer.body.status, 'held')
  await t.drain('c1')
  assert.equal(t.cloud.starts.length, startsBefore, 'no container started for a question')
  // Another organization is not held.
  assert.equal((await ask(t, 'other', 'topic number 9', OTHER_ORG)).body.status, 'ok')

  // An import waits; a removal for good still runs.
  t.advance(6 * 60_000)
  await startImport(t, 'c1', 'imp-2', [doc(2)])
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'queued')
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, removed.body.version)
  assert.equal(t.container('c1').running, false, 'and stops again afterwards')

  // Lifted with until: null, the import runs and questions are answered.
  assert.deepEqual((await t.api('POST', `/v1/orgs/${ORG}/hold`, { until: null })).body, { held: false, until: null })
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'committed')
  assert.equal((await ask(t, 'c1', 'topic number 2 gateway port')).body.status, 'ok')
})

test('a hold stops an import mid-way without keeping anything, and lifts by itself at its time', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(6 * 60_000)
  t.cloud.jobPolls = 5
  await startImport(t, 'c1', 'imp-2', [doc(2), doc(3)])
  await t.drain('c1', { steps: 2 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'learning')
  await t.api('POST', `/v1/orgs/${ORG}/hold`, { until: new Date(t.now() + 60 * 60_000).toISOString() })
  await t.drain('c1', { steps: 3 })
  const stopped = (await t.api('GET', '/v1/collections/c1/imports/imp-2')).body
  assert.deepEqual([stopped.state, stopped.attempt], ['queued', 1])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 1, 'nothing kept')
  assert.equal(t.container('c1').running, false)
  // A collection made while the organization is held is held too.
  await createCollection(t, 'c2')
  assert.equal((await t.api('GET', '/v1/collections/c2')).body.state, 'held')
  t.cloud.jobPolls = 1
  t.advance(61 * 60_000)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'committed')
  assert.equal((await t.api('GET', '/v1/collections/c2')).body.state, 'empty')
})

test('settings carry a revision: an older one is refused with 409 stale_settings, the same one changes nothing', async () => {
  const t = makeEngine()
  const base = { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] }, keepReady: null, awakeMinutes: 10, backupDays: 30 }
  assert.equal((await t.api('PUT', '/v1/collections/c1', { settings: { ...base, revision: 3 } })).body.settings.revision, 3)
  const newer = await t.api('PUT', '/v1/collections/c1', { settings: { ...base, awakeMinutes: 20, revision: 5 } })
  assert.equal(newer.body.settings.awakeMinutes, 20)
  const stale = await t.api('PUT', '/v1/collections/c1', { settings: { ...base, awakeMinutes: 5, revision: 4 } })
  assert.deepEqual([stale.status, stale.body.error], [409, 'stale_settings'])
  const same = await t.api('PUT', '/v1/collections/c1', { settings: { ...base, awakeMinutes: 20, revision: 5 } })
  assert.equal(same.status, 200)
  const now = (await t.api('GET', '/v1/collections/c1')).body.settings
  assert.deepEqual([now.awakeMinutes, now.revision], [20, 5])
  assert.ok(!(await outboxEvents(t)).some((e) => e.type === 'import'), 'nothing was queued')
})
