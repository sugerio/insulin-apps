// Review round 14: an import that waited before its try (for a container Cloudflare didn't have, or after a failed try)
// polls its job at the usual pace once it learns (F200), and a start Cloudflare had no container for charges no time
// (F201).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS } from '../src/settings.ts'
import { type TestEngine, ask, createCollection, doc, learn, makeEngine, outboxEvents, startImport } from './helpers.ts'

/** c1 with one import learned, asleep: the next import or question starts its snapshot's container. */
async function asleep(): Promise<TestEngine> {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  assert.equal(t.container('c1').running, false)
  t.advance(6 * 60_000)
  return t
}

const record = async (t: TestEngine, importId: string) => (await t.storage('c1').get<any>(`imp:${importId}`))!

/** Runs c1 one alarm at a time until the import's job runs. */
async function untilLearning(t: TestEngine, importId: string) {
  for (let i = 0; i < 40 && (await record(t, importId)).phase !== 'running'; i++) await t.drain('c1', { steps: 1 })
  assert.equal((await record(t, importId)).phase, 'running')
}

/** The job is polled every SETTINGS.pollMs: a few polls move the clock on by as many polls, never stay at one moment. */
async function pollsAtItsPace(t: TestEngine, importId: string) {
  assert.equal((await record(t, importId)).retryAt, null, 'the wait is over once the try starts')
  assert.ok(t.storage('c1').alarm! >= t.now() + SETTINGS.pollMs, `the next poll is due in ${t.storage('c1').alarm! - t.now()} ms`)
  const before = t.now()
  await t.drain('c1', { steps: 6 })
  assert.ok(t.now() - before >= 5 * SETTINGS.pollMs, `six steps took ${t.now() - before} ms of the clock`)
  t.cloud.jobPolls = 1
  await t.drain('c1')
  assert.equal((await t.api('GET', `/v1/collections/c1/imports/${importId}`)).body.state, 'committed')
}

test('F200 an import that waited for a container polls its job every few seconds once it learns, not again and again at once', async () => {
  const t = await asleep()
  t.cloud.noContainer = 1
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.waitingFor, 'service')
  t.advance(SETTINGS.noContainerRetryMs)
  t.cloud.jobPolls = 50
  await untilLearning(t, 'imp-2')
  await pollsAtItsPace(t, 'imp-2')
})

test('F200 an import tried again after a failed try polls its job every few seconds too', async () => {
  const t = await asleep()
  t.cloud.jobPolls = 2
  t.cloud.drops.push({ method: 'GET', path: /^\/jobs\/ingest-/, times: 6 }) // the first try's poll drops past the bound
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await untilLearning(t, 'imp-2')
  await t.drain('c1', { steps: 3 })
  assert.equal((await record(t, 'imp-2')).status.state, 'interrupted')
  t.advance(60_000)
  t.cloud.jobPolls = 50
  await untilLearning(t, 'imp-2')
  assert.equal((await record(t, 'imp-2')).status.attempt, 2)
  await pollsAtItsPace(t, 'imp-2')
})

/** Seconds of each kind the collection was charged: the outbox's usage events and what the ledger holds yet. */
async function charged(t: TestEngine) {
  const out: Record<string, number> = {}
  for (const e of await outboxEvents(t)) if (e.type === 'usage' && e.collectionId === 'c1') out[e.kind] = (out[e.kind] ?? 0) + e.seconds
  const ledger = await t.storage('c1').get<any>('ledger')
  for (const [kind, ms] of Object.entries<number>(ledger?.totals ?? {})) out[kind] = (out[kind] ?? 0) + ms / 1000
  if (ledger?.kind && ledger.since !== null) out[ledger.kind] = (out[ledger.kind] ?? 0) + (t.now() - ledger.since) / 1000
  return out
}

/** Cloudflare takes `ms` to say it has no container for c1's next start. */
function slowRefusal(t: TestEngine, ms: number) {
  t.cloud.noContainer = 1
  const box = t.container('c1') as any
  const start = box.start.bind(box)
  box.start = (options: unknown) => {
    t.advance(ms)
    return start(options)
  }
}

test('F201 a start Cloudflare had no container for charges no learning time, however long the refusal took', async () => {
  const t = await asleep()
  const before = await charged(t)
  slowRefusal(t, 5_000)
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await t.drain('c1')
  assert.equal(t.cloud.refused.length, 1)
  assert.equal(t.cloud.starts.length, 1, 'only the first import\'s container ever started')
  const after = await charged(t)
  assert.equal(after.learning ?? 0, before.learning ?? 0, `learning seconds: ${before.learning} before, ${after.learning} after`)
})

test('F201 the time a container ran before the refused start stays charged', async () => {
  const t = await asleep()
  // Questions on a smaller instance: an import needs a container of its own, which replaces this one.
  ;(t.env as any).ENGINE_QUESTIONS_INSTANCE = 'standard-1'
  assert.equal((await ask(t, 'c1', 'topic number 1 gateway port')).body.status, 'ok')
  const awake = await charged(t)
  t.advance(2 * 60_000) // awake for questions two more minutes
  slowRefusal(t, 5_000)
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await t.drain('c1', { steps: 3 })
  assert.equal(t.cloud.refused.length, 1)
  const after = await charged(t)
  assert.ok((after.awake ?? 0) - (awake.awake ?? 0) >= 120, `awake seconds: ${awake.awake} before, ${after.awake} after`)
  assert.equal(after.learning ?? 0, awake.learning ?? 0, 'none for the refused start')
})
