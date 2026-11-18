// Fixes from the engine's first run on Cloudflare (the Engine-lane GATE plans, 2026-11-17):
// - a call from the Durable Object to its container that drops while the container still runs ("Network connection
//   lost.", 27 of 71 tries there) is sent again, so a drop costs no try; a run of drops past the bound still does;
// - an import is planned by the size of its text as well as its documents (a 2 MB text took 30 minutes, planned 48 s);
// - the alarm never waits on the container's monitor;
// - a repair answers from an earlier restore point while people ask, and a backup it came back from serves again.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { SETTINGS } from '../src/settings.ts'
import { type FileSpec, type TestEngine, ORG, ask, createCollection, doc, guard, learn, log, makeEngine, startImport } from './helpers.ts'

const C1 = `${ORG}:c1`
const MiB = 1024 * 1024

/** c1 with one import learned, asleep: the next import or question starts its snapshot's container and checks it. */
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
const ingestStarts = (t: TestEngine) => t.cloud.calls.filter((c) => c.collection === C1 && c.detail === 'ingest').length
const dropsLeft = (t: TestEngine) => t.cloud.drops.reduce((n, rule) => n + rule.times, 0)
const importOf = async (t: TestEngine, importId: string, cid = 'c1') => (await t.api('GET', `/v1/collections/${cid}/imports/${importId}`)).body

/** A text of about `bytes`, in paragraphs of about 2 KB. */
function bigText(bytes: number, word = 'harbour'): string {
  const paragraph = `${`The ${word} schedule lists every crossing and its crew. `.repeat(36)}\n\n`
  return paragraph.repeat(Math.ceil(bytes / paragraph.length)).slice(0, bytes)
}

// ==================================================================== calls that drop

test('IMP-03 a drop right after a learning container starts (inbox writes, the check) is sent again: no try is lost', async () => {
  const t = await asleep()
  t.cloud.drops.push(
    { method: 'PUT', path: /^\/inbox\//, times: 1 }, // never reached the server
    { method: 'PUT', path: /^\/inbox\//, times: 1, after: true }, // stored, its answer lost
    { method: 'POST', path: '/jobs', op: 'manifest', times: 1, after: true },
  )
  const done = await learn(t, 'c1', 'imp-2', [doc(3), doc(4)])
  assert.deepEqual([done.state, done.attempt], ['committed', 1])
  assert.equal(dropsLeft(t), 0, 'every drop happened')
  assert.deepEqual(await logged(t, 'import-try-failed'), [])
  assert.equal((await logged(t, 'container-call-dropped')).length, 3)
  assert.equal(t.cloud.starts.length, 2, 'one container for the import, never discarded')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 4)
})

test('FIX-01 a correction whose calls drop before its job, as the job starts and as it ends is kept on its first try', async () => {
  const t = await asleep()
  const old = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages[0]
  const before = ingestStarts(t)
  t.cloud.jobPolls = 3
  t.cloud.drops.push(
    { method: 'PUT', path: /\/batch\.json$/, times: 1 },
    { method: 'POST', path: '/jobs', op: 'ingest', times: 1, after: true }, // the job started; its answer was lost
    { method: 'GET', path: /^\/jobs\/ingest-/, times: 2 },
    { method: 'DELETE', path: /^\/inbox\//, times: 2 },
    { method: 'POST', path: '/cleanup', times: 1, after: true },
    { method: 'GET', path: '/quiesce', times: 1 },
    { method: 'POST', path: '/jobs', op: 'stats', times: 1, after: true },
    { method: 'GET', path: /^\/text\//, times: 2 },
    { method: 'GET', path: '/files/facts.json', times: 1, after: true },
  )
  const sent = await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n-fix', title: 'Port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  })
  assert.equal(sent.status, 202)
  await t.drain('c1')
  const done = await importOf(t, 'fix-1')
  assert.deepEqual([done.state, done.attempt], ['committed', 1])
  assert.equal(dropsLeft(t), 0, 'every drop happened')
  assert.equal(ingestStarts(t) - before, 1, 'the job sent again was the same job, never a second one')
  assert.deepEqual(await logged(t, 'import-try-failed'), [])
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.ok(answer.body.passages[0].text.includes('9001'), 'the correction answers')
  assert.ok((await t.api('GET', '/v1/collections/c1/facts')).body.facts.length > 0, 'the facts were read again after the drop')
})

test('a run of drops past the bound still ends the try (after five more sends), and the next try commits', async () => {
  const t = await asleep()
  t.cloud.jobPolls = 2
  t.cloud.drops.push({ method: 'GET', path: /^\/jobs\/ingest-/, times: 6 })
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await t.drain('c1', { horizonMs: 60_000 })
  const done = await importOf(t, 'imp-2')
  assert.deepEqual([done.state, done.attempt], ['committed', 2])
  const failed = await logged(t, 'import-try-failed')
  assert.deepEqual(failed.map((e: any) => [e.attempt, e.reason]), [[1, 'Network connection lost.']])
  assert.deepEqual((await logged(t, 'container-call-dropped')).map((e: any) => e.drops), [1, 2, 3, 4, 5])
})

test('a container that stops is not asked again: the try ends at once', async () => {
  const t = await asleep()
  t.cloud.jobPolls = 2
  t.cloud.drops.push({ method: 'GET', path: /^\/jobs\/ingest-/, times: 1, stop: true })
  await startImport(t, 'c1', 'imp-2', [doc(3)])
  await t.drain('c1', { horizonMs: 60_000 })
  assert.deepEqual([(await importOf(t, 'imp-2')).state, (await importOf(t, 'imp-2')).attempt], ['committed', 2])
  assert.deepEqual(await logged(t, 'container-call-dropped'), [], 'nothing sent again to a container that is gone')
})

test('DEL-03 an import from an export rides over drops on its first inbox writes', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2), doc(3)])
  await t.api('POST', '/v1/collections/c1/exports', { exportId: 'exp-1' })
  await t.drain('c1')
  const zip = new Uint8Array(await (await t.api('GET', '/v1/collections/c1/exports/exp-1?download=1')).response.arrayBuffer())
  const sha256 = createHash('sha256').update(zip).digest('hex')
  await createCollection(t, 'c2')
  const staged = await t.api('PUT', '/v1/collections/c2/inbox/export-zip', zip, {
    headers: { 'content-type': 'application/zip', 'x-file-name': 'knowledge-export.zip', 'x-file-sha256': sha256 },
  })
  assert.equal(staged.status, 200)
  // On Cloudflare the first inbox write dropped 0.4 s after the fresh container started, on every try.
  t.cloud.drops.push({ method: 'PUT', path: /^\/inbox\/from-export\//, times: 3 })
  await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-export', fileId: 'export-zip', sha256 })
  await t.drain('c2')
  const done = await importOf(t, 'from-export', 'c2')
  assert.deepEqual([done.state, done.attempt], ['committed', 1])
  assert.equal(dropsLeft(t), 0)
  assert.deepEqual((await t.api('GET', '/v1/collections/c2')).body.counts, (await t.api('GET', '/v1/collections/c1')).body.counts)
})

