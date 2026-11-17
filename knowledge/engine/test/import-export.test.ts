// POST /v1/collections/:cid/import-export (DEL-03): an empty collection starts from a Knowledge export. What answers
// depend on comes back (texts and page maps, notes, stopped sources, corrections with their outdated marks), with one
// restore point; a collection that isn't empty, or a file that isn't an export, is refused.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { ask, createCollection, doc, learn, makeEngine, outboxEvents, type TestEngine } from './helpers.ts'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function stageBytes(t: TestEngine, cid: string, fileId: string, bytes: Uint8Array, name = 'knowledge-export.zip') {
  const res = await t.api('PUT', `/v1/collections/${cid}/inbox/${fileId}`, bytes, {
    headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(name), 'x-file-sha256': sha256(bytes) },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

/** c1 with two files (one stopped), a note, and a correction that marks a passage of doc 1 outdated; its export. */
async function exported(t: TestEngine) {
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'Second paragraph about the billing rota.'), doc(2), doc(3)])
  await t.api('POST', '/v1/collections/c1/imports', {
    importId: 'note-1',
    files: [],
    notes: [{ noteId: 'n-hours', title: 'Hours', text: 'The help desk opens at 08:00.', outdated: [] }],
    small: true,
  })
  await t.drain('c1')
  const old = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages.find((p: any) => p.text.includes('8001'))
  await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n-fix', title: 'Port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  })
  await t.drain('c1')
  const docs = (await t.api('GET', '/v1/collections/c1/documents')).body.documents
  const stopped = docs.find((d: any) => d.name === 'doc-2.md')
  await t.api('PATCH', `/v1/collections/c1/documents/${stopped.documentId}`, { active: false })
  await t.drain('c1')
  await t.api('POST', '/v1/collections/c1/exports', { exportId: 'exp-1' })
  await t.drain('c1')
  const download = await t.api('GET', '/v1/collections/c1/exports/exp-1?download=1')
  assert.equal(download.status, 200)
  return { zip: new Uint8Array(await download.response.arrayBuffer()), old, stopped }
}

const answerOf = async (t: TestEngine, cid: string, query: string) =>
  (await ask(t, cid, query)).body.passages.map((p: any) => `${p.documentId} ${p.kind} ${p.textHash} ${p.outdated}`)

