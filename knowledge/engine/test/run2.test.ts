// Fixes from the engine's second run on Cloudflare (g1118a):
// - going to sleep is single-flight, and container work a test control does from a request never overlaps the
//   alarm's (HID-04's backup failed between two goToSleep at once; ASK-06's sleep raced the alarm into an import);
// - the Worker sends an idempotent request again when its call to the collection's Durable Object is lost
//   ("Network connection lost."), and never one that isn't;
// - an answer Workers AI has no capacity for (3040) is asked again, within the answer's time budget.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS } from '../src/settings.ts'
import { type TestEngine, ask, createCollection, doc, learn, log, makeEngine, stageFile } from './helpers.ts'

const logged = async (t: TestEngine, event: string) => (await log(t, 'c1')).filter((e: any) => e.event === event)
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** c1 learned, awake and ready, with a backup due: going to sleep backs it up. */
async function awake(): Promise<TestEngine> {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  assert.equal((await ask(t, 'c1', 'topic number 1 gateway port')).body.status, 'ok')
  assert.equal((await t.storage('c1').get<any>('meta')).backupDue, true)
  return t
}

/** What c1's container was asked since call `from`: the jobs started, and each file read. */
function asked(t: TestEngine, from: number) {
  const calls = t.cloud.calls.slice(from).filter((c) => c.collection.endsWith(':c1'))
  const reads = calls.filter((c) => c.method === 'GET' && c.path.startsWith('/files/')).map((c) => c.path)
  return {
    jobs: calls.filter((c) => c.path === '/jobs' && c.detail).map((c) => c.detail),
    readTwice: reads.filter((path, i) => reads.indexOf(path) !== i),
    reads: reads.length,
  }
}

/** The container's file reads (a backup copying /data) wait until `open()`: `reached` says one is waiting. */
function holdFileReads(t: TestEngine) {
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  let reached!: () => void
  const waiting = new Promise<void>((resolve) => (reached = resolve))
  box.serve = async (request: Request) => {
    if (request.method === 'GET' && new URL(request.url).pathname.startsWith('/files/')) {
      reached()
      await gate
    }
    return serve(request)
  }
  return { reached: waiting, open: () => open() }
}

// ==================================================================== going to sleep, one at a time

test('HID-04 two goToSleep at once (the alarm\'s and a test control\'s): the second waits, and one whole backup is taken', async () => {
  const t = await awake()
  const from = t.cloud.calls.length
  const files = holdFileReads(t)
  const control = t.api('POST', '/v1/collections/c1/__test/backup')
  await files.reached // the control's backup is copying /data
  // The awake window runs out meanwhile: the alarm goes to sleep too.
  t.advance(11 * 60_000)
  const alarm = t.object('c1').alarm()
  await settle()
  files.open()
  await alarm
  const res = await control
  assert.equal(res.status, 200)
  const calls = asked(t, from)
  assert.deepEqual([calls.jobs, calls.readTwice], [['manifest'], []], 'one backup: one manifest, each file read once')
  assert.ok(calls.reads > 0)
  assert.deepEqual(await logged(t, 'backup-failed'), [])
  assert.equal(t.container('c1').running, false)
  assert.ok(res.body.lastBackupAt)
})

test('two goToSleep called at once share one: the second caller waits for the first', async () => {
  const t = await awake()
  const from = t.cloud.calls.length
  const files = holdFileReads(t)
  const engine = t.object('c1')
  const first = engine.goToSleep()
  await files.reached
  const second = engine.goToSleep()
  await settle()
  files.open()
  await Promise.all([first, second])
  const calls = asked(t, from)
  assert.deepEqual([calls.jobs, calls.readTwice], [['manifest'], []])
  assert.deepEqual(await logged(t, 'backup-failed'), [])
  assert.equal(t.container('c1').running, false)
})

test('ASK-06 while a test control backs the container up, the alarm drives nothing on it: no query process, no import', async () => {
  const t = await awake()
  const files = holdFileReads(t)
  const control = t.api('POST', '/v1/collections/c1/__test/sleep')
  await files.reached
  const from = t.cloud.calls.length
  // Within the awake window, with a correction waiting: the alarm would open the query process again, or learn.
  await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n-fix', title: 'Port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [] },
  })
  const alarm = t.object('c1').alarm()
  await settle()
  const during = t.cloud.calls.slice(from).filter((c) => c.collection.endsWith(':c1'))
  assert.deepEqual(during.filter((c) => c.path.startsWith('/query/') || c.path === '/jobs').map((c) => `${c.method} ${c.path} ${c.detail ?? ''}`), [], 'nothing while it is backed up')
  files.open()
  await alarm
  assert.equal((await control).status, 200)
  assert.deepEqual(await logged(t, 'backup-failed'), [])
  assert.deepEqual(await logged(t, 'import-try-failed'), [], 'no import on the container going to sleep')
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/fix-1')).body.state, 'committed')
})

