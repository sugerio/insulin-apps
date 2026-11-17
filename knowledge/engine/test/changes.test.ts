// Changes that make restore points without new files, and what the collection shows: corrections, stop using,
// facts, exports.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { sha256 } from './fakes.ts'
import { ORG, ask, createCollection, doc, learn, makeEngine, outboxEvents } from './helpers.ts'

const SIX_MINUTES = 6 * 60_000

test('FIX-01 a correction: the outdated passage is left out, the note answers in its place, ranked first', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  const before = await ask(t, 'c1', 'topic number 1 gateway port')
  const old = before.body.passages.find((p: any) => p.text.includes('8001'))
  assert.ok(old)
  t.advance(SIX_MINUTES)

  const res = await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n1', title: 'Gateway port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  })
  assert.equal(res.status, 202)
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/imports/fix-1')).body.state, 'committed')
  const after = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.ok(!after.body.passages.some((p: any) => p.textHash === old.textHash), 'the old passage is left out')
  assert.equal(after.body.passages[0].kind, 'note')
  assert.match(after.body.passages[0].text, /9001/)
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0].summary, 'Correction')
  // A paraphrase finds the note too.
  const paraphrase = await ask(t, 'c1', 'what port does topic number 1 use for the gateway')
  assert.match(paraphrase.body.passages[0].text, /9001/)
  // Facts whose source passage is outdated are hidden.
  const facts = (await t.api('GET', '/v1/collections/c1/facts')).body.facts
  assert.ok(!facts.some((f: any) => f.passageId === old.passageId))
  // A correction naming a document that isn't here is refused.
  const bad = await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-2',
    note: { noteId: 'n2', title: 'x', text: 'x', outdated: [{ documentId: 'd_unknown', textHash: old.textHash }] },
  })
  assert.equal(bad.status, 400)
})

test('stop using and use again are changes with their own restore point, on the same snapshot', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(SIX_MINUTES)
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-2.md')
  const startsBefore = t.cloud.starts.length
  const stopped = await t.api('PATCH', `/v1/collections/c1/documents/${target.documentId}`, { active: false })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.state, 'committed')
  assert.equal(stopped.body.version, 2)
  assert.equal(t.cloud.starts.length, startsBefore, 'no container work')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.counts.documents, status.counts.activeDocuments], [2, 1])
  const points = await t.storage('c1').list<any>({ prefix: 'rp:' })
  const [v1, v2] = [...points.values()]
  assert.equal(v2.snapshotId, v1.snapshotId)
  const answer = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.ok(!answer.body.passages.some((p: any) => p.documentId === target.documentId), 'not used for answers')
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0].summary, 'Stopped using 1 file')
  // Same again: nothing changes.
  const again = await t.api('PATCH', `/v1/collections/c1/documents/${target.documentId}`, { active: false })
  assert.equal(again.body.state, 'duplicate')
  const resumed = await t.api('PATCH', `/v1/collections/c1/documents/${target.documentId}`, { active: true })
  assert.equal(resumed.body.version, 3)
  assert.ok((await ask(t, 'c1', 'topic number 2 gateway port')).body.passages.some((p: any) => p.documentId === target.documentId))
  assert.ok((await outboxEvents(t)).some((e) => e.type === 'committed' && e.version === 2))
})

test('documents: the list, the redacted text with its page map, and facts with their source sentence', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  const [d] = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  assert.deepEqual(Object.keys(d).sort(), ['active', 'addedAt', 'bytes', 'documentId', 'hiddenValues', 'kind', 'name', 'pages', 'sha256', 'textBytes', 'type', 'version'])
  assert.equal(d.version, 1)
  const text = (await t.api('GET', `/v1/collections/c1/documents/${d.documentId}`)).body
  assert.deepEqual(Object.keys(text).sort(), ['document', 'hidden', 'pages', 'text'])
  const facts = (await t.api('GET', '/v1/collections/c1/facts')).body
  assert.equal(facts.next, null)
  assert.ok(facts.facts.length >= 1)
  assert.deepEqual(Object.keys(facts.facts[0]).sort(), ['documentId', 'factId', 'passageId', 'passageTextHash', 'sentence', 'sourceSentence'])
})

function unzip(bytes: Uint8Array): Map<string, string> {
  const files = new Map<string, string>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extra = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength))
    const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    files.set(name, new TextDecoder().decode(inflateRawSync(data)))
    at += 30 + nameLength + extra + size
  }
  return files
}

