import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CollectionStore } from '../src/store.ts'
import type { PendingEvent } from '../src/types.ts'
import { FakeStorage } from './fakes.ts'
import { ORG, ask, createCollection, doc, guard, learn, log, makeEngine, outboxEvents, startImport, wrapGuard, type TestEngine } from './helpers.ts'

// Round 10 of the review: a hold that lands while the old container stops for its replacement (F185), a release owed
// for an import that waits held in the queue (F186), and events added in the same millisecond (F187).

const DAY_MS = 24 * 60 * 60_000
let wishes = 100
const holdFor = (t: TestEngine, days = 14) =>
  t.api('POST', `/v1/orgs/${ORG}/hold`, { until: new Date(t.now() + days * DAY_MS).toISOString(), version: ++wishes })
const liftHold = (t: TestEngine) => t.api('POST', `/v1/orgs/${ORG}/hold`, { until: null, version: ++wishes })

const importStates = async (t: TestEngine, importId: string) =>
  (await outboxEvents(t)).filter((e: any) => e.type === 'import' && e.import.importId === importId).map((e: any) => [e.import.state, e.import.attempt])

/** Runs `during` (once) while the collection's running container is being destroyed, before it has stopped. */
function duringFirstDestroy(t: TestEngine, during: () => Promise<void>) {
  const box = t.container('c1') as any
  const destroy = box.destroy.bind(box)
  const seen = { landed: false }
  box.destroy = async (...args: unknown[]) => {
    if (!seen.landed) {
      seen.landed = true
      await during()
    }
    return destroy(...args)
  }
  return seen
}

/** A collection with one version, awake for questions on standard-1 (the learning instance stays standard-4). */
async function awakeOnStandard1() {
  const t = makeEngine()
  ;(t.env as any).ENGINE_QUESTIONS_INSTANCE = 'standard-1'
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(15 * 60_000)
  await t.drain('c1')
  assert.equal(t.container('c1').running, false, 'asleep')
  assert.equal((await ask(t, 'c1', 'topic number 1')).body.status, 'ok')
  assert.equal(t.cloud.starts.at(-1)?.instance, 'standard-1', 'woken for questions on standard-1')
  t.advance(6 * 60_000)
  return t
}

test('F185 a hold acknowledged while the question container stops for the learning one: no learning container starts', async () => {
  const t = await awakeOnStandard1()
  const starts = t.cloud.starts.length
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  const hold = duringFirstDestroy(t, async () => {
    assert.equal((await holdFor(t)).body.held, true, 'the hold is acknowledged')
  })
  await t.drain('c1', { steps: 1 })
  assert.ok(hold.landed, 'the hold landed as the question container stopped')
  assert.equal(t.cloud.starts.length, starts, 'no container started after the hold was acknowledged')
  assert.equal(t.container('c1').running, false)
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued', 'it waits for the hold to end')
  assert.deepEqual((await guard(t)).running, [], 'its slot went back')
  assert.equal((await t.storage('c1').get<any>('ledger')).kind, null, 'no running time is counted')
  assert.equal(await t.storage('c1').get('runtime'), undefined)
  await t.drain('c1', { steps: 5, horizonMs: 60_000 })
  assert.equal(t.cloud.starts.length, starts, 'nothing starts while held')
  t.advance(15 * DAY_MS)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'committed', 'it learns once the hold ends')
})

test('F185 a hold acknowledged while a dirty container stops for questions: nothing wakes, and no start counts as failed', async () => {
  const t = await awakeOnStandard1()
  const storage = t.storage('c1')
  const runtime = await storage.get<any>('runtime')
  await storage.put('runtime', { ...runtime, dirty: true })
  await storage.put('meta', { ...(await storage.get<any>('meta')), wakeRequested: true })
  await storage.setAlarm(t.now())
  const starts = t.cloud.starts.length
  const hold = duringFirstDestroy(t, async () => {
    assert.equal((await holdFor(t)).body.held, true)
  })
  await t.drain('c1', { steps: 1 })
  assert.ok(hold.landed)
  assert.equal(t.cloud.starts.length, starts, 'no container started for questions')
  assert.equal(t.container('c1').running, false)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'held')
  assert.ok(!(await log(t, 'c1')).some((e: any) => e.event === 'start-failed'), 'not a failed start')
  assert.deepEqual([...(await storage.list({ prefix: 'startFailures:' })).keys()], [])
  assert.equal((await storage.get<any>('ledger')).kind, null)
})

