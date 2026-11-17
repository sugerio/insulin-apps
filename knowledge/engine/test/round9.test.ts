import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORG, ask, createCollection, doc, learn, makeEngine, outboxEvents, startImport, type TestEngine } from './helpers.ts'

// Round 9 of the review: what the app hears about an import between its start and its end (F168), a corrected passage
// that loses a merge without moving (F169), a hold that lands while the capacity guard answers (F170), and a cancel
// after an /acquire answer that was lost (F171).

const importStates = async (t: TestEngine, importId: string) =>
  (await outboxEvents(t)).filter((e: any) => e.type === 'import' && e.import.importId === importId).map((e: any) => [e.import.state, e.import.attempt])

async function guard(t: TestEngine) {
  const res = await t.capacity.get(t.capacity.idFromName('capacity')).fetch('https://engine.internal/state')
  const state = (await res.json()) as { running: Record<string, unknown>; waiting: { importId: string }[] }
  return { running: Object.keys(state.running), waiting: state.waiting.map((w) => w.importId) }
}

/** Wraps the capacity guard: `around` runs for each call to `path`, before (and may replace) the guard's answer. */
function wrapGuard(t: TestEngine, around: (path: string, call: () => Promise<Response>) => Promise<Response>) {
  const get = t.capacity.get.bind(t.capacity)
  ;(t.capacity as any).get = (id: any) => {
    const stub = get(id)
    return {
      fetch: (input: RequestInfo, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        return around(new URL(url).pathname, () => stub.fetch(input, init))
      },
    }
  }
  return () => {
    ;(t.capacity as any).get = get
  }
}

test('F168 the app hears an import start, be interrupted and tried again in place (not cancellable), and go back to the queue', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(6 * 60_000)
  t.cloud.jobPolls = 5
  const sent = await startImport(t, 'c1', 'imp-5', [2, 3, 4, 5, 6].map((n) => doc(n)))
  assert.deepEqual([sent.status, sent.body.state], [202, 'queued'])
  await t.drain('c1', { steps: 2 })
  assert.deepEqual(await importStates(t, 'imp-5'), [['reading', 1]], 'its start is an event: the app no longer lists it as waiting')
  let killed = false
  for (let i = 0; i < 30 && !killed; i++) {
    await t.drain('c1', { steps: 1 })
    const status = (await t.api('GET', '/v1/collections/c1/imports/imp-5')).body
    if (status.files.filter((f: any) => f.state === 'learned').length >= 3) {
      killed = true
      await t.api('POST', '/v1/collections/c1/__test/destroy-container')
    }
  }
  await t.drain('c1', { steps: 2 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-5')).body.state, 'interrupted')
  // Interrupted, it stays the active import and is tried again in place: it can't be cancelled.
  assert.equal((await t.storage('c1').get<any>('meta')).active, 'imp-5')
  const cancel = await t.api('DELETE', '/v1/collections/c1/imports/imp-5')
  assert.deepEqual([cancel.status, cancel.body.error], [409, 'busy_learning'])
  assert.deepEqual((await importStates(t, 'imp-5')).at(-1), ['interrupted', 2])
  t.advance(60_000)
  await t.drain('c1')
  assert.deepEqual(await importStates(t, 'imp-5'), [['reading', 1], ['interrupted', 2], ['reading', 2], ['committed', 2]])

  // A hold sends an import that started back to the queue: the app hears it waits again.
  t.cloud.jobPolls = 5
  t.advance(6 * 60_000)
  await startImport(t, 'c1', 'imp-6', [doc(7)])
  await t.drain('c1', { steps: 2 })
  await t.api('POST', `/v1/orgs/${ORG}/hold`, { until: new Date(t.now() + 60 * 60_000).toISOString(), version: 1 })
  await t.drain('c1', { steps: 3 })
  assert.deepEqual(await importStates(t, 'imp-6'), [['reading', 1], ['queued', 1]])
  // Waiting again, it can be cancelled.
  assert.equal((await t.api('DELETE', '/v1/collections/c1/imports/imp-6')).body.state, 'cancelled')
})

test('F169 a corrected passage that loses a merge without moving gives up its check: the event names its correction', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [{ fileId: 'codes', name: 'codes.md', text: 'The gate code is Bluewater.\n\nThe gate code is Redwater.' }])
  const passages = (await ask(t, 'c1', 'gate code')).body.passages
  const [blue, red] = ['Bluewater', 'Redwater'].map((w) => passages.find((p: any) => p.text.includes(w)))
  // The older correction is on Redwater's passage, the newer on Bluewater's.
  for (const [importId, noteId, passage] of [['fix-1', 'n-old', red], ['fix-2', 'n-new', blue]] as const) {
    t.advance(6 * 60_000)
    await t.api('POST', '/v1/collections/c1/corrections', {
      importId,
      note: { noteId, title: noteId, text: `Corrected by ${noteId}.`, outdated: [{ documentId: passage.documentId, textHash: passage.textHash }] },
    })
    await t.drain('c1')
  }
  const reread = async (words: string[]) => {
    t.advance(6 * 60_000)
    await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words } } })
    for (let i = 0; i < 5; i++) {
      await t.drain('c1')
      t.advance(60_000)
    }
  }
  // Hiding Redwater moves the older correction's mark: it asks to be checked under the new hash.
  await reread(['Redwater'])
  const first = (await outboxEvents(t)).filter((e: any) => e.type === 'needs_check')
  assert.equal(first.length, 1)
  const merged = first[0].textHash
  assert.deepEqual([first[0].noteId, first[0].previousNoteId, first[0].previousTextHash], ['n-old', 'n-old', red.textHash])
  // Hiding Bluewater too makes both passages read the same: the newer correction keeps it. The older mark didn't move
  // this time, but its check goes: its event names it, so the app deletes (n-old, merged) and keeps one check.
  await reread(['Redwater', 'Bluewater'])
  const second = (await outboxEvents(t)).filter((e: any) => e.type === 'needs_check').slice(first.length)
  assert.deepEqual(
    second.map((e: any) => [e.noteId, e.textHash, e.previousNoteId, e.previousTextHash]).sort(),
    [
      ['n-new', merged, 'n-new', blue.textHash],
      ['n-new', merged, 'n-old', merged],
    ].sort(),
  )
  const notes = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.filter((d: any) => d.kind === 'note')
  assert.deepEqual(notes.map((d: any) => [d.name, d.active]).sort(), [['n-new', true], ['n-old', false]])
})

