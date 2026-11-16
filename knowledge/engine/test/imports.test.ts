// Imports: the state machine, all or nothing, nothing learned twice, three tries, fails closed, originals deleted.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORG, ask, createCollection, doc, learn, log, makeEngine, outboxEvents, stageFile, startImport } from './helpers.ts'

test('an import moves queued → reading → learning → saving → committed, and the collection learning → ready', async () => {
  const t = makeEngine()
  t.cloud.jobPolls = 3
  const created = await createCollection(t)
  assert.equal(created.state, 'empty')
  assert.equal(created.version, 0)

  const started = await startImport(t, 'c1', 'imp-1', [doc(1), doc(2)])
  assert.equal(started.status, 202)
  assert.equal(started.body.state, 'queued')
  assert.deepEqual(started.body.files.map((f: any) => f.state), ['waiting', 'waiting'])

  const seen = new Set<string>()
  const collectionStates = new Set<string>()
  for (let i = 0; i < 40; i++) {
    await t.drain('c1', { steps: 1 })
    const status = (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body
    seen.add(status.state)
    collectionStates.add((await t.api('GET', '/v1/collections/c1')).body.state)
    if (status.state === 'committed') break
  }
  assert.ok(seen.has('reading'), [...seen].join())
  assert.ok(seen.has('learning'), [...seen].join())
  assert.ok(seen.has('committed'), [...seen].join())
  assert.ok(collectionStates.has('learning'))

  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.version, 1)
  assert.equal(status.counts.documents, 2)
  assert.equal(status.currentImport, null)
  const final = (await t.api('GET', '/v1/collections/c1/imports/imp-1')).body
  assert.equal(final.version, 1)
  assert.deepEqual(final.files.map((f: any) => f.state), ['learned', 'learned'])

  const events = await outboxEvents(t)
  assert.ok(events.some((e) => e.type === 'committed' && e.version === 1 && e.importId === 'imp-1' && e.counts.documents === 2))
  assert.ok(events.some((e) => e.type === 'import' && e.import.state === 'committed'))
  assert.ok(events.some((e) => e.type === 'usage' && e.kind === 'learning' && e.seconds > 0))
})

test('questions during an import answer "learning" at once, and use the new files after the commit (IMP-08)', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.cloud.jobPolls = 5
  await startImport(t, 'c1', 'imp-2', [doc(2)])
  await t.drain('c1', { steps: 2 })
  const during = await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 2 gateway port' })
  assert.equal(during.body.status, 'learning')
  assert.ok(during.body.retryAfterSeconds > 0)
  assert.deepEqual(during.body.passages, [])
  await t.drain('c1')
  const after = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.equal(after.body.status, 'ok')
  assert.ok(after.body.passages.some((p: any) => p.text.includes('8002')))
})

test('IMP-03 all or nothing: an import killed at 3 of 5 keeps nothing, and the retry learns all 5 once', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'base', [doc(1)])
  const pointsBefore = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.length
  t.advance(6 * 60_000) // past the 5 minutes in which changes share a restore point

  t.cloud.jobPolls = 5
  const files = [2, 3, 4, 5, 6].map((n) => doc(n))
  await startImport(t, 'c1', 'imp-5', files)
  let killedAt = -1
  for (let i = 0; i < 30 && killedAt < 0; i++) {
    await t.drain('c1', { steps: 1 })
    const status = (await t.api('GET', '/v1/collections/c1/imports/imp-5')).body
    const learned = status.files.filter((f: any) => f.state === 'learned').length
    if (learned >= 3) {
      killedAt = learned
      await t.api('POST', '/v1/collections/c1/__test/destroy-container')
    }
  }
  assert.ok(killedAt >= 3, 'the container was destroyed part way')
  await t.drain('c1', { steps: 1 })
  const interrupted = (await t.api('GET', '/v1/collections/c1/imports/imp-5')).body
  assert.equal(interrupted.state, 'interrupted')
  assert.equal(interrupted.attempt, 2)
  const between = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(between.version, 1, 'the restore point is unchanged by the crash')
  assert.equal(between.counts.documents, 1, 'nothing partial was kept')

  t.advance(60_000)
  await t.drain('c1')
  const done = (await t.api('GET', '/v1/collections/c1/imports/imp-5')).body
  assert.equal(done.state, 'committed')
  const documents = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  assert.equal(documents.length, 6)
  assert.equal(new Set(documents.map((d: any) => d.sha256)).size, documents.length, 'document count equals the unique count')
  // The retry started from the committed snapshot, not from the dirty container.
  const starts = t.cloud.starts.filter((s) => s.collection.endsWith(':c1'))
  assert.equal(starts.at(-1)!.snapshot, starts.find((s) => s.snapshot)!.snapshot)
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.length, pointsBefore + 1)
  const entries = await log(t, 'c1')
  assert.ok(entries.some((e: any) => e.event === 'import-try-failed' && e.attempt === 1))
})

