// Review round 13: a repair's re-learning that waits while people ask holds no capacity meanwhile (F194), and a
// re-read is planned by the documents it reads, not those of when it was queued (F195).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type FileSpec, type TestEngine, ask, createCollection, doc, guard, learn, log, makeEngine, startImport, wrapGuard } from './helpers.ts'

const MiB = 1024 * 1024

/** A text of about `bytes`, in paragraphs of about 2 KB. */
function bigText(bytes: number, word: string): string {
  const paragraph = `${`The ${word} schedule lists every crossing and its crew. `.repeat(36)}\n\n`
  return paragraph.repeat(Math.ceil(bytes / paragraph.length)).slice(0, bytes)
}

const importOf = async (t: TestEngine, importId: string, cid = 'c1') => (await t.api('GET', `/v1/collections/${cid}/imports/${importId}`)).body
const relearning = async (t: TestEngine) => {
  const meta = await t.storage('c1').get<any>('meta')
  return (await t.storage('c1').get<any>(`imp:${meta.queue[0]}`)) ?? null
}

/** c1 answers from version 2 after version 3 failed its check twice; its re-learning waits while people ask. */
async function repairing(t: TestEngine) {
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-3', [doc(4)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await ask(t, 'c1', 'topic number 2 gateway port')
  for (let i = 0; i < 10 && (await t.api('GET', '/v1/collections/c1')).body.state !== 'ready'; i++) await t.drain('c1')
  const answer = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.deepEqual([answer.body.status, answer.body.version], ['ok', 4], 'it answers from version 2')
  const record = await relearning(t)
  assert.deepEqual([record?.kind, record?.capacity], ['relearn', 'none'], 'the re-learning waits, asking for nothing')
}

/** c1 repairing; c2 and c3 hold the organization's two slots with jobs that run on; c1's re-learning waits in the guard's list. */
async function relearningWaitsForASlot(): Promise<TestEngine> {
  const t = makeEngine()
  await repairing(t)
  for (const cid of ['c2', 'c3']) await createCollection(t, cid)
  t.cloud.hangJobs = ['ingest']
  await startImport(t, 'c2', 'imp-c2', [doc(5)])
  await startImport(t, 'c3', 'imp-c3', [doc(6)])
  for (const cid of ['c2', 'c3']) await t.drain(cid, { steps: 3 })
  assert.equal((await guard(t)).running.length, 2)
  // Nobody asks c1 for its awake minutes: its re-learning asks the guard for a slot, and waits in its list.
  t.advance(11 * 60_000)
  await t.drain('c1', { steps: 3 })
  const record = await relearning(t)
  assert.deepEqual([record.capacity, record.status.waitingFor], ['waiting', 'organization'])
  assert.ok((await guard(t)).waiting.includes(record.status.importId))
  return t
}

test('F194 a re-learning that waits for questions again leaves the guard: the slot freed goes to another import', async () => {
  const t = await relearningWaitsForASlot()
  const relearnId = (await relearning(t)).status.importId
  await createCollection(t, 'c4')
  await startImport(t, 'c4', 'imp-c4', [doc(7)])
  await t.drain('c4', { steps: 2 })
  assert.equal((await importOf(t, 'imp-c4', 'c4')).waitingFor, 'organization')
  // Someone asks c1 again: it answers from version 2, and its re-learning waits again.
  const answer = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.equal(answer.body.status, 'ok')
  await t.drain('c1', { steps: 3 })
  const waiting = await relearning(t)
  assert.deepEqual([waiting.capacity, waiting.status.waitingFor], ['none', null], 'it asks for nothing while it waits')
  assert.ok(!(await guard(t)).waiting.includes(relearnId), 'nor waits in the guard\'s list')
  // c2's import ends: its slot goes to c4's import, not to the re-learning that can't use it.
  t.cloud.hangJobs = []
  await t.drain('c2')
  t.cloud.hangJobs = ['ingest']
  const running = (await guard(t)).running
  assert.ok(!running.some((key) => key.endsWith(`:c1:${relearnId}`)), running.join())
  assert.ok(running.some((key) => key.endsWith(':c4:imp-c4')), running.join())
  await t.drain('c4', { steps: 3 })
  assert.ok(['reading', 'learning'].includes((await importOf(t, 'imp-c4', 'c4')).state))
  // Once nobody asks c1, its re-learning asks for a slot again and learns everything (the file of version 3 too).
  t.cloud.hangJobs = []
  t.advance(11 * 60_000)
  for (let i = 0; i < 10; i++) {
    await t.drain(undefined, { steps: 100 })
    t.advance(60_000)
  }
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [5, 4])
})

test('F194 a release the guard didn\'t confirm while the re-learning waits for questions is told again from the alarm', async () => {
  const t = await relearningWaitsForASlot()
  const relearnId = (await relearning(t)).status.importId
  let refused = 0
  const restore = wrapGuard(t, async (path, call) => {
    if (path === '/release' && refused < 1) {
      refused += 1
      throw new Error('the guard is unreachable for a moment')
    }
    return call()
  })
  await ask(t, 'c1', 'topic number 2 gateway port')
  await t.drain('c1', { steps: 3 })
  assert.equal(refused, 1, 'the first release was lost')
  restore()
  // The next alarms tell the guard again, though the re-learning is the next import of c1's queue.
  t.advance(60_000)
  await ask(t, 'c1', 'topic number 2 gateway port')
  await t.drain('c1', { steps: 5 })
  assert.ok(!(await guard(t)).waiting.includes(relearnId), 'the guard let it go')
  assert.equal(await t.storage('c1').get('capacityReturns'), undefined, 'nothing owed any more')
})

test('F195 a re-read queued while an import learns plans for the documents it reads, so a long one isn\'t given up at an hour', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(6 * 60_000)
  // Three texts of 2 MB are learning when the rules get stricter: the re-read is queued then.
  const large = (n: number, word: string): FileSpec => ({ fileId: `l${n}`, name: `large-${n}.txt`, type: 'text/plain', text: bigText(2 * MiB, word) })
  t.cloud.jobPolls = 3
  await startImport(t, 'c1', 'imp-2', [large(1, 'ferry'), large(2, 'tugboat'), large(3, 'barge')])
  await t.drain('c1', { steps: 2 })
  assert.equal((await importOf(t, 'imp-2')).state, 'learning')
  const stricter = await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['crew'] } } })
  assert.equal(stricter.status, 200)
  const meta = await t.storage('c1').get<any>('meta')
  const rereadId = meta.queue.find((id: string) => id.startsWith('reread'))
  assert.ok(rereadId)
  // The import commits, then the re-read reads all four documents (about 6 MB): its job runs over an hour.
  t.cloud.jobPolls = 1
  t.cloud.hangJobs = ['reread']
  await t.drain('c1', { steps: 20 })
  const started = await importOf(t, rereadId)
  assert.equal(started.state, 'reading')
  assert.ok(started.etaSeconds > 60 * 60, `${started.etaSeconds} s planned for four documents of about 6 MB`)
  for (let minute = 1; minute <= 75; minute++) {
    t.advance(60_000)
    await t.drain('c1', { steps: 5 })
  }
  const entries = (await log(t, 'c1')).filter((e: any) => e.event === 'import-try-failed')
  assert.deepEqual(entries, [], 'not given up after 75 minutes')
  t.cloud.hangJobs = []
  await t.drain('c1', { steps: 50 })
  assert.equal((await importOf(t, rereadId)).state, 'committed')
})
