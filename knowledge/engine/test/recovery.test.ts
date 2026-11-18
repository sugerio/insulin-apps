// Recovering when a container or a snapshot lets the engine down: unusable snapshots during imports and removals,
// imports arriving mid-check, wakes whose control calls fail, start failures, hung jobs, repairs that must keep
// later files, and the running time all of that takes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS } from '../src/settings.ts'
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
  assert.deepEqual(grep['port is 8001'], { container: 0, text: 0, backups: 0, exports: 0 })
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
  // While people keep asking, it answers from version 2 and learns nothing: one container can't do both.
  for (let i = 0; i < 4; i++) {
    t.advance(5 * 60_000)
    const answer = await ask(t, 'c1', 'topic number 2 gateway port')
    assert.deepEqual([answer.body.status, answer.body.version], ['ok', 4], `after ${(i + 1) * 5} minutes`)
    await t.drain('c1')
  }
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 3)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.queuedImports, 1, 'the re-learning waits')
  // Once nobody has asked for the collection's awake minutes, everything is learned again.
  t.advance(11 * 60_000)
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

test('a backup taken after a wake still serves its snapshot, though the open databases changed /data', async () => {
  const t = makeEngine()
  t.cloud.openWrites = true
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  await ask(t, 'c1', 'topic number 1')
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep: the backup holds /data as it was after the wake
  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  assert.equal((await ask(t, 'c1', 'topic number 2 gateway port')).body.status, 'ok')
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(entries.includes('from-backup-done'), entries.join(', '))
  assert.ok(!entries.includes('from-backup-relearn'))
})

for (const format of ['same', 'changed'] as const) {
  test(`two removals for good after an engine change (${format} database format) both commit, without looping`, async () => {
    const t = await asleepWithBackup()
    await learn(t, 'c1', 'imp-2', [doc(3)])
    t.advance(11 * 60_000)
    await t.drain('c1')
    t.cloud.image = 'registry.example/engine@2'
    if (format === 'changed') t.cloud.dataFormat = 'fmt-2'
    const docs = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
    const first = await t.api('DELETE', `/v1/collections/c1/documents/${docs[0].documentId}`)
    const second = await t.api('DELETE', `/v1/collections/c1/documents/${docs[1].documentId}`)
    await settle(t)
    const status = (await t.api('GET', '/v1/collections/c1')).body
    assert.deepEqual([status.version, status.counts.documents], [second.body.version, 1])
    assert.ok(first.body.version < second.body.version)
    assert.ok(t.cloud.starts.length < 12, `bounded container starts (${t.cloud.starts.length})`)
    assert.ok(!(await log(t, 'c1')).some((e: any) => e.event === 'import-try-failed'))
  })
}

test('a removal that keeps failing backs off and is reported, instead of retrying every minute', async () => {
  const t = await asleepWithBackup()
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  t.cloud.hangJobs = [] // the remove job itself fails every time:
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  box.serve = async (request: Request) => {
    if (new URL(request.url).pathname === '/jobs' && request.method === 'POST') {
      const body = (await request.clone().json()) as { op: string }
      if (body.op === 'remove') return new Response('{"error":"broken"}', { status: 500 })
    }
    return serve(request)
  }
  for (let i = 0; i < 60; i++) {
    await t.drain('c1', { steps: 20 })
    t.advance(60_000)
  }
  const tries = (await log(t, 'c1')).filter((e: any) => e.event === 'import-try-failed').length
  assert.ok(tries <= 9, `tries in an hour: ${tries}`)
  assert.ok((await outboxEvents(t)).some((e) => e.type === 'import' && e.import.importId.startsWith('rm-') && e.import.state === 'failed'), 'the failure is reported')
})

test('a re-learning waiting for an import slot does not restart a container on every alarm', async () => {
  const t = await asleepWithBackup()
  t.cloud.image = 'registry.example/engine@2'
  t.cloud.dataFormat = 'fmt-2'
  t.cloud.jobPolls = 100000
  for (const cid of ['c2', 'c3']) {
    await createCollection(t, cid)
    await startImport(t, cid, `big-${cid}`, [doc(5)])
    await t.drain(cid, { steps: 3 })
  }
  const before = t.cloud.starts.filter((s) => s.collection.endsWith(':c1')).length
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 2' })
  for (let i = 0; i < 20; i++) {
    await t.drain('c1', { steps: 30, horizonMs: 30_000 })
    t.advance(30_000)
  }
  const starts = t.cloud.starts.filter((s) => s.collection.endsWith(':c1')).length - before
  assert.ok(starts <= 2, `c1 container starts in 10 minutes: ${starts}`)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.queuedImports, 1)
})