test('DEL-03 an export holds text, notes, facts, corrections and history, and no originals or hidden values', async () => {
  const t = makeEngine()
  await createCollection(t)
  await t.api('PUT', '/v1/collections/c1', {
    settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } },
  })
  await learn(t, 'c1', 'imp-1', [doc(1, 'Contact jordan.lee@example.com about Bluewater.'), doc(2)])
  await t.api('POST', '/v1/collections/c1/imports', {
    importId: 'note-1',
    files: [],
    notes: [{ noteId: 'n1', title: 'Hours', text: 'The help desk opens at 08:00.', outdated: [] }],
    small: true,
  })
  await t.drain('c1')
  const started = await t.api('POST', '/v1/collections/c1/exports', { exportId: 'exp-1' })
  assert.equal(started.status, 200)
  assert.equal(started.body.state, 'queued')
  assert.equal((await t.api('POST', '/v1/collections/c1/exports', { exportId: 'exp-1' })).body.exportId, 'exp-1')
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1/exports/exp-1')).body
  assert.equal(status.state, 'ready')
  assert.ok(status.bytes > 0 && status.expiresAt)
  const download = await t.api('GET', '/v1/collections/c1/exports/exp-1?download=1')
  assert.equal(download.response.headers.get('content-type'), 'application/zip')
  const files = unzip(new Uint8Array(await download.response.arrayBuffer()))
  const names = [...files.keys()]
  for (const required of ['README.txt', 'collection.json', 'notes.json', 'facts.json', 'corrections.json', 'history.json']) assert.ok(names.includes(required), required)
  assert.equal(names.filter((n) => n.startsWith('documents/') && n.endsWith('.txt')).length, 3)
  const everything = [...files.values()].join('\n')
  assert.ok(!everything.includes('jordan.lee@example.com'), 'no hidden e-mail address')
  assert.ok(!everything.includes('Bluewater'), "no hidden word, not even in the settings' word list")
  assert.ok(everything.includes('[hidden]'))
  assert.equal(JSON.parse(files.get('notes.json')!).notes[0].text, 'The help desk opens at 08:00.')
  assert.ok(JSON.parse(files.get('history.json')!).restorePoints.length >= 1)
  assert.ok(!t.files.keys('inbox/').length, 'no original kept to export')
})

test('a large export is stored in equal parts', async () => {
  const t = makeEngine()
  await createCollection(t)
  const big = Array.from({ length: 4000 }, (_, i) => `Line ${i} ${Math.random().toString(36).repeat(8)}`).join('\n\n')
  await learn(t, 'c1', 'imp-1', [{ fileId: 'big', name: 'big.txt', text: big, type: 'text/plain' }])
  const { R2Sink } = await import('../src/r2sink.ts')
  t.files.minPartBytes = 1024
  const sink = new R2Sink(t.env.FILES, 'exports/test.zip', 1024)
  for (let i = 0; i < 10; i++) await sink.write(new Uint8Array(700).fill(i))
  await sink.close()
  assert.equal(t.files.objects.get('exports/test.zip')!.body.length, 7000)
  assert.ok(t.files.multipart >= 1)
})

test('documents count their hidden values, facts carry their passage hash, and settings keep backupDays', async () => {
  const t = makeEngine()
  const created = await t.api('PUT', '/v1/collections/c1', {})
  assert.equal(created.body.settings.backupDays, 30)
  await learn(t, 'c1', 'imp-1', [doc(1, 'Write to dana.reyes@example.com or sam.okafor@example.com.')])
  const [d] = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  assert.equal(d.hiddenValues, 2)
  const [fact] = (await t.api('GET', '/v1/collections/c1/facts')).body.facts
  // The fake container's fact comes from the document's first paragraph.
  assert.equal(fact.passageTextHash, sha256('# Document 1'))
  assert.equal((await t.api('PUT', '/v1/collections/c1', { settings: { backupDays: 0 } })).status, 400)
  assert.equal((await t.api('PUT', '/v1/collections/c1', { settings: { backupDays: 7 } })).body.settings.backupDays, 7)
})

test('daily backups are kept backupDays days; the latest is kept for good', async () => {
  const t = makeEngine()
  await createCollection(t)
  await t.api('PUT', '/v1/collections/c1', { settings: { backupDays: 2 } })
  for (let day = 0; day < 4; day++) {
    await learn(t, 'c1', `imp-${day}`, [doc(day + 1)])
    t.advance(11 * 60_000)
    await t.drain('c1')
    t.advance(24 * 60 * 60_000)
  }
  const daily = t.backups.keys().filter((k) => k.includes('/daily/'))
  assert.ok(daily.length <= 3 && daily.length >= 1, daily.join(', '))
  assert.ok(t.backups.keys().some((k) => k.endsWith('latest.json')))
})

test('HID-04 stricter hiding: ready exports and backups that hold the newly hidden word are dropped, and a new latest backup is written', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'The codename is Bluewater.'), doc(2)])
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep: a daily backup and the latest
  await t.api('POST', '/v1/collections/c1/exports', { exportId: 'exp-1' })
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/exports/exp-1')).body.state, 'ready')
  t.advance(6 * 60_000)
  await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } } })
  for (let i = 0; i < 5; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  const version = (await t.api('GET', '/v1/collections/c1')).body.version
  assert.match((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0].summary, /stricter hiding/)
  const holding = (r2: any, prefix: string) =>
    r2.keys(prefix).filter((k: string) => {
      const raw = r2.objects.get(k).body as Uint8Array
      return new TextDecoder().decode(raw).includes('Bluewater') || (k.endsWith('.zip') && [...unzip(raw).values()].some((v) => v.includes('Bluewater')))
    })
  assert.deepEqual(holding(t.files, 'exports/'), [], 'no export holds it')
  assert.equal((await t.api('GET', '/v1/collections/c1/exports/exp-1')).body.state, 'failed', 'the export that held it is gone')
  assert.deepEqual(holding(t.backups, 'backups/'), [], 'no backup holds it')
  const latest = JSON.parse(t.backups.text(`backups/${ORG}/c1/latest.json`)!)
  assert.equal(latest.version, version, 'a new latest backup holds the version read again')
  assert.deepEqual(holding(t.files, 'text/'), [])
})