test('F170 a hold that lands while the guard answers: nothing is claimed, the slot goes back and no learning container starts', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(15 * 60_000)
  await t.drain('c1')
  assert.equal(t.container('c1').running, false, 'asleep')
  const starts = t.cloud.starts.length
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let held = false
  const restore = wrapGuard(t, async (path, call) => {
    if (!held && path === '/acquire') {
      held = true
      const answer = await t.api('POST', `/v1/orgs/${ORG}/hold`, { until: new Date(t.now() + 14 * 86_400_000).toISOString(), version: 5 })
      assert.equal(answer.body.held, true)
    }
    return call()
  })
  await t.drain('c1', { steps: 1 })
  restore()
  const meta = await t.storage('c1').get<any>('meta')
  assert.equal(meta.active, null, 'not claimed')
  assert.deepEqual(meta.queue, ['imp-1'], 'it waits in the queue')
  assert.equal(t.container('c1').running, false)
  assert.equal(t.cloud.starts.length, starts, 'no container started')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued')
  assert.deepEqual(await guard(t), { running: [], waiting: [] }, 'the slot went back')
  await t.drain('c1', { steps: 5 })
  assert.equal(t.cloud.starts.length, starts, 'nothing starts while held')
})

test('F170 a hold that lands while the lease is renewed stops the import before its container starts', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-0', [doc(1)])
  t.advance(15 * 60_000)
  await t.drain('c1')
  const starts = t.cloud.starts.length
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let held = false
  const restore = wrapGuard(t, async (path, call) => {
    if (!held && path === '/renew') {
      held = true
      await t.api('POST', `/v1/orgs/${ORG}/hold`, { until: new Date(t.now() + 14 * 86_400_000).toISOString(), version: 5 })
    }
    return call()
  })
  await t.drain('c1', { steps: 1 })
  restore()
  assert.equal(held, true)
  assert.equal(t.cloud.starts.length, starts, 'no container started')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'queued')
  assert.deepEqual((await guard(t)).running, [])
})

