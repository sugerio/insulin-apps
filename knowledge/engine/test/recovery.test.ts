// Recovering when a container or a snapshot lets the engine down: unusable snapshots during imports and removals,
// imports arriving mid-check, wakes whose control calls fail, start failures, hung jobs, repairs that must keep
// later files, and the running time all of that takes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type TestEngine, ask, createCollection, doc, learn, log, makeEngine, outboxEvents, startImport } from './helpers.ts'

const SIX_MINUTES = 6 * 60_000

async function asleepWithBackup(): Promise<TestEngine> {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep, with the day's backup
  assert.ok((await t.api('GET', '/v1/collections/c1')).body.lastBackupAt)
  t.advance(SIX_MINUTES)
  return t
}

async function settle(t: TestEngine, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await t.drain('c1', { steps: 50 })
    t.advance(60_000)
  }
}

test('an import after an engine change with a new database format learns everything again first, then itself', async () => {
  const t = await asleepWithBackup()
  t.cloud.image = 'registry.example/engine@3'
  t.cloud.dataFormat = 'fmt-2'
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await settle(t)
  const imported = (await t.api('GET', '/v1/collections/c1/imports/imp-2')).body
  assert.equal(imported.state, 'committed')
  assert.equal(imported.attempt, 1, 'waiting for the re-learning is not a try')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.counts.documents, 3)
  assert.ok(t.cloud.starts.length < 10, `bounded container starts (${t.cloud.starts.length})`)
  const summaries = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.map((p: any) => p.summary)
  assert.ok(summaries.includes('Learned everything again from its saved text'), summaries.join(' | '))
})

test('remove for good after an engine change comes back from the backup and commits as the version it promised', async () => {
  const t = await asleepWithBackup()
  t.cloud.image = 'registry.example/engine@2'
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  assert.equal(removed.body.version, 2)
  await settle(t)
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [2, 1])
  assert.ok(t.cloud.starts.length < 10, `bounded container starts (${t.cloud.starts.length})`)
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'checksum-ok' && e.backup), 'the backup was checked before use')
  const answer = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.equal(answer.body.status, 'ok')
})

test('remove for good after a database format change learns the other files again, without the removed one', async () => {
  const t = await asleepWithBackup()
  t.cloud.image = 'registry.example/engine@3'
  t.cloud.dataFormat = 'fmt-2'
  const docs = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  const target = docs.find((d: any) => d.name === 'doc-1.md')
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  await settle(t)
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [removed.body.version, 1])
  assert.ok(t.cloud.starts.length < 10, `bounded container starts (${t.cloud.starts.length})`)
  const grep = (await t.api('POST', '/v1/collections/c1/__test/grep', { values: ['port is 8001'] })).body
  assert.deepEqual(grep['port is 8001'], { container: 0, text: 0, backups: 0 })
})

test('an import arriving while a wake is still checking never learns on the unchecked container', async () => {
  const t = await asleepWithBackup()
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  await t.drain('c1', { steps: 1 })
  assert.equal((await t.storage('c1').get<any>('runtime'))?.phase, 'checking')
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await settle(t)
  const entries = await log(t, 'c1')
  const firstJob = entries.findIndex((e: any) => e.event === 'job-started' && e.importId === 'imp-2')
  const relearned = entries.findIndex((e: any) => e.event === 'committed' && e.kind === 'from_backup')
  assert.ok(firstJob > relearned && relearned >= 0, 'imp-2 learned only after the collection was rebuilt from its text')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-2')).body.state, 'committed')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 3)
})

test('a wake recovers when one control call fails, instead of staying "waking" and charging awake time', async () => {
  const t = await asleepWithBackup()
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  let failed = false
  box.serve = async (request: Request) => {
    if (!failed && new URL(request.url).pathname === '/query/start') {
      failed = true
      return new Response('{"error":"boom"}', { status: 503 })
    }
    return serve(request)
  }
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  assert.ok(failed)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'ready')
})

test('a wake that never finishes is stopped and started again', async () => {
  const t = await asleepWithBackup()
  t.cloud.queryPolls = 1_000_000 // the query process never finishes loading
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  await t.drain('c1', { steps: 20 })
  const startsBefore = t.cloud.starts.length
  t.cloud.queryPolls = 1
  t.advance(15 * 60_000)
  await t.drain('c1', { steps: 50 })
  assert.ok(t.cloud.starts.length > startsBefore, 'started again')
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'wake-timed-out'))
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'ready')
})