test('IMP-04 nothing learned twice: a learned batch again, and the same file under another name, change nothing', async () => {
  const t = makeEngine()
  await createCollection(t)
  const first = await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  assert.equal(first.state, 'committed')
  const versionBefore = (await t.api('GET', '/v1/collections/c1')).body.version
  const pointsBefore = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.length

  // The same import id answers the existing import, with 200.
  const again = await t.api('POST', '/v1/collections/c1/imports', { importId: 'imp-1', files: [], notes: [], small: false })
  assert.equal(again.status, 200)
  assert.equal(again.body.state, 'committed')
  assert.equal(again.body.version, 1)

  // The same content under another name and import id is "already here".
  const renamed = { ...doc(1), fileId: 'f1-copy', name: 'copy of doc-1.md' }
  const dup = await startImport(t, 'c1', 'imp-dup', [renamed])
  assert.equal(dup.status, 202)
  assert.equal(dup.body.state, 'duplicate')
  assert.equal(dup.body.files[0].state, 'already_here')
  await t.drain('c1')
  const after = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(after.version, versionBefore)
  assert.equal(after.counts.documents, 2)
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.length, pointsBefore, 'no new restore point')
  assert.deepEqual(t.files.keys('inbox/'), [], 'the duplicate original is not kept')

  // Two copies in one import: learned once.
  const twin = { ...doc(3), fileId: 'f3b', name: 'twin.md' }
  const both = await learn(t, 'c1', 'imp-twins', [doc(3), twin])
  assert.equal(both.state, 'committed')
  assert.deepEqual(both.files.map((f: any) => f.state), ['learned', 'already_here'])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 3)
})

test('IMP-05 three tries, then the failing file is named, and the others can be learned without it', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.crashFileId = 'f2'
  await startImport(t, 'c1', 'imp-crash', [doc(1), doc(2), doc(3)])
  for (let i = 0; i < 5; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-crash')).body
  assert.equal(status.state, 'failed')
  assert.equal(status.attempt, 3)
  assert.equal(status.failedFileId, 'f2')
  assert.match(status.error.message, /doc-2\.md.*3 tries/)
  assert.equal(status.files.find((f: any) => f.fileId === 'f2').state, 'failed')
  const ingests = t.cloud.calls.filter((c) => c.detail === 'ingest').length
  assert.equal(ingests, 3, 'no fourth try')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 0)

  // The other files are still staged: learn them without it.
  t.cloud.crashFileId = null
  const staged = [doc(1), doc(3)].map((f) => ({ fileId: f.fileId, name: f.name, type: 'text/markdown', bytes: 0, sha256: '' }))
  for (const f of staged) {
    const record = await t.storage('c1').get<any>(`staged:${f.fileId}`)
    f.sha256 = record.sha256
  }
  const retry = await t.api('POST', '/v1/collections/c1/imports', { importId: 'imp-without', files: staged, notes: [], small: false })
  assert.equal(retry.status, 202)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/imp-without')).body.state, 'committed')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 2)
})