test('a wake rides over drops (the query start, the check job and its poll, the open) without a failed alarm', async () => {
  const t = await asleep()
  t.cloud.drops.push(
    { method: 'POST', path: '/query/start', times: 1, after: true },
    { method: 'POST', path: '/jobs', op: 'manifest', times: 1, after: true },
    { method: 'GET', path: /^\/jobs\/manifest-/, times: 1 },
    { method: 'POST', path: '/query/open', times: 1, after: true }, // opening: the send repeated finds it under way
  )
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  assert.equal(dropsLeft(t), 0)
  assert.deepEqual(await logged(t, 'drive-failed'), [])
})

test('an open sent again that an older image answers 409 (it is opening) is no failed alarm either', async () => {
  const t = await asleep()
  const box = t.container('c1') as any
  const route = box.queryRoute.bind(box)
  box.queryRoute = (action: string, request: Request, json: (b: unknown, s?: number) => Response) =>
    action === 'open' && box.query.state !== 'loaded' ? json({ error: `not loaded (${box.query.state})` }, 409) : route(action, request, json)
  t.cloud.drops.push({ method: 'POST', path: '/query/open', times: 1, after: true })
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  assert.equal(dropsLeft(t), 0)
  assert.deepEqual(await logged(t, 'drive-failed'), [])
})