test('F185 a hold acknowledged while the awake container stops for a go back: no container starts, no failure counted', async () => {
  const t = await awakeOnStandard1()
  await learn(t, 'c1', 'imp-1', [doc(2)])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 2)
  assert.equal((await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')).status, 200)
  const starts = t.cloud.starts.length
  const hold = duringFirstDestroy(t, async () => {
    assert.equal((await holdFor(t)).body.held, true)
  })
  await t.drain('c1', { steps: 1 })
  assert.ok(hold.landed)
  assert.equal(t.cloud.starts.length, starts, 'no container started for the go back')
  assert.equal(t.container('c1').running, false)
  assert.equal(await t.storage('c1').get('opFailures'), undefined, 'not a failed operation')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 2, 'nothing went back')
})

test('F185 a hold acknowledged while the question container stops for a removal for good: the removal still starts and commits', async () => {
  const t = await awakeOnStandard1()
  const starts = t.cloud.starts.length
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  assert.equal(removed.status, 200)
  const hold = duringFirstDestroy(t, async () => {
    assert.equal((await holdFor(t)).body.held, true)
  })
  for (let i = 0; i < 5; i++) {
    await t.drain('c1', { steps: 50 })
    t.advance(60_000)
  }
  assert.ok(hold.landed)
  assert.equal(t.cloud.starts.at(starts)?.instance, 'standard-4', 'the removal started its learning container')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, removed.body.version)
  assert.equal(t.container('c1').running, false, 'and it stopped after, held')
})

test('F185 a hold that lands as a repair is about to start its container: it waits, then tries the same restore point', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  // Version 2 fails its check twice; the hold lands while the repair reads the latest backup, before its container.
  const get = t.backups.get.bind(t.backups)
  let starts = -1
  ;(t.backups as any).get = async (key: string) => {
    if (starts < 0 && key.endsWith('latest.json') && (await t.storage('c1').get<any>('meta')).op?.kind === 'repair') {
      starts = t.cloud.starts.length
      assert.equal((await holdFor(t)).body.held, true)
    }
    return get(key)
  }
  for (let i = 0; i < 40 && starts < 0; i++) await t.drain('c1', { steps: 1 })
  ;(t.backups as any).get = get
  assert.ok(starts >= 0, 'the hold landed during the repair')
  assert.equal(t.cloud.starts.length, starts, 'no container started')
  const op = (await t.storage('c1').get<any>('meta')).op
  assert.deepEqual([op?.kind, op?.failedVersion, op?.tried], ['repair', 2, []], 'it waits, version 1 not counted as tried')
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'operation-held'))
  assert.equal(await t.storage('c1').get('opFailures'), undefined, 'not a failed operation')
  await t.drain('c1', { steps: 5, horizonMs: 60_000 })
  assert.equal(t.cloud.starts.length, starts, 'nothing starts while held')
  // Lifted: the repair answers from version 1, the restore point it was about to try.
  assert.equal((await liftHold(t)).body.held, false)
  let answered = false
  for (let i = 0; i < 40 && !answered; i++) {
    await t.drain('c1', { steps: 1 })
    const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
    answered = points[0]?.summary === 'Answering from version 1 after version 2 failed its check'
  }
  assert.ok(answered, 'it answered from version 1')
})

test('F186 a held queued import whose release failed stays owed: the alarm tells the guard again until it has', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(15 * 60_000)
  await t.drain('c1')
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let held = false
  let refusing = true
  let releases = 0
  const restore = wrapGuard(t, async (path, call) => {
    if (!held && path === '/acquire') {
      held = true
      assert.equal((await holdFor(t)).body.held, true)
    }
    if (path === '/release') {
      releases += 1
      if (refusing) throw new Error('Network connection lost.')
    }
    return call()
  })
  await t.drain('c1', { steps: 1 })
  assert.ok(held)
  assert.deepEqual((await t.storage('c1').get<any>('meta')).queue, ['imp-1'], 'it waits, held, in the queue')
  assert.ok((await guard(t)).running.includes('org-acme:c1:imp-1'), 'the guard granted it a slot')
  assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'])
  const tried = releases
  await t.drain('c1', { steps: 3, horizonMs: 30_000 })
  assert.ok(releases > tried, 'the alarm told the guard again')
  assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'], 'still owed: nothing confirmed the release')
  assert.ok((await guard(t)).running.includes('org-acme:c1:imp-1'))
  refusing = false
  await t.drain('c1', { steps: 3, horizonMs: 30_000 })
  restore()
  assert.deepEqual(await guard(t), { running: [], waiting: [] }, 'the slot went back')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined, 'nothing is owed any more')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued')
})