test('DEL-03 an export starts an empty collection: texts, notes, stopped sources and corrections come back, with one restore point', async () => {
  const t = makeEngine()
  const { zip, old, stopped } = await exported(t)
  await createCollection(t, 'c2')
  await stageBytes(t, 'c2', 'export-zip', zip)
  const started = await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-export', fileId: 'export-zip' })
  assert.deepEqual([started.status, started.body.state], [202, 'queued'])
  assert.equal((await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-export', fileId: 'export-zip' })).status, 200, 'the same id answers the same import')
  await t.drain('c2')
  const done = (await t.api('GET', '/v1/collections/c2/imports/from-export')).body
  assert.deepEqual([done.state, done.version], ['committed', 1])

  const list = async (cid: string) => (await t.api('GET', `/v1/collections/${cid}/documents`)).body.documents.map((d: any) => `${d.documentId} ${d.kind} ${d.name} ${d.active} ${d.textBytes} ${d.hiddenValues}`).sort()
  assert.deepEqual(await list('c2'), await list('c1'))
  assert.equal((await t.api('GET', `/v1/collections/c2/documents/${stopped.documentId}`)).body.document.active, false, 'a stopped source stays stopped')
  for (const d of (await t.api('GET', '/v1/collections/c1/documents')).body.documents) {
    const a = (await t.api('GET', `/v1/collections/c1/documents/${d.documentId}`)).body
    const b = (await t.api('GET', `/v1/collections/c2/documents/${d.documentId}`)).body
    assert.deepEqual([b.text, b.pages, b.hidden], [a.text, a.pages, a.hidden], d.name)
  }
  const c1 = (await t.api('GET', '/v1/collections/c1')).body.counts
  const c2 = (await t.api('GET', '/v1/collections/c2')).body.counts
  assert.deepEqual(c2, c1)

  // The same answers: the correction comes first, its outdated passage is left out, the stopped file isn't used.
  for (const query of ['topic number 1 gateway port', 'topic number 2 gateway port', 'topic number 3 gateway port', 'help desk opens']) {
    assert.deepEqual(await answerOf(t, 'c2', query), await answerOf(t, 'c1', query), query)
  }
  const answer = (await ask(t, 'c2', 'topic number 1 gateway port')).body.passages
  assert.equal(answer[0].kind, 'note')
  assert.ok(!answer.some((p: any) => p.textHash === old.textHash), 'the outdated passage is left out')
  assert.ok(!(await ask(t, 'c2', 'topic number 2 gateway port')).body.passages.some((p: any) => p.documentId === stopped.documentId))
  const facts = (await t.api('GET', '/v1/collections/c2/facts')).body.facts
  assert.ok(!facts.some((f: any) => f.passageTextHash === old.textHash), "the outdated passage's fact is left out")

  const points = (await t.api('GET', '/v1/collections/c2/restore-points')).body.restorePoints
  assert.equal(points.length, 1)
  assert.match(points[0].summary, /^Started from an export/)
  // The import names what it brought back, as an import of those files and notes would; the zip isn't one of them.
  const files = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.filter((d: any) => d.kind === 'file')
  const status = (await t.api('GET', '/v1/collections/c2/imports/from-export')).body
  assert.deepEqual(
    status.files.map((f: any) => [f.name, f.documentId, f.state]).sort(),
    files.map((d: any) => [d.name, d.documentId, 'learned']).sort(),
  )
  assert.equal(status.notes, 2, 'the note and the correction')
  assert.ok(!status.files.some((f: any) => f.fileId === 'export-zip'))
  assert.equal(started.body.files.length, 3, 'listed from the start')
  assert.equal(t.files.keys().filter((k) => k.startsWith('inbox/org-acme/c2/')).length, 0, 'the staged export is deleted')
})

test("import-export is refused for a collection that isn't empty, or a file that isn't an export", async () => {
  const t = makeEngine()
  const { zip } = await exported(t)
  await stageBytes(t, 'c1', 'export-zip', zip)
  const busy = await t.api('POST', '/v1/collections/c1/import-export', { importId: 'from-export', fileId: 'export-zip' })
  assert.deepEqual([busy.status, busy.body.error], [409, 'bad_request'])

  await createCollection(t, 'c2')
  await stageBytes(t, 'c2', 'notes', new TextEncoder().encode('# Just notes\n\nNot an export.'), 'notes.md')
  const plain = await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-notes', fileId: 'notes' })
  assert.deepEqual([plain.status, plain.body.error], [409, 'bad_request'])
  // A zip whose document text was damaged: refused before anything is queued.
  const damaged = zip.slice()
  const at = Buffer.from(damaged).indexOf('documents/')
  damaged[at + 'documents/'.length] = 'x'.charCodeAt(0) // a document id that isn't one
  await stageBytes(t, 'c2', 'damaged', damaged)
  const refused = await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-damaged', fileId: 'damaged' })
  assert.deepEqual([refused.status, refused.body.error], [409, 'bad_request'])
  assert.equal((await t.api('GET', '/v1/collections/c2')).body.version, 0)
  const missing = await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-nothing', fileId: 'never-staged' })
  assert.deepEqual([missing.status, missing.body.error], [400, 'bad_request'])
})

test("an export's texts are hidden again with the new collection's stricter rules", async () => {
  const t = makeEngine()
  const { zip } = await exported(t)
  await t.api('PUT', '/v1/collections/c2', {
    settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['rota'] } },
  })
  await stageBytes(t, 'c2', 'export-zip', zip)
  await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-export', fileId: 'export-zip' })
  await t.drain('c2')
  assert.equal((await t.api('GET', '/v1/collections/c2/imports/from-export')).body.state, 'committed')
  const stored = t.files.keys().filter((k) => k.startsWith('text/org-acme/c2/')).map((k) => t.files.text(k)!).join('\n')
  assert.ok(!stored.includes('rota'), 'the word is hidden in what is stored')
  const doc1 = (await t.api('GET', '/v1/collections/c2/documents')).body.documents.find((d: any) => d.name === 'doc-1.md')
  assert.equal(doc1.hiddenValues, 1)
})

/** A zip of the given entries; `size` and `crc` override what the headers say. */
function forge(entries: { name: string; data: Buffer; size?: number; crc?: number }[]): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const packed = deflateRawSync(e.data, { level: 9 })
    const name = Buffer.from(e.name)
    const size = e.size ?? e.data.length
    const crc = e.crc ?? crc32(e.data)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc, 14)
    l.writeUInt32LE(packed.length, 18); l.writeUInt32LE(size, 22); l.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20)
    c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42)
    locals.push(l, name, packed)
    centrals.push(c, name)
    offset += 30 + name.length + packed.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}

