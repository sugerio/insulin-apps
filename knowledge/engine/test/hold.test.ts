// The organization hold (the app's hard stop on awake hours, enforced here) and settings revisions.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORG, OTHER_ORG, ask, createCollection, doc, learn, log, makeEngine, outboxEvents, startImport } from './helpers.ts'

/** A hold request as the app sends it: each a newer version of the organization's hold wish. */
let wishes = 0
const wish = (until: string | null, version = ++wishes) => ({ until, version })

const DAY = 24 * 60 * 60_000

test('a held organization starts no container: questions answer "held", running ones stop, and the hold lifts', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  await createCollection(t, 'other', OTHER_ORG)
  await learn(t, 'other', 'imp-o', [doc(9)], OTHER_ORG)
  assert.equal(t.container('c1').running, true)
  const until = new Date(t.now() + DAY).toISOString()
  const held = await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(until))
  assert.deepEqual([held.status, held.body], [200, { held: true, until }])
  assert.equal((await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(until), { org: OTHER_ORG })).status, 404, 'the header names the organization')
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
  assert.deepEqual((await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(null))).body, { held: false, until: null })
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
  await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(new Date(t.now() + 60 * 60_000).toISOString()))
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
  // Once lifted, the alarm doesn't keep firing: for an asleep collection, the next one is a while away.
  t.advance(30 * 60_000)
  for (const cid of ['c1', 'c2']) {
    const steps = await t.drain(cid, { steps: 200 })
    assert.ok(steps < 50, `${cid}: ${steps} alarms in a row`)
    const alarm = t.storage(cid).alarm
    assert.ok(alarm === null || alarm > t.now() + 60_000, `${cid}: next alarm ${alarm === null ? null : alarm - t.now()} ms away`)
  }
  assert.ok(!(await t.storage('c1').get<any>('meta')).heldUntil, 'the passed hold is cleared')
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

const DAY_MS = 24 * 60 * 60_000
const holdFor = (t: any, days = 14) => t.api('POST', `/v1/orgs/${ORG}/hold`, wish(new Date(t.now() + days * DAY_MS).toISOString()))

async function twoVersions() {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep, with a backup
  return t
}

for (const pending of ['going back', 'waking from backup'] as const) {
  test(`while held, a removal for good starts though ${pending} is pending, and stop using commits at once`, async () => {
    const t = await twoVersions()
    if (pending === 'going back') await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
    else {
      await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
      await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
      await t.drain('c1', { steps: 1 })
    }
    await holdFor(t)
    await t.drain('c1')
    const docs = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
    const stop = await t.api('PATCH', `/v1/collections/c1/documents/${docs[1].documentId}`, { active: false })
    assert.deepEqual([stop.status, stop.body.state], [200, 'committed'])
    const removed = await t.api('DELETE', `/v1/collections/c1/documents/${docs[0].documentId}`)
    assert.equal(removed.status, 200)
    for (let i = 0; i < 10; i++) {
      await t.drain('c1', { steps: 50 })
      t.advance(60_000)
    }
    const status = (await t.api('GET', '/v1/collections/c1')).body
    assert.ok(!(await t.api('GET', '/v1/collections/c1/documents')).body.documents.some((d: any) => d.documentId === docs[0].documentId))
    assert.equal(status.state, 'held')
    assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'committed' && e.kind === 'remove'))
  })
}

test('while held, a removal for good goes ahead of a queued re-learning', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  t.cloud.image = 'registry.example/engine@2'
  t.cloud.dataFormat = 'fmt-2'
  t.cloud.jobPolls = 100000
  for (const cid of ['c2', 'c3']) {
    await createCollection(t, cid)
    await startImport(t, cid, `big-${cid}`, [doc(5)])
    await t.drain(cid, { steps: 3 })
  }
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  await t.drain('c1', { steps: 5 })
  assert.ok((await t.storage('c1').get<any>('meta')).queue.length, 'a re-learning waits')
  await holdFor(t)
  t.cloud.jobPolls = 1
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  // The hold stops the two big imports elsewhere, freeing the organization's slots.
  for (let i = 0; i < 30; i++) {
    await t.drain(undefined, { steps: 20 })
    t.advance(60_000)
  }
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [removed.body.version, 1])
})

