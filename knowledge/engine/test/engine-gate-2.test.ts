// Fixes from the engine's first run on Cloudflare (the Engine-lane GATE plans, 2026-11-17), the second part:
// - a start Cloudflare has no container for (its account limits, or too many starts at once) waits and asks again:
//   it costs no import a try, gives no snapshot up and drops no operation, and the app hears the import waits for the
//   service;
// - an import's documents are learned in groups and planned so; a later try, which learns them one at a time, is
//   planned at its own rate;
// - an answer or a text cut short on the way (a stream can end early without an error, as the run's two backup files
//   did) is read again, never taken as it came; a backup file that changed after its manifest fails at once.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS } from '../src/settings.ts'
import { type TestEngine, ORG, ask, createCollection, doc, guard, learn, log, makeEngine, startImport } from './helpers.ts'

const C1 = `${ORG}:c1`

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

const logged = async (t: TestEngine, event: string, cid = 'c1') => (await log(t, cid)).filter((e: any) => e.event === event)
const importOf = async (t: TestEngine, importId: string, cid = 'c1') => (await t.api('GET', `/v1/collections/${cid}/imports/${importId}`)).body
const dropsLeft = (t: TestEngine) => t.cloud.drops.reduce((n, rule) => n + rule.times, 0)

// ==================================================================== no container to give

test('ASK-06 a wake Cloudflare has no container for waits and asks again; the snapshot is never given up', async () => {
  const t = await asleep()
  t.cloud.noContainer = 4 // more than the three failed starts after which a snapshot counts as gone
  const first = await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 1 gateway port' })
  assert.equal(first.body.status, 'waking')
  await t.drain('c1')
  assert.equal(t.cloud.refused.length, 1, 'one start asked for, then it waits')
  const waits = await logged(t, 'no-container')
  assert.equal(waits.length, 1)
  assert.equal(waits[0].purpose, 'questions')
  assert.match(waits[0].error, /no Container instance/)
  assert.ok(t.storage('c1').alarm! >= t.now() + SETTINGS.noContainerRetryMs - 6_000, 'the alarm comes back when the wait is over, not every second')
  for (let i = 0; i < 4; i++) {
    t.advance(SETTINGS.noContainerRetryMs)
    await t.drain('c1')
  }
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  assert.equal(t.cloud.refused.length, 4)
  assert.deepEqual(await logged(t, 'start-failed'), [], 'no failed start: nothing is wrong with the snapshot')
  assert.deepEqual(await logged(t, 'snapshot-unusable'), [])
  assert.equal(t.cloud.starts.at(-1)!.snapshot, (await t.storage('c1').get<any>(`rp:${'1'.padStart(10, '0')}`)).snapshotId, 'woke from its own snapshot')
})

test('IMP-10 an import Cloudflare has no container for waits in the queue for the service, its try not counted, and is learned on its first try', async () => {
  const t = await asleep()
  t.cloud.noContainer = 1
  assert.equal((await startImport(t, 'c1', 'imp-2', [doc(3), doc(4)])).status, 202)
  await t.drain('c1')
  const waiting = await importOf(t, 'imp-2')
  assert.deepEqual([waiting.state, waiting.waitingFor, waiting.attempt], ['queued', 'service', 1], 'the app shows "Insulin Knowledge is busy"')
  assert.deepEqual((await guard(t)).running, [], 'its slot is given back while it waits')
  assert.deepEqual(await logged(t, 'import-try-failed'), [])
  t.advance(SETTINGS.noContainerRetryMs)
  await t.drain('c1')
  const done = await importOf(t, 'imp-2')
  assert.deepEqual([done.state, done.attempt, done.waitingFor], ['committed', 1, null])
  assert.deepEqual(await logged(t, 'import-try-failed'), [])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 4)
  assert.equal(t.cloud.refused.length, 1)
})

test('HIS-01 a go back Cloudflare has no container for waits and goes back; it is never dropped as a failure', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-2', [doc(2)])
  t.cloud.noContainer = 3 // as many as the failures after which an operation is given up
  assert.equal((await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')).status, 200)
  for (let i = 0; i < 4; i++) {
    await t.drain('c1')
    t.advance(SETTINGS.noContainerRetryMs)
  }
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [3, 1], 'went back to version 1')
  assert.equal(t.cloud.refused.length, 3)
  assert.deepEqual(await logged(t, 'operation-failed'), [])
  assert.equal((await logged(t, 'operation-waits')).length, 3)
})