test('F186 a hold that stops a running import while the guard can\'t be told: the release is owed and told again', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(6 * 60_000)
  t.cloud.jobPolls = 5
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  await t.drain('c1', { steps: 2 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'learning')
  let refusing = true
  const restore = wrapGuard(t, async (path, call) => {
    if (refusing && path === '/release') throw new Error('Network connection lost.')
    return call()
  })
  assert.equal((await holdFor(t)).body.held, true)
  await t.drain('c1', { steps: 1 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued', 'stopped for the hold')
  assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'], 'the release is owed')
  assert.ok((await guard(t)).running.includes('org-acme:c1:imp-1'))
  refusing = false
  await t.drain('c1', { steps: 3, horizonMs: 30_000 })
  restore()
  assert.deepEqual(await guard(t), { running: [], waiting: [] }, 'told again from the alarm')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined)
})

for (const end of ['committed', 'failed'] as const) {
  test(`F186 an import that ${end} while the guard can't be told: its release is owed and told again`, async () => {
    const t = makeEngine()
    await createCollection(t)
    if (end === 'failed') t.cloud.failExtraction.f2 = 'This file has no text Knowledge can read.'
    await startImport(t, 'c1', 'imp-1', [doc(2)])
    let refusing = true
    const restore = wrapGuard(t, async (path, call) => {
      if (refusing && path === '/release') throw new Error('Network connection lost.')
      return call()
    })
    for (let i = 0; i < 20 && (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state !== end; i++) await t.drain('c1', { steps: 1 })
    assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, end)
    assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'], 'the release is owed')
    assert.ok((await guard(t)).running.includes('org-acme:c1:imp-1'))
    refusing = false
    await t.drain('c1', { steps: 5, horizonMs: 30_000 })
    restore()
    assert.deepEqual(await guard(t), { running: [], waiting: [] }, 'told again from the alarm')
    assert.equal(await t.storage('c1').get('capacityReturns'), undefined)
  })
}

for (const refusing of [false, true]) {
  test(`F186 when the hold lands, an import waiting in the guard's list leaves it${refusing ? ', told again until the guard confirms' : ''}: no slot goes to it`, async () => {
    const t = makeEngine()
    t.cloud.jobPolls = 100000
    // The organization's two slots are taken, so the guard puts imp-1 in its waiting list.
    for (const cid of ['c2', 'c3']) {
      await createCollection(t, cid)
      await startImport(t, cid, `big-${cid}`, [doc(5)])
      await t.drain(cid, { steps: 3 })
    }
    await createCollection(t)
    await startImport(t, 'c1', 'imp-1', [doc(2)])
    await t.drain('c1', { steps: 3 })
    assert.ok((await guard(t)).waiting.includes('imp-1'))
    assert.equal((await t.storage('c1').get<any>('imp:imp-1')).capacity, 'waiting')
    let refuse = refusing
    const restore = wrapGuard(t, async (path, call) => {
      if (refuse && path === '/release') throw new Error('Network connection lost.')
      return call()
    })
    // The hold stops both big imports: their slots free up, and nothing of this organization may take them.
    assert.equal((await holdFor(t)).body.held, true)
    await t.drain(undefined, { steps: 30, horizonMs: 30_000 })
    if (refusing) {
      assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'], 'the release is owed')
      assert.ok((await guard(t)).waiting.includes('imp-1'), 'the guard could not be told')
      refuse = false
      await t.drain(undefined, { steps: 30, horizonMs: 30_000 })
    }
    restore()
    assert.deepEqual(await guard(t), { running: [], waiting: [] }, 'the guard holds nothing for the held organization')
    assert.equal(await t.storage('c1').get('capacityReturns'), undefined)
    assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued', 'it waits for the hold to end')
    // Lifted, it asks the guard again and learns.
    t.cloud.jobPolls = 1
    assert.equal((await liftHold(t)).body.held, false)
    await t.drain()
    assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'committed')
  })
}

test('F187 a hold during the first renewal, the clock unchanged: the app hears the start, then the requeue', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(15 * 60_000)
  await t.drain('c1')
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let held = false
  const restore = wrapGuard(t, async (path, call) => {
    if (!held && path === '/renew') {
      held = true
      await holdFor(t)
    }
    return call()
  })
  const at = t.now()
  await t.drain('c1', { steps: 1 })
  restore()
  assert.ok(held)
  assert.equal(t.now(), at, 'both in the same millisecond')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued')
  assert.deepEqual(await importStates(t, 'imp-1'), [['reading', 1], ['queued', 1]], 'started, then back in the queue')
})