test("the hold reaches a collection that didn't answer at first: the registry tries again", async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  const get = t.collections.get.bind(t.collections)
  let refused = false
  t.collections.get = (id: { name: string }) => {
    const stub = get(id)
    return {
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!refused && url.endsWith('/internal/hold')) {
          refused = true
          throw new Error('the collection is restarting')
        }
        return stub.fetch(input, init)
      },
    }
  }
  const answer = await holdFor(t, 1)
  assert.equal(answer.body.held, true)
  assert.ok(refused)
  await t.drain(undefined, { horizonMs: 10 * 60_000 })
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'held')
})

test('while held: imports and corrections wait, stop using commits, go back, undo and exports answer 429 capacity', async () => {
  const t = await twoVersions()
  await holdFor(t, 2)
  await t.drain('c1')
  const imported = await startImport(t, 'c1', 'imp-3', [doc(4)])
  assert.deepEqual([imported.status, imported.body.state], [202, 'queued'])
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  const corrected = await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n1', title: 'Fix', text: 'Corrected.', outdated: [{ documentId: target.documentId, textHash: 'a'.repeat(64) }] },
  })
  assert.deepEqual([corrected.status, corrected.body.state], [202, 'queued'])
  const stop = await t.api('PATCH', `/v1/collections/c1/documents/${target.documentId}`, { active: false })
  assert.deepEqual([stop.status, stop.body.state], [200, 'committed'])
  for (const [method, path, body] of [
    ['POST', '/v1/collections/c1/restore-points/1/go-back', undefined],
    ['POST', '/v1/collections/c1/undo', undefined],
    ['POST', '/v1/collections/c1/exports', { exportId: 'e1' }],
  ] as const) {
    const res = await t.api(method, path, body)
    assert.deepEqual([res.status, res.body.error], [429, 'capacity'], path)
    assert.ok(res.body.retryAfterSeconds > 0 && res.body.retryAfterSeconds <= 2 * 24 * 3600, path)
  }
  assert.equal((await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })).body.status, 'held')
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-3')).body.state, 'queued', 'it waits for the hold to end')
})

for (const order of ['a hold, then a lift', 'a lift, then a hold'] as const) {
  test(`hold changes whose deliveries overlap (${order}): every collection ends with the newer one`, async () => {
    const t = makeEngine()
    await createCollection(t, 'c1')
    await createCollection(t, 'c2')
    const until = new Date(t.now() + DAY_MS).toISOString()
    if (order === 'a lift, then a hold') {
      // The older call lifts a hold the organization had; the newer one holds it again.
      await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(until))
    }
    const [older, newer] = order === 'a hold, then a lift' ? [until, null] : [null, until]
    // The older call's delivery to c1 is answered only after the newer call has told everyone.
    const get = t.collections.get.bind(t.collections)
    let paused: (() => void) | null = null
    let reached!: () => void
    const atC1 = new Promise<void>((resolve) => (reached = resolve))
    t.collections.get = (id: { name: string }) => {
      const stub = get(id)
      return {
        fetch: async (input: RequestInfo, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input)
          const response = await stub.fetch(input, init)
          if (url.endsWith('/internal/hold') && id.name.endsWith(':c1') && paused === null) {
            await new Promise<void>((resolve) => {
              paused = resolve
              reached()
            })
          }
          return response
        },
      }
    }
    const first = t.api('POST', `/v1/orgs/${ORG}/hold`, wish(older))
    await atC1
    const second = await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(newer))
    assert.equal(second.body.held, newer !== null)
    paused!()
    await first
    t.collections.get = get
    for (const cid of ['c1', 'c2']) {
      assert.equal((await t.storage(cid).get<any>('meta')).heldUntil, newer, `${cid} holds the newer change`)
      assert.equal((await t.api('GET', `/v1/collections/${cid}`)).body.state === 'held', newer !== null, cid)
    }
    assert.ok((await log(t, 'c2')).some((e: any) => e.event === 'hold-stale'), "c2 refused the older call's delivery")
    assert.equal(await t.registry.instance('registry').state.storage.get(`holdTodo:${ORG}`), undefined, 'nothing left to retry')
  })
}