test('a correction written again for the same passage replaces the earlier one: the newest answers', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  const old = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages.find((p: any) => p.text.includes('8001'))
  const correct = async (importId: string, noteId: string, port: number) => {
    t.advance(6 * 60_000)
    const res = await t.api('POST', '/v1/collections/c1/corrections', {
      importId,
      note: { noteId, title: 'Port', text: `Topic number 1: the gateway port is now ${port}.`, outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
    })
    assert.equal(res.status, 202)
    await t.drain('c1')
    assert.equal((await t.api('GET', `/v1/collections/c1/imports/${importId}`)).body.state, 'committed')
  }
  await correct('fix-1', 'n-port', 9001)
  assert.ok((await ask(t, 'c1', 'topic number 1 gateway port')).body.passages[0].text.includes('9001'))
  await correct('fix-2', 'n-port', 9002) // "Write it again"
  const passages = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages
  assert.ok(passages[0].text.includes('9002'), 'the newest correction answers')
  assert.ok(!passages.some((p: any) => p.text.includes('9001')), 'the earlier one is no longer used')
  assert.ok(!passages.some((p: any) => p.textHash === old.textHash), 'the passage stays outdated')
  const notes = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.filter((d: any) => d.kind === 'note')
  assert.deepEqual(notes.map((d: any) => d.active).sort(), [false, true], 'the earlier correction is kept, not used')
  const facts = (await t.api('GET', '/v1/collections/c1/facts')).body.facts
  assert.ok(!facts.some((f: any) => f.sentence.includes('9001')))
  // A correction that still corrects another passage stays in use for that one.
  const other = (await ask(t, 'c1', 'topic number 2 gateway port')).body.passages.find((p: any) => p.text.includes('8002'))
  t.advance(6 * 60_000)
  await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-3',
    note: { noteId: 'n-both', title: 'Ports', text: 'Topic number 1 and topic number 2: the gateway port is now 7001 and 7002.', outdated: [{ documentId: old.documentId, textHash: old.textHash }, { documentId: other.documentId, textHash: other.textHash }] },
  })
  await t.drain('c1')
  await correct('fix-4', 'n-port', 9004)
  const both = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'Ports')
  assert.equal(both.active, true, 'it still corrects topic number 2')
  const second = (await ask(t, 'c1', 'topic number 2 gateway port')).body.passages
  assert.ok(second.some((p: any) => p.text.includes('7002')) && !second.some((p: any) => p.textHash === other.textHash))
})

async function stricterAfterBackup() {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'The codename is Bluewater.'), doc(2)])
  t.advance(11 * 60_000)
  await t.drain('c1') // asleep: a daily backup and the latest
  return t
}

test("stricter hiding's clean-up keeps the backed-up files the new latest backup shares: none is stored twice", async () => {
  const t = await stricterAfterBackup()
  const put = t.backups.put.bind(t.backups)
  const blobs: string[] = []
  t.backups.put = async (key: string, value: unknown, options?: any) => {
    if (key.includes('/blobs/')) blobs.push(key)
    return put(key, value, options)
  }
  t.advance(6 * 60_000)
  await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } } })
  for (let i = 0; i < 5; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  const before = new Set(blobs)
  assert.ok(blobs.length > 0)
  const existing = t.backups.keys(`backups/${ORG}/c1/blobs/`)
  // Every file of the new latest backup is stored once; the ones it shares with the old backup were never deleted.
  assert.equal(blobs.length, before.size, 'no file uploaded twice')
  assert.ok(existing.length > blobs.length, 'files the backups share stayed')
})

test("a retried clean-up after stricter hiding leaves an export made since alone", async () => {
  const t = await stricterAfterBackup()
  t.advance(6 * 60_000)
  await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } } })
  for (let i = 0; i < 5; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  const version = (await t.api('GET', '/v1/collections/c1')).body.version
  const committedAt = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0].createdAt
  await t.api('POST', '/v1/collections/c1/exports', { exportId: 'after' })
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1/exports/after')).body.state, 'ready')
  // The clean-up is owed again (its first try failed part-way), and runs from the alarm.
  const doc1 = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-1.md')
  await t.storage('c1').put('hiddenCleanup', { before: version, at: committedAt, documentIds: [doc1.documentId] })
  await t.object('c1').alarm()
  assert.equal(await t.storage('c1').get('hiddenCleanup'), undefined, 'done')
  assert.equal((await t.api('GET', '/v1/collections/c1/exports/after')).body.state, 'ready', 'the export made after the change holds the hidden text')
  assert.ok(t.backups.keys(`backups/${ORG}/c1/`).some((k) => k.endsWith('latest.json')), 'the new latest backup stays')
})