test("a removal's clean-up of old backups and facts files is retried when it fails", async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2, 'The vault code is 7781-secret.')])
  t.advance(11 * 60_000)
  await t.drain('c1')
  t.advance(24 * 60 * 60_000)
  await ask(t, 'c1', 'topic number 1')
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-2.md')
  await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  const list = t.backups.list.bind(t.backups)
  let failed = false
  t.backups.list = async (options: any) => {
    if (!failed && options?.prefix?.includes('/daily/')) {
      failed = true
      throw new Error('R2 unavailable')
    }
    return list(options)
  }
  for (let i = 0; i < 30; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  assert.ok(failed)
  const holding = t.backups.keys().filter((k) => (t.backups.text(k) ?? '').includes('7781-secret') || (k.includes('/daily/') && (t.backups.text(k) ?? '').includes(target.documentId)))
  assert.deepEqual(holding, [])
})

test('a wake that times out three times running stops asking, says so, and charges no more', async () => {
  const t = await asleepWithBackup()
  const box = t.container('c1') as any
  const serve = box.serve.bind(box)
  box.serve = async (request: Request) => (new URL(request.url).pathname === '/query/open' ? new Response('{"error":"boom"}', { status: 500 }) : serve(request))
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  for (let i = 0; i < 180; i++) {
    await t.drain('c1', { steps: 20 })
    t.advance(60_000)
  }
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(entries.filter((e: string) => e === 'wake-timed-out').length <= 3)
  assert.ok(entries.includes('wake-gave-up'))
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.state, 'asleep')
  assert.ok((await outboxEvents(t)).some((e) => e.type === 'state' && e.state === 'asleep'))
  const awake = (await outboxEvents(t)).filter((e) => e.type === 'usage').reduce((s, e) => s + e.seconds, 0)
  assert.ok(awake < 60 * 60, `seconds charged ${awake}`)
})

test("a rebuilding removal's time limit counts the documents it learns again", async () => {
  const t = makeEngine()
  await createCollection(t)
  const many = Array.from({ length: 300 }, (_, i) => ({ fileId: `m${i}`, name: `m${i}.md`, text: `Item ${i} is here.` }))
  await learn(t, 'c1', 'imp-1', many.slice(0, 150))
  await learn(t, 'c1', 'imp-2', many.slice(150))
  t.advance(11 * 60_000)
  await t.drain('c1')
  t.cloud.image = 'registry.example/engine@2'
  t.cloud.dataFormat = 'fmt-2'
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[0]
  await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  t.cloud.hangJobs = ['ingest']
  await t.drain('c1', { steps: 10 })
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'removal-rebuilds'))
  // Past an hour, inside three times the plan for the 299 documents it learns again.
  assert.ok(3 * (SETTINGS.containerStartSeconds + SETTINGS.importBaseSeconds + 299 * SETTINGS.perDocumentSeconds) > 63 * 60)
  t.advance(62 * 60_000)
  await t.drain('c1', { steps: 5 })
  assert.ok(!(await log(t, 'c1')).some((e: any) => e.event === 'import-try-failed'), 'not given up after an hour')
})

test('a repair that learns again under stricter rules blocks the restore points that hold the newly hidden text', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'The codename is Bluewater.'), doc(2)])
  t.advance(6 * 60_000)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(11 * 60_000)
  await t.drain('c1')
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  // While the repair answers from version 1, the rules get stricter: the re-learning hides the word.
  for (let i = 0; i < 40 && !(await log(t, 'c1')).some((entry: any) => entry.event === 'relearn-queued'); i++) await t.drain('c1', { steps: 1 })
  await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } } })
  await settle(t)
  assert.deepEqual(t.files.keys('text/').filter((k) => t.files.text(k)!.includes('Bluewater')), [])
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  const holding = points.filter((p: any) => p.version <= 3)
  assert.ok(holding.length > 0)
  for (const p of holding) assert.equal(p.restorable, false, `version ${p.version} (${p.reason})`)
  assert.ok(holding.some((p: any) => p.reason === 'newly_hidden'))
})