// ==================================================================== a lost call to the Durable Object

/**
 * The Worker's calls to the collection's Durable Object that `match` lose their connection, `times` times; with
 * `delivered`, the Durable Object got the request and only its answer was lost. Counts what reached the object.
 */
function loseCalls(t: TestEngine, match: (request: Request) => boolean, times: number, delivered = false) {
  const reached: string[] = []
  const get = t.collections.get.bind(t.collections)
  ;(t.collections as any).get = (id: { name: string }) => {
    const stub = get(id)
    return {
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const lose = times > 0 && match(request)
        if (lose) times -= 1
        if (lose && !delivered) throw Object.assign(new Error('Network connection lost.'), { retryable: true })
        reached.push(`${request.method} ${new URL(request.url).pathname}`)
        const response = await stub.fetch(request)
        if (lose) throw Object.assign(new Error('Network connection lost.'), { retryable: true })
        return response
      },
    }
  }
  return reached
}

const path = (suffix: string) => (request: Request) => new URL(request.url).pathname.endsWith(suffix)

test('a search whose call to the Durable Object is lost is sent again, and answers', async () => {
  const t = await awake()
  loseCalls(t, path('/search'), 1)
  const res = await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 1 gateway port' })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'ok')
})

test('an import whose answer was lost on the way back is sent again under its id: one import, answered', async () => {
  const t = makeEngine()
  await createCollection(t)
  const staged = await stageFile(t, 'c1', doc(1))
  const reached = loseCalls(t, path('/imports'), 1, true)
  const res = await t.api('POST', '/v1/collections/c1/imports', { importId: 'imp-1', files: [staged], notes: [], small: false })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.importId, 'imp-1')
  assert.equal(reached.filter((r) => r.endsWith('/imports')).length, 2, 'sent twice')
  assert.equal((await logged(t, 'import-queued')).length, 1, 'learned once')
})

test('a lost call that isn\'t safe to send twice (go back, a staged file\'s stream) is not sent again', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-2', [doc(2)])
  const reached = loseCalls(t, (r) => path('/go-back')(r) || new URL(r.url).pathname.includes('/inbox/'), 2, true)
  const back = await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.deepEqual([back.status, back.body.error], [500, 'internal'])
  assert.equal(reached.filter((r) => r.endsWith('/go-back')).length, 1, 'sent once')
  await assert.rejects(stageFile(t, 'c1', doc(3)), /stage failed: 500/)
  assert.equal(reached.filter((r) => r.includes('/inbox/')).length, 1, 'sent once')
})

// ==================================================================== Workers AI capacity

const PASSAGES = [{ passageId: 'p1', documentName: 'Gateway.md', page: null, text: 'The billing gateway listens on port 8443.' }]
const CAPACITY = 'AiError: 3040: Capacity temporarily exceeded, please try again.'

/** Workers AI answers with `replies` in turn (an Error is thrown), each taking `ms` of the clock. */
function aiReplies(t: TestEngine, replies: (string | Error)[], ms = 0) {
  let n = 0
  t.ai.run = async (model: string, input: Record<string, unknown>) => {
    t.ai.calls.push({ model, input })
    t.advance(ms)
    const reply = replies[Math.min(n++, replies.length - 1)]
    if (reply instanceof Error) throw reply
    return { response: reply }
  }
}

test('ASK-01 an answer Workers AI has no capacity for (3040) is asked again, and written', async () => {
  const t = makeEngine()
  aiReplies(t, [new Error(CAPACITY), new Error(CAPACITY), 'The billing gateway listens on port 8443 [1].'], 7_000)
  const res = await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.citations, [1])
  assert.equal(t.ai.calls.length, 3)
})

test('an answer that stays without capacity is given up within its time budget: 503 model_unavailable', async () => {
  const t = makeEngine()
  const started = t.now()
  aiReplies(t, [new Error(CAPACITY)], 7_000)
  const res = await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })
  assert.deepEqual([res.status, res.body.error], [503, 'model_unavailable'])
  assert.ok(t.ai.calls.length >= 2 && t.ai.calls.length <= 4, `${t.ai.calls.length} calls`)
  assert.ok(t.now() - started <= SETTINGS.answerBudgetMs + 7_000, `${t.now() - started} ms`)
})

test('an answer the model refuses for another reason is not asked again', async () => {
  const t = makeEngine()
  aiReplies(t, [new Error('AiError: 5007: No such model.')])
  const res = await t.api('POST', '/v1/answer', { question: 'Which port?', passages: PASSAGES })
  assert.deepEqual([res.status, res.body.error], [503, 'model_unavailable'])
  assert.equal(t.ai.calls.length, 1)
})