test('a go back asked for before a hold lands is dropped: nothing goes back, and the app hears the collection is held', async () => {
  const t = await twoVersions()
  await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.equal((await t.storage('c1').get<any>('meta')).op?.kind, 'go_back')
  await holdFor(t, 1)
  assert.equal((await t.storage('c1').get<any>('meta')).op, null)
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'go-back-dropped-for-hold'))
  await t.drain('c1')
  assert.ok((await outboxEvents(t)).some((e: any) => e.type === 'state' && e.state === 'held' && e.collectionId === 'c1'))
  t.advance(DAY_MS + 60_000) // the hold ends by itself
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 2, 'still at version 2')
  assert.ok(!(await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.some((p: any) => /Went back/.test(p.summary)))
})

test('a go back whose container is starting when the hold lands commits nothing', async () => {
  const t = await twoVersions()
  await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  // The hold arrives while the go back's container is checked, before anything commits.
  const box = t.container('c1') as any
  const port = box.getTcpPort.bind(box)
  let landed = false
  box.getTcpPort = (n: number) => {
    const inner = port(n)
    return {
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!landed && url.endsWith('/jobs') && init?.method === 'POST') {
          landed = true
          await holdFor(t, 1)
        }
        return inner.fetch(input, init)
      },
    }
  }
  await t.drain('c1')
  assert.ok(landed)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 2)
  assert.equal(t.container('c1').running, false, 'its container was stopped')
  assert.ok(!(await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.some((p: any) => /Went back/.test(p.summary)))
})

test('a hold that arrives while an import takes its snapshot: the import keeps nothing and waits, a removal still commits', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(6 * 60_000)
  const box = t.container('c1') as any
  const snapshot = box.snapshotContainer.bind(box)
  let landed = false
  box.snapshotContainer = async (options: any) => {
    if (!landed) {
      landed = true
      await holdFor(t, 1)
    }
    return snapshot(options)
  }
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await t.drain('c1')
  assert.ok(landed)
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-2')).body
  assert.deepEqual([status.state, status.attempt, status.version], ['queued', 1, null], 'it waits for the hold to end, its try not counted')
  const collection = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([collection.version, collection.counts.documents, collection.state], [1, 2, 'held'], 'nothing of it was kept')
  // A removal for good still goes ahead while held.
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  for (let i = 0; i < 10; i++) {
    await t.drain('c1', { steps: 50 })
    t.advance(60_000)
  }
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, removed.body.version)
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'queued')
  // Once the hold ends, the import learns.
  t.advance(DAY_MS)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'committed')
})

for (const order of ['a hold, then an older lift', 'a lift, then an older hold'] as const) {
  test(`the app's hold wish is versioned (${order}, its response lost): the older request changes nothing`, async () => {
    const t = makeEngine()
    await createCollection(t, 'c1')
    await createCollection(t, 'c2')
    const until = new Date(t.now() + DAY_MS).toISOString()
    // Version 5 reaches the engine and its answer is lost; version 4, sent earlier, arrives after it.
    const [newer, older] = order === 'a hold, then an older lift' ? [until, null] : [null, until]
    if (newer === null) await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(until, 3))
    await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(newer, 5))
    const late = await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(older, 4))
    assert.equal(late.status, 200)
    assert.deepEqual(late.body, { held: newer !== null, until: newer }, 'it answers the state the newer wish made')
    for (const cid of ['c1', 'c2']) assert.equal((await t.storage(cid).get<any>('meta')).heldUntil, newer, cid)
    // The app sends version 5 again (its answer was lost): the same answer, nothing changes.
    assert.deepEqual((await t.api('POST', `/v1/orgs/${ORG}/hold`, wish(newer, 5))).body, { held: newer !== null, until: newer })
    // A collection refuses a delivery of an older wish too.
    const delivered = await t.collections.get(t.collections.idFromName(`${ORG}:c1`)).fetch('https://engine.internal/internal/hold', {
      method: 'POST',
      headers: { 'x-knowledge-org': ORG, 'content-type': 'application/json' },
      body: JSON.stringify({ until: older, seq: 99, version: 4 }),
    })
    assert.equal((await delivered.json()).stale, true)
    assert.equal((await t.storage('c1').get<any>('meta')).heldUntil, newer)
  })
}

test('a hold request names its version', async () => {
  const t = makeEngine()
  for (const body of [{ until: null }, { until: null, version: -1 }, { until: null, version: 1.5 }]) {
    const res = await t.api('POST', `/v1/orgs/${ORG}/hold`, body)
    assert.deepEqual([res.status, res.body.error], [400, 'bad_request'], JSON.stringify(body))
  }
})