test('an import that loses its capacity slot stops, keeps nothing and waits for a new one', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.jobPolls = 6
  await startImport(t, 'c1', 'imp-1', [doc(1)])
  await t.drain('c1', { steps: 2 })
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'learning')
  const capacity = t.capacity.instance('capacity').state.storage
  await capacity.put('running', {}) // the slot was given away (its lease ran out)
  await t.drain('c1', { steps: 1 })
  const stopped = (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body
  assert.deepEqual([stopped.state, stopped.attempt], ['queued', 1])
  assert.equal(t.container('c1').running, false)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 0)
  t.cloud.jobPolls = 1
  t.advance(60_000)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-1')).body.state, 'committed')
})

test('a lease call that fails once (the capacity guard was unreachable) does not throw away the learning', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.jobPolls = 4
  await startImport(t, 'c1', 'imp-1', [doc(1)])
  await t.drain('c1', { steps: 2 })
  const get = t.capacity.get.bind(t.capacity)
  let failed = false
  t.capacity.get = (id: { name: string }) => {
    const stub = get(id)
    return {
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!failed && url.endsWith('/renew')) {
          failed = true
          throw new Error('unreachable')
        }
        return stub.fetch(input, init)
      },
    }
  }
  await t.drain('c1')
  assert.ok(failed)
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body
  assert.deepEqual([status.state, status.attempt], ['committed', 1])
  assert.ok(!(await log(t, 'c1')).some((e: any) => e.event === 'lease-lost'))
})

test('a backup whose stored file is damaged is not put back: the collection learns again instead', async () => {
  const t = await asleepWithBackup()
  const blob = t.backups.keys().find((k) => k.includes('/blobs/') && t.backups.text(k)!.startsWith('learned'))!
  await t.backups.put(blob, 'learned CORRUPTED')
  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  const answer = await ask(t, 'c1', 'topic number 2 gateway port')
  for (let i = 0; i < 3 && answer.body.status !== 'ok'; i++) await settle(t, 1)
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(entries.includes('backup-checksum-mismatch'))
  assert.ok(!entries.includes('from-backup-done'))
  assert.ok(![...t.container('c1').data.values()].some((v) => v.includes('CORRUPTED')), 'the damaged file never reached the collection')
  assert.equal((await ask(t, 'c1', 'topic number 2 gateway port')).body.status, 'ok')
})

test('an older backup is never put back under a newer restore point: the collection learns again', async () => {
  const t = await asleepWithBackup() // the backup holds version 1
  await learn(t, 'c1', 'imp-2', [doc(3)]) // version 2, never backed up
  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  await ask(t, 'c1', 'topic number 3 gateway port')
  await settle(t, 3)
  const entries = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(!entries.includes('from-backup-done'), 'the backup of version 1 was refused')
  const answer = await ask(t, 'c1', 'topic number 3 gateway port')
  assert.ok(answer.body.passages.some((p: any) => p.text.includes('8003')), 'version 2 is all there')
})

test('a snapshot is only taken when the container is quiet', async () => {
  const t = makeEngine()
  t.cloud.lingerPolls = 3 // a finished job's processes take a while to exit
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body
  assert.deepEqual([status.state, status.attempt], ['committed', 1])
})

test('facts whose passage a correction marked outdated are left out of What it knows', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  const old = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages.find((p: any) => p.text.includes('8001'))
  const before = (await t.api('GET', '/v1/collections/c1/facts')).body.facts
  assert.ok(before.some((f: any) => f.passageId === old.passageId), 'the passage has a fact')
  t.advance(6 * 60_000)
  await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n1', title: 'Port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  })
  await t.drain('c1')
  const after = (await t.api('GET', '/v1/collections/c1/facts')).body.facts
  assert.ok(!after.some((f: any) => f.passageId === old.passageId), "the outdated passage's fact is gone")
  assert.ok(after.some((f: any) => f.sentence.includes('9001')), "the note's fact is there")
})
