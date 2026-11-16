// Deleting a collection, and every collection of an organization: nothing is left in R2 or the Durable Object's
// storage, the import stops, and doing it again changes nothing.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORG, OTHER_ORG, createCollection, doc, learn, makeEngine, outboxEvents, startImport } from './helpers.ts'

test('DEL-01 deleting during an import: the import stops; inbox, text, exports and every backup are gone; storage is empty', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(11 * 60_000)
  await t.drain('c1') // a backup (latest and daily)
  await t.api('POST', '/v1/collections/c1/exports', { exportId: 'e1' })
  await t.drain('c1')
  t.advance(6 * 60_000)
  t.cloud.jobPolls = 6
  await startImport(t, 'c1', 'imp-2', [doc(2), doc(3)])
  await t.drain('c1', { steps: 3 })
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'learning')
  assert.ok(t.backups.keys(`backups/${ORG}/c1/`).some((k) => k.endsWith('latest.json')))
  assert.ok(t.files.keys(`inbox/${ORG}/c1/`).length)
  assert.ok(t.files.keys(`exports/${ORG}/c1/`).length)

  const deleting = await t.api('DELETE', '/v1/collections/c1')
  assert.equal(deleting.status, 202)
  assert.deepEqual(deleting.body, { state: 'deleting' })
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'deleting')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'cancelled')
  const refused = await t.api('POST', '/v1/collections/c1/search', { query: 'x' })
  assert.deepEqual([refused.status, refused.body.error], [409, 'deleting'])
  assert.equal((await t.api('PUT', '/v1/collections/c1', {})).status, 409)

  await t.drain('c1')
  assert.equal(t.container('c1').running, false)
  for (const prefix of [`inbox/${ORG}/c1/`, `text/${ORG}/c1/`, `exports/${ORG}/c1/`]) assert.deepEqual(t.files.keys(prefix), [], prefix)
  assert.deepEqual(t.backups.keys(`backups/${ORG}/c1/`), [], 'the latest backup is gone too')
  assert.equal(t.storage('c1').data.size, 0, 'Durable Object storage is empty')
  assert.equal(t.storage('c1').alarm, null)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'deleted')
  const events = await outboxEvents(t)
  assert.ok(events.some((e) => e.type === 'deleted' && e.collectionId === 'c1'))
  assert.ok(!Object.keys(await (t.capacity.instance('capacity').object as any).running()).length, 'its capacity slot is free')

  // Reconciling again changes nothing.
  const again = await t.api('DELETE', '/v1/collections/c1')
  assert.equal(again.status, 202)
  await t.drain()
  assert.equal(t.storage('c1').data.size, 0)
  assert.equal((await t.api('PUT', '/v1/collections/c1', {})).status, 409, 'a deleted id is not made again')
  assert.equal((await t.api('GET', '/v1/health', undefined, { org: null })).body.collections, 0)
})

test('DEL-05 purging an organization deletes every one of its collections and nothing of another organization', async () => {
  const t = makeEngine()
  for (const c of ['a', 'b']) {
    await createCollection(t, c)
    await learn(t, c, `imp-${c}`, [doc(1)])
  }
  await createCollection(t, 'z', OTHER_ORG)
  await learn(t, 'z', 'imp-z', [doc(1)], OTHER_ORG)
  assert.equal((await t.api('GET', '/v1/health', undefined, { org: null })).body.collections, 3)

  const purge = await t.api('POST', `/v1/orgs/${ORG}/purge`, {})
  assert.equal(purge.status, 202)
  assert.equal(purge.body.collections, 2)
  await t.drain()
  for (const c of ['a', 'b']) {
    assert.equal((await t.api('GET', `/v1/collections/${c}`)).body.state, 'deleted')
    assert.equal(t.storage(c).data.size, 0)
  }
  assert.deepEqual([...t.files.keys(), ...t.backups.keys()].filter((k) => k.includes(`/${ORG}/`)), [], 'no R2 object left for the organization')
  assert.equal((await t.api('GET', '/v1/collections/z', undefined, { org: OTHER_ORG })).body.version, 1)
  assert.equal((await t.api('GET', '/v1/health', undefined, { org: null })).body.collections, 1)
  // Again: nothing more to do.
  assert.equal((await t.api('POST', `/v1/orgs/${ORG}/purge`, {})).body.collections, 0)
})