for (const granted of [true, false]) {
  test(`F171 a cancel after an /acquire answer that was lost (${granted ? 'granted' : 'denied'}) leaves nothing in the guard`, async () => {
    const t = makeEngine()
    await createCollection(t)
    t.cloud.jobPolls = 100000
    if (!granted) {
      // The organization's two slots are taken, so the guard puts imp-1 in its waiting list.
      for (const cid of ['c2', 'c3']) {
        await createCollection(t, cid)
        await startImport(t, cid, `big-${cid}`, [doc(5)])
        await t.drain(cid, { steps: 3 })
      }
    }
    await startImport(t, 'c1', 'imp-1', [doc(2)])
    let lost = false
    const restore = wrapGuard(t, async (path, call) => {
      const answer = await call()
      if (!lost && path === '/acquire') {
        lost = true
        throw new Error('Network connection lost.')
      }
      return answer
    })
    await t.drain('c1', { steps: 1 })
    restore()
    assert.equal(lost, true)
    const before = await guard(t)
    assert.ok(granted ? before.running.includes('org-acme:c1:imp-1') : before.waiting.includes('imp-1'), 'the guard holds something for it')
    assert.equal((await t.api('DELETE', '/v1/collections/c1/imports/imp-1')).body.state, 'cancelled')
    const after = await guard(t)
    assert.ok(!after.running.includes('org-acme:c1:imp-1') && !after.waiting.includes('imp-1'), 'the cancel gave it back')
  })
}

test('F171 a cancel that wins while /acquire is answered, whose answer is then lost: the alarm gives back what the guard holds', async () => {
  const t = makeEngine()
  await createCollection(t)
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let lost = false
  const restore = wrapGuard(t, async (path, call) => {
    if (lost || path !== '/acquire') return call()
    lost = true
    // The cancel runs while the guard is asked (its own release reaches the guard first), then the guard grants and
    // its answer is lost.
    assert.equal((await t.api('DELETE', '/v1/collections/c1/imports/imp-1')).body.state, 'cancelled')
    await call()
    throw new Error('Network connection lost.')
  })
  await t.drain('c1', { steps: 1 })
  restore()
  assert.equal(lost, true)
  await t.drain('c1', { steps: 3, horizonMs: 30_000 })
  assert.deepEqual(await guard(t), { running: [], waiting: [] }, 'the alarm gave back what the guard held for it')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined, 'nothing is owed any more')
})

test('F171 an /acquire answer lost for an import still queued: it asks again and gets its slot, nothing given back', async () => {
  const t = makeEngine()
  await createCollection(t)
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  let lost = false
  const restore = wrapGuard(t, async (path, call) => {
    const answer = await call()
    if (!lost && path === '/acquire') {
      lost = true
      throw new Error('Network connection lost.')
    }
    return answer
  })
  await t.drain('c1', { steps: 1 })
  restore()
  assert.deepEqual(await t.storage('c1').get('capacityReturns'), ['imp-1'])
  await t.drain('c1', { horizonMs: 30_000 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'committed')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined)
  assert.deepEqual(await guard(t), { running: [], waiting: [] })
})

test('F171 a release that fails is told again from the alarm', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.jobPolls = 100000
  for (const cid of ['c2', 'c3']) {
    await createCollection(t, cid)
    await startImport(t, cid, `big-${cid}`, [doc(5)])
    await t.drain(cid, { steps: 3 })
  }
  await startImport(t, 'c1', 'imp-1', [doc(2)])
  await t.drain('c1', { steps: 3 })
  assert.ok((await guard(t)).waiting.includes('imp-1'))
  let refusing = true
  const restore = wrapGuard(t, async (path, call) => {
    if (refusing && path === '/release') throw new Error('Network connection lost.')
    return call()
  })
  assert.equal((await t.api('DELETE', '/v1/collections/c1/imports/imp-1')).body.state, 'cancelled')
  assert.ok((await guard(t)).waiting.includes('imp-1'), 'the guard could not be told')
  refusing = false
  await t.drain('c1', { steps: 3, horizonMs: 30_000 })
  restore()
  assert.ok(!(await guard(t)).waiting.includes('imp-1'), 'told again from the alarm')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined)
})