test('a zip entry is inflated only up to the size it says: a lying size, a bad CRC or too large an entry gives nothing', async () => {
  const { unzipEntry, zipEntries } = await import('../src/zip.ts')
  const entry = (zip: Uint8Array) => zipEntries(zip)!.get('a.txt')!
  const fine = Buffer.from('a'.repeat(5000))
  assert.deepEqual(Buffer.from((await unzipEntry(entry(forge([{ name: 'a.txt', data: fine }])), 1 << 20))!), fine)
  // It says 10 bytes and inflates to 200 MB: stopped at the 10, never holding the rest.
  const forged = entry(forge([{ name: 'a.txt', data: Buffer.alloc(200 * 1024 * 1024, 0x41), size: 10, crc: 0 }]))
  globalThis.gc?.()
  const before = process.memoryUsage().arrayBuffers
  let peak = before
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 1)
  const lying = await unzipEntry(forged, 8 << 20)
  clearInterval(timer)
  assert.equal(lying, null)
  assert.ok(peak - before < 32 * 1024 * 1024, `held ${Math.round((peak - before) / 1048576)} MB`)
  assert.equal(await unzipEntry(entry(forge([{ name: 'a.txt', data: fine, crc: 12345 }])), 1 << 20), null, 'a bad CRC')
  assert.equal(await unzipEntry(entry(forge([{ name: 'a.txt', data: fine }])), 4999), null, 'larger than allowed')
  assert.equal(await unzipEntry(entry(forge([{ name: 'a.txt', data: fine, size: 6000 }])), 1 << 20), null, 'shorter than it says')
})

test("an export is refused when its text entry lies about its size, a file's checksum isn't one, or a correction comes from a file", async () => {
  const t = makeEngine()
  await createCollection(t)
  const file = 'd_' + 'a'.repeat(24)
  const other = 'd_' + 'b'.repeat(24)
  const json = (v: unknown) => Buffer.from(JSON.stringify(v))
  const info = (id: string, sha256 = 'c'.repeat(64)) => ({ documentId: id, kind: 'file', name: `${id}.md`, type: 'text/markdown', bytes: 10, pages: null, sha256, active: true })
  const exportOf = (o: { text?: { data: Buffer; size?: number; crc?: number }; sha256?: string; corrections?: unknown[] }) =>
    forge([
      { name: 'README.txt', data: Buffer.from('export') },
      { name: 'collection.json', data: json({ collectionId: 'src', version: 3 }) },
      { name: 'notes.json', data: json({ notes: [] }) },
      { name: 'corrections.json', data: json({ corrections: o.corrections ?? [] }) },
      { name: `documents/${file}.json`, data: json({ document: info(file, o.sha256), pages: [], hidden: [] }) },
      { name: `documents/${file}.txt`, ...(o.text ?? { data: Buffer.from('Some text.') }) },
      { name: `documents/${other}.json`, data: json({ document: info(other), pages: [], hidden: [] }) },
      { name: `documents/${other}.txt`, data: Buffer.from('Other text.') },
    ])
  let n = 0
  const tryIt = async (zip: Uint8Array) => {
    n += 1
    await stageBytes(t, 'c1', `zip-${n}`, zip)
    return t.api('POST', '/v1/collections/c1/import-export', { importId: `from-${n}`, fileId: `zip-${n}` })
  }
  for (const [why, zip] of [
    ['a checksum that is not one', exportOf({ sha256: 'x' })],
    ['a correction from a file', exportOf({ corrections: [{ documentId: file, textHash: 'e'.repeat(64), noteDocumentId: other, needsCheck: false }] })],
  ] as const) {
    const res = await tryIt(zip)
    assert.deepEqual([res.status, res.body.error], [409, 'bad_request'], why)
  }
  // A text that says 10 bytes and is 100 MB: accepted as an export, then stopped when the text is read.
  const bomb = await tryIt(exportOf({ text: { data: Buffer.alloc(100 * 1024 * 1024, 0x41), size: 10, crc: 0 } }))
  assert.equal(bomb.status, 202)
  await t.drain('c1')
  const status = (await t.api('GET', `/v1/collections/c1/imports/${bomb.body.importId}`)).body
  assert.equal(status.state, 'failed')
  assert.match(status.error.message, /damaged/)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 0)
})

test("stricter hiding that changes a corrected passage: its mark follows it, it stays left out, and the correction asks to be checked", async () => {
  const t = makeEngine()
  const { zip, old } = await exported(t)
  // The new collection hides the corrected passage's own value.
  await t.api('PUT', '/v1/collections/c2', {
    settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['8001'] } },
  })
  await stageBytes(t, 'c2', 'export-zip', zip)
  await t.api('POST', '/v1/collections/c2/import-export', { importId: 'from-export', fileId: 'export-zip' })
  await t.drain('c2')
  assert.equal((await t.api('GET', '/v1/collections/c2/imports/from-export')).body.state, 'committed')
  const passages = (await ask(t, 'c2', 'topic number 1 gateway port')).body.passages
  assert.equal(passages[0].kind, 'note', 'the correction answers first')
  assert.ok(!passages.some((p: any) => p.documentId === old.documentId && /gateway port is \[hidden\]/.test(p.text)), 'the corrected passage, hidden again, is still left out')
  const checks = (await outboxEvents(t)).filter((e: any) => e.type === 'needs_check' && e.collectionId === 'c2')
  assert.deepEqual(checks.map((e: any) => [e.noteId, e.documentId]), [['n-fix', old.documentId]])
})