test('F187 pending events keep the order they were added in, within one millisecond and after a restart', async () => {
  const storage = new FakeStorage()
  const event = (key: string): PendingEvent => ({ key, event: { at: '2026-11-16T09:00:00.000Z', org: ORG, collectionId: 'c1', type: 'deleted' } as PendingEvent['event'] })
  const first = new CollectionStore(storage as any)
  await first.addEvents([event('x:started'), event('x:a')])
  await first.addEvents([event('x:requeued')])
  // Two at once (one inside a transaction) take numbers of their own.
  await Promise.all([first.addEvents([event('x:b')]), storage.transaction((txn) => first.addEvents([event('x:c')], txn as any))])
  // A restart (a new object on the same storage) goes on after what is stored.
  const second = new CollectionStore(storage as any)
  await second.addEvents([event('x:0')])
  assert.deepEqual((await second.pendingEvents()).map(([, e]) => e.key), ['x:started', 'x:a', 'x:requeued', 'x:b', 'x:c', 'x:0'])
  // Sent and deleted, the numbers still go on.
  await storage.delete([...(await second.pendingEvents()).map(([key]) => key)])
  const third = new CollectionStore(storage as any)
  await third.addEvents([event('x:later')])
  const [[key]] = await third.pendingEvents()
  assert.ok(key > `pending:${String(6).padStart(15, '0')}`, key)
})

test('F193 an import a removal stopped, whose release failed once: the alarm tells the guard again, so the removal gets a slot', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(6 * 60_000)
  // The organization's two slots are taken: one by c1's import, one by c2's.
  t.cloud.jobPolls = 100000
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  await t.drain('c1', { steps: 3 })
  await createCollection(t, 'c2')
  await startImport(t, 'c2', 'big-c2', [doc(5)])
  await t.drain('c2', { steps: 3 })
  assert.deepEqual((await guard(t)).running.sort(), ['org-acme:c1:imp-1', 'org-acme:c2:big-c2'])
  t.cloud.jobPolls = 1
  let releases = 0
  const restore = wrapGuard(t, async (path, call) => {
    if (path === '/release' && ++releases === 1) throw new Error('Network connection lost.')
    return call()
  })
  // A removal for good stops c1's import; its release fails once.
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-1.md')
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  await t.drain('c1', { steps: 1 })
  const meta = await t.storage('c1').get<any>('meta')
  assert.deepEqual([meta.active, meta.queue.length, meta.queue[1]], [null, 2, 'imp-1'], 'the removal waits ahead of the stopped import')
  assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'], 'its release is owed')
  // The removal is next, not imp-1: the guard is told again, and the removal gets the slot.
  const start = t.now()
  for (let i = 0; i < 30 && (await t.api('GET', '/v1/collections/c1')).body.version !== removed.body.version; i++) {
    await t.drain('c1', { steps: 1, horizonMs: 30_000 })
  }
  restore()
  assert.ok(releases > 1, 'the release was told again')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, removed.body.version, 'the removal committed')
  assert.ok(t.now() - start < 30 * 60_000, 'well before the stale slot\'s lease would have lapsed')
  assert.ok(!(await t.storage('c1').get<string[]>('capacityReturns'))?.includes('imp-1'), 'nothing owed for imp-1')
})

test('F193 the import asked for next keeps what the guard holds: an /acquire answer lost for the head of the queue sends no release', async () => {
  const t = makeEngine()
  await createCollection(t)
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let lost = false
  let releases = 0
  const restore = wrapGuard(t, async (path, call) => {
    if (path === '/release') releases += 1
    const answer = await call()
    if (!lost && path === '/acquire') {
      lost = true
      throw new Error('Network connection lost.')
    }
    return answer
  })
  await t.drain('c1', { steps: 1 })
  assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'])
  for (let i = 0; i < 10 && (await t.storage('c1').get<any>('meta')).active !== 'imp-1'; i++) await t.drain('c1', { steps: 1, horizonMs: 30_000 })
  assert.equal((await t.storage('c1').get<any>('meta')).active, 'imp-1', 'it asked again and took its slot')
  assert.equal(releases, 0, 'nothing was given back')
  await t.drain('c1', { horizonMs: 30_000 })
  restore()
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'committed')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined)
  assert.deepEqual(await guard(t), { running: [], waiting: [] })
})