test('a file that can never be read fails at once, with its reason (a scanned PDF)', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.failExtraction.f9 = '“Signed form.pdf” is a scanned image with no text, so Knowledge can\'t read it.'
  await startImport(t, 'c1', 'imp-scan', [{ fileId: 'f9', name: 'Signed form.pdf', text: '%PDF-1.4 image only', type: 'application/pdf' }])
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-scan')).body
  assert.equal(status.state, 'failed')
  assert.equal(status.attempt, 1)
  assert.equal(status.error.error, 'unsupported_type')
  assert.match(status.files[0].reason, /scanned image/)
})

test('HID-02 hiding fails closed: a detector error stops the import and nothing is stored', async () => {
  const t = makeEngine()
  await createCollection(t)
  t.cloud.detectorError = true
  await startImport(t, 'c1', 'imp-hide', [doc(1, 'Write to dana@example.com')])
  for (let i = 0; i < 4; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  const status = (await t.api('GET', '/v1/collections/c1/imports/imp-hide')).body
  assert.equal(status.state, 'failed')
  assert.match(status.files[0].reason, /Hiding sensitive information failed/)
  const collection = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(collection.counts.documents, 0, 'no new document')
  assert.equal(collection.version, 0)
  assert.deepEqual(t.files.keys('text/'), [], 'no text stored')
})

test('HID-03 originals are deleted: after an import the R2 inbox prefix is empty', async () => {
  const t = makeEngine()
  await createCollection(t)
  await startImport(t, 'c1', 'imp-1', [doc(1), doc(2)])
  assert.equal(t.files.keys(`inbox/${ORG}/c1/`).length, 2, 'staged while waiting')
  await t.drain('c1')
  assert.deepEqual(t.files.keys(`inbox/${ORG}/c1/`), [])
  assert.deepEqual(await t.storage('c1').list({ prefix: 'staged:' }), new Map())
  // The container's own inbox is empty too, before the snapshot.
  assert.equal(t.container('c1').inbox.size, 0)
})

test('HID-01 hidden values never reach R2: the stored text holds [hidden] and its position', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'Write to dana.reyes@example.com for access.')])
  const [document] = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  const text = (await t.api('GET', `/v1/collections/c1/documents/${document.documentId}`)).body
  assert.ok(!text.text.includes('dana.reyes@example.com'))
  assert.ok(text.text.includes('[hidden]'))
  assert.equal(text.text.slice(text.hidden[0].start, text.hidden[0].end), '[hidden]')
  for (const key of t.files.keys()) assert.ok(!t.files.text(key)!.includes('dana.reyes@example.com'), key)
})

test('staging checks the file: a wrong SHA-256 is refused, and an import of an unstaged file is refused', async () => {
  const t = makeEngine()
  await createCollection(t)
  const bad = await t.api('PUT', '/v1/collections/c1/inbox/fx', new TextEncoder().encode('hello'), {
    headers: { 'content-type': 'text/plain', 'x-file-name': 'a.txt', 'x-file-sha256': '0'.repeat(64) },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'bad_request')
  const missing = await t.api('POST', '/v1/collections/c1/imports', {
    importId: 'imp-x',
    files: [{ fileId: 'nope', name: 'a.txt', type: 'text/plain', bytes: 5, sha256: '1'.repeat(64) }],
    notes: [],
    small: false,
  })
  assert.equal(missing.status, 400)
  const staged = await stageFile(t, 'c1', { fileId: 'ok', name: 'b.txt', text: 'b' })
  assert.equal(staged.bytes, 1)
  // Without x-file-sha256 the engine works it out and answers it.
  const unhashed = await t.api('PUT', '/v1/collections/c1/inbox/nohash', new TextEncoder().encode('hello'), {
    headers: { 'content-type': 'text/plain', 'x-file-name': 'hello.txt' },
  })
  assert.equal(unhashed.status, 200)
  assert.equal(unhashed.body.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  assert.equal((await t.api('PUT', '/v1/collections/c1/inbox/nohash2', new TextEncoder().encode('x'), { headers: { 'x-file-name': '' } })).status, 400, 'a name is required')
})