// ==================================================================== learning in groups

test('IMP-07 an import is planned at the grouped rate per document; a later try, which learns one at a time, at its own', async () => {
  const t = makeEngine()
  await createCollection(t)
  const files = Array.from({ length: 10 }, (_, i) => doc(i + 1))
  await startImport(t, 'c1', 'imp-1', files)
  const text = files.reduce((sum, f) => sum + new TextEncoder().encode(f.text).length, 0) / (1024 * 1024)
  const plan = (perDocument: number) => SETTINGS.containerStartSeconds + SETTINGS.importBaseSeconds + 10 * perDocument + text * SETTINGS.perTextMiBSeconds
  assert.ok(Math.abs((await importOf(t, 'imp-1')).etaSeconds - plan(SETTINGS.perDocumentSeconds)) <= 1)
  assert.ok(SETTINGS.perDocumentOneByOneSeconds > SETTINGS.perDocumentSeconds)
  // The container is told which try it is: container/ops.py learns one at a time from the second on.
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  const tries: number[] = []
  box.serve = async (request: Request) => {
    if (request.method === 'PUT' && new URL(request.url).pathname === '/inbox/imp-1/batch.json') tries.push(((await request.clone().json()) as { attempt: number }).attempt)
    return serve(request)
  }
  // The first try's container stops while it learns: the next try learns one at a time, and is planned so.
  t.cloud.jobPolls = 5
  await t.drain('c1', { steps: 3 })
  await t.container('c1').destroy()
  await t.drain('c1', { steps: 2 })
  const retried = await importOf(t, 'imp-1')
  assert.deepEqual([retried.state, retried.attempt], ['interrupted', 2])
  assert.ok(Math.abs(retried.etaSeconds - plan(SETTINGS.perDocumentOneByOneSeconds)) <= 1, `${retried.etaSeconds} s`)
  t.advance(20_000)
  await t.drain('c1')
  assert.deepEqual([(await importOf(t, 'imp-1')).state, (await logged(t, 'job-done')).at(-1).attempt], ['committed', 2])
  assert.deepEqual(tries, [1, 2])
})

// ==================================================================== answers cut short

test('IMP-03 a job status cut short on the way is asked for again, never read as a finished job', async () => {
  const t = await asleep()
  t.cloud.jobPolls = 3
  t.cloud.drops.push({ method: 'GET', path: /^\/jobs\/ingest-/, times: 1, cut: true })
  const done = await learn(t, 'c1', 'imp-2', [doc(3), doc(4)])
  assert.equal(dropsLeft(t), 0)
  assert.deepEqual([done.state, done.attempt], ['committed', 1])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 4, 'both documents learned, not an empty commit')
  const dropped = await logged(t, 'container-call-dropped')
  assert.equal(dropped.length, 1)
  assert.match(dropped[0].error, /ended after \d+ of \d+ bytes/)
})

test('IMP-03 a learned text cut short on the way is read again: R2 never keeps half a text', async () => {
  const t = await asleep()
  t.cloud.drops.push({ method: 'GET', path: /^\/text\//, times: 1, cut: true })
  const done = await learn(t, 'c1', 'imp-2', [doc(3)])
  assert.equal(dropsLeft(t), 0)
  assert.equal(done.state, 'committed')
  const documentId = done.files[0].documentId
  const key = [...t.files.objects.keys()].find((k) => k.startsWith('text/') && k.includes(documentId))!
  const saved = new TextDecoder().decode(t.files.objects.get(key)!.body)
  assert.equal(JSON.parse(saved).text, doc(3).text, 'the whole text')
})

test('HIS-02 a backup file that changed after its manifest fails the backup at once, without sending it six times', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  await ask(t, 'c1', 'topic number 1 gateway port')
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  let changed = ''
  box.serve = async (request: Request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path.startsWith('/files/') && !changed) {
      // A database written to after the manifest was taken (the run's question: was that the refusals' cause?).
      changed = decodeURIComponent(path.slice('/files/'.length))
      box.data.set(changed, `${box.data.get(changed)} and more`)
    }
    return serve(request)
  }
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep: the backup at sleep fails
  const failed = await logged(t, 'backup-failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].error, /changed after its checksum was taken/)
  assert.equal(t.cloud.calls.filter((c) => c.collection === C1 && c.path === `/files/${changed}`).length, 1, 'read once, not sent again')
  assert.deepEqual(await logged(t, 'container-call-dropped'), [])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.lastBackupAt, null)
})