test('a start that fails once does not retire a good snapshot', async () => {
  const t = await asleepWithBackup()
  t.cloud.failStarts = 1
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(entries.includes('start-failed'))
  assert.ok(!entries.includes('from-backup-done') && !entries.includes('from-backup-relearn'), 'the snapshot is still used')
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.equal(points.find((p: any) => p.version === 1).restorable, true)
})

test('a snapshot that fails to start three times running is treated as gone: the collection comes back from its backup', async () => {
  const t = await asleepWithBackup()
  t.cloud.failStarts = 3
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  for (let i = 0; i < 3 && answer.body.status !== 'ok'; i++) await settle(t, 1)
  const final = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(final.body.status, 'ok')
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'from-backup-done'))
})

test('a job that never finishes is given up after its time, and tried again', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.hangJobs = ['ingest']
  await startImport(t, 'c1', 'imp-hang', [doc(1)])
  await t.drain('c1', { steps: 5 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-hang')).body.state, 'learning')
  t.advance(2 * 60 * 60_000)
  await t.drain('c1', { steps: 5 })
  const tried = (await t.api('GET', '/v1/collections/c1/imports/imp-hang')).body
  assert.deepEqual([tried.state, tried.attempt], ['interrupted', 2])
  t.cloud.hangJobs = []
  t.advance(60_000)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-hang')).body.state, 'committed')
})

test('HIS-04 a repair answers from the previous restore point, then brings back the files added after it', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(SIX_MINUTES)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(SIX_MINUTES)
  await learn(t, 'c1', 'imp-3', [doc(4)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  let answeredFromTwo = false
  for (let i = 0; i < 40; i++) {
    await t.drain('c1', { steps: 1 })
    const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
    if (points[0]?.summary === 'Answering from version 2 after version 3 failed its check') answeredFromTwo = true
  }
  assert.ok(answeredFromTwo, 'it answered from version 2 meanwhile')
  await settle(t)
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.counts.documents, 4, 'the file added in version 3 is back')
  const answer = await ask(t, 'c1', 'topic number 4 gateway port')
  assert.ok(answer.body.passages.some((p: any) => p.text.includes('8004')))
})

test('a backup of the same files serves a later version without new data (stop using), instead of learning everything again', async () => {
  const t = await asleepWithBackup()
  t.cloud.image = 'registry.example/engine@2'
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  await t.api('PATCH', `/v1/collections/c1/documents/${target.documentId}`, { active: false })
  await ask(t, 'c1', 'topic number 2')
  await settle(t, 3)
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(entries.includes('from-backup-done'))
  assert.ok(!entries.includes('from-backup-relearn'))
})

test('waking and going back are charged from the moment the container starts', async () => {
  const t = await asleepWithBackup()
  await learn(t, 'c1', 'imp-2', [doc(3)])
  await t.api('POST', '/v1/collections/c1/__test/sleep')
  await t.drain('c1', { horizonMs: 60_000 })
  t.cloud.onStart = () => t.advance(30_000) // a start takes half a minute
  const before = (await outboxEvents(t)).filter((e) => e.type === 'usage').reduce((s, e) => s + e.seconds, 0)
  const startedAt = t.now()
  await ask(t, 'c1', 'topic number 1') // a wake: one start
  await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  await t.drain('c1') // going back: another start
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 2)
  await t.api('POST', '/v1/collections/c1/__test/sleep')
  await t.drain('c1', { horizonMs: 60_000 })
  const elapsed = (t.now() - startedAt) / 1000
  assert.ok(elapsed >= 60, `two starts took ${elapsed} s`)
  const charged = (await outboxEvents(t)).filter((e) => e.type === 'usage').reduce((s, e) => s + e.seconds, 0) - before
  assert.ok(charged >= elapsed - 2, `charged ${charged} s of ${elapsed} s`)
})

test('a failure to tidy up after a commit leaves the import committed and is retried', async () => {
  const t = makeEngine()
  await createCollection(t)
  const remove = t.files.delete.bind(t.files)
  let failures = 0
  t.files.delete = async (keys: string | string[]) => {
    if (failures < 1 && [keys].flat().some((k) => k.startsWith('inbox/'))) {
      failures += 1
      throw new Error('R2 is not answering')
    }
    return remove(keys)
  }
  await startImport(t, 'c1', 'imp-1', [doc(1)])
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body
  assert.deepEqual([status.state, status.version], ['committed', 1])
  assert.equal(failures, 1)
  await t.api('POST', '/v1/collections/c1/search', { query: 'x' })
  await t.drain('c1', { horizonMs: 60_000 })
  assert.deepEqual(t.files.keys('inbox/'), [], 'the originals were deleted on a later try')
})