test('HIS-02 the backup at sleep rides over drops and a file stream cut short, and the collection comes back from it', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  const before = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages.map((p: any) => p.textHash)
  t.cloud.drops.push(
    { method: 'POST', path: '/query/stop', times: 1, after: true },
    { method: 'GET', path: '/quiesce', times: 1 },
    { method: 'POST', path: '/jobs', op: 'manifest', times: 1, after: true },
    { method: 'GET', path: /^\/files\//, times: 1, cut: true }, // R2 refuses the half it got: its checksum differs
    { method: 'GET', path: /^\/files\//, times: 1 },
  )
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep, backed up
  assert.equal(dropsLeft(t), 0)
  assert.deepEqual(await logged(t, 'backup-failed'), [])
  assert.equal((await logged(t, 'backup')).length, 1)
  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  const after = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.deepEqual(after.body.passages.map((p: any) => p.textHash), before)
  const events = (await log(t, 'c1')).map((e: any) => e.event)
  assert.ok(events.includes('from-backup-done') && !events.includes('from-backup-relearn'), 'from the backup, not by learning again')
})

// ==================================================================== a backup serves the snapshot taken from it

test('HIS-04 after coming back from its backup, a failed check comes back from the same backup again', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep, backed up
  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  await ask(t, 'c1', 'topic number 1 gateway port')
  const points = async () => (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.match((await points())[0].summary, /^Came back from its backup/)
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep again: its new snapshot holds exactly the backup's files, so no new backup
  // The new snapshot fails its check twice: the backup it came from holds its files.
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  for (let i = 0; i < 5 && answer.body.status !== 'ok'; i++) await t.drain('c1')
  assert.equal((await ask(t, 'c1', 'topic number 1 gateway port')).body.status, 'ok')
  const list = await points()
  assert.equal(list[0].version, 3)
  assert.match(list[0].summary, /^Came back from its backup/)
  const events = (await log(t, 'c1')).map((e: any) => e.event)
  assert.equal(events.filter((e: string) => e === 'checksum-mismatch').length, 2)
  assert.ok(!events.includes('repair-relearn') && !events.includes('from-backup-relearn'), 'nothing learned again')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 2)
})

// ==================================================================== a repair answers while people ask

/** Versions 1 to 3 (doc 4 added in version 3), asleep, no backup; version 3's snapshot then fails its check twice. */
async function repairing(): Promise<TestEngine> {
  const t = makeEngine()
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
  const answer = await ask(t, 'c1', 'topic number 2 gateway port')
  for (let i = 0; i < 10 && (await t.api('GET', '/v1/collections/c1')).body.state !== 'ready'; i++) await t.drain('c1')
  assert.deepEqual([answer.body.status, answer.body.version], ['ok', 4], 'it answers from version 2')
  return t
}

test('HIS-04 a repair keeps answering from the earlier version while people ask, at most an hour, then learns everything again', async () => {
  const t = await repairing()
  for (let minute = 5; minute <= 55; minute += 5) {
    t.advance(5 * 60_000)
    const answer = await ask(t, 'c1', 'topic number 2 gateway port')
    assert.deepEqual([answer.body.status, answer.body.version], ['ok', 4], `after ${minute} minutes`)
    await t.drain('c1')
  }
  t.advance(6 * 60_000) // past the hour, still asked
  await ask(t, 'c1', 'topic number 2 gateway port')
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [5, 4], 'learned again, the file of version 3 back')
})

test('HIS-04 going back waits while a repair answers: the re-learning would add files on top of the version gone back to', async () => {
  const t = await repairing()
  const refused = await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.deepEqual([refused.status, refused.body.error], [409, 'busy_learning'])
  t.advance(11 * 60_000)
  await t.drain('c1')
  assert.deepEqual([(await t.api('GET', '/v1/collections/c1')).body.version, (await t.api('GET', '/v1/collections/c1')).body.counts.documents], [5, 4])
  const went = await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.equal(went.status, 200)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 2, 'version 1 as it was, nothing added on top')
})

test('HIS-04 an import arriving while a repair answers starts the re-learning first, then learns', async () => {
  const t = await repairing()
  await startImport(t, 'c1', 'imp-4', [doc(5)])
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [6, 5])
  const committed = (await logged(t, 'committed')).map((e: any) => e.kind)
  assert.deepEqual(committed.slice(-2), ['from_backup', 'import'], 'the re-learning, then the import')
})

// ==================================================================== planning by size

test('IMP-06 a 2 MB text is planned by its size (about half an hour, not 48 seconds)', async () => {
  const t = makeEngine()
  await createCollection(t)
  const large: FileSpec = { fileId: 'large', name: 'large.txt', type: 'text/plain', text: bigText(2 * MiB) }
  await startImport(t, 'c1', 'large', [large])
  const queued = await importOf(t, 'large')
  const planned = SETTINGS.containerStartSeconds + SETTINGS.importBaseSeconds + SETTINGS.perDocumentSeconds + 2 * SETTINGS.perTextMiBSeconds
  assert.ok(Math.abs(queued.etaSeconds - planned) <= 1, `${queued.etaSeconds} s planned, ${planned} s expected`)
  assert.ok(queued.etaSeconds > 25 * 60)
  // Questions while it learns are told to come back when it should be done, not in 48 seconds.
  t.cloud.jobPolls = 10
  await t.drain('c1', { steps: 2 })
  const asked = await t.api('POST', '/v1/collections/c1/search', { query: 'harbour schedule' })
  assert.equal(asked.body.status, 'learning')
  assert.ok(asked.body.retryAfterSeconds > 25 * 60, `${asked.body.retryAfterSeconds}`)
})

test('a file that is not plain text is planned at a quarter of its size until read, then by the text read', async () => {
  const t = makeEngine()
  await createCollection(t)
  const report: FileSpec = { fileId: 'report', name: 'report.pdf', type: 'application/pdf', text: bigText(MiB) }
  await startImport(t, 'c1', 'report', [report])
  const queued = await importOf(t, 'report')
  const planned = SETTINGS.containerStartSeconds + SETTINGS.importBaseSeconds + SETTINGS.perDocumentSeconds + SETTINGS.perTextMiBSeconds / 4
  assert.ok(Math.abs(queued.etaSeconds - planned) <= 1, `${queued.etaSeconds} s planned, ${planned} s expected`)
  t.cloud.jobPolls = 10
  await t.drain('c1', { steps: 2 }) // started and read: its whole megabyte is text
  const learning = await importOf(t, 'report')
  assert.equal(learning.state, 'learning')
  assert.ok(learning.etaSeconds > queued.etaSeconds + 500, `${learning.etaSeconds} s after reading, ${queued.etaSeconds} s before`)
})

test('imports of large texts that learn for over an hour keep their slots and aren\'t given up within three times their plan', async () => {
  const t = makeEngine()
  for (const cid of ['c1', 'c2', 'c3']) await createCollection(t, cid)
  t.cloud.hangJobs = ['ingest']
  await startImport(t, 'c1', 'large-1', [{ fileId: 'l1', name: 'large-1.txt', type: 'text/plain', text: bigText(2 * MiB, 'ferry') }])
  await startImport(t, 'c2', 'large-2', [{ fileId: 'l2', name: 'large-2.txt', type: 'text/plain', text: bigText(2 * MiB, 'tugboat') }])
  await startImport(t, 'c3', 'small', [doc(1)])
  for (let minute = 1; minute <= 75; minute++) {
    t.advance(60_000)
    await t.drain(undefined, { steps: 8 })
  }
  // The organization's two slots are still theirs after 75 minutes; the third import still waits.
  const running = (await guard(t)).running
  assert.ok(running.some((key) => key.endsWith(':c1:large-1')) && running.some((key) => key.endsWith(':c2:large-2')), running.join())
  assert.deepEqual([(await importOf(t, 'large-1')).state, (await importOf(t, 'large-1')).attempt], ['learning', 1])
  assert.deepEqual([(await importOf(t, 'large-2', 'c2')).state, (await importOf(t, 'large-2', 'c2')).attempt], ['learning', 1])
  assert.deepEqual([(await importOf(t, 'small', 'c3')).state, (await importOf(t, 'small', 'c3')).waitingFor], ['queued', 'organization'])
  for (const cid of ['c1', 'c2']) {
    const events = (await log(t, cid)).map((e: any) => e.event)
    assert.ok(!events.includes('lease-lost') && !events.includes('import-try-failed'), `${cid}: ${events.join()}`)
  }
  t.cloud.hangJobs = []
  await t.drain(undefined, { steps: 400 })
  for (const [cid, importId] of [['c1', 'large-1'], ['c2', 'large-2'], ['c3', 'small']]) {
    const done = await importOf(t, importId, cid)
    assert.deepEqual([done.state, done.attempt], ['committed', 1], importId)
  }
})

// ==================================================================== the alarm and the container's monitor

test('the alarm never waits on the container\'s monitor, and a container that stops still brings the alarm at once', async () => {
  const t = await asleep()
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.equal(answer.body.status, 'ok')
  assert.equal(t.container('c1').running, true)
  assert.equal(t.collections.instance(C1).state.pending.length, 0, 'nothing that lasts as long as the container is handed to waitUntil')
  const storage = t.storage('c1')
  await storage.setAlarm(t.now() + 60 * 60_000)
  await t.container('c1').destroy()
  for (let i = 0; i < 20 && storage.alarm! > t.now(); i++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(storage.alarm! <= t.now(), 'the monitor set the alarm')
})
