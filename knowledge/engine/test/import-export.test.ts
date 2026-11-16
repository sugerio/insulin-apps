// POST /v1/collections/:cid/import-export (DEL-03): an empty collection starts from a Knowledge export. What answers
// depend on comes back (texts and page maps, notes, stopped sources, corrections with their outdated marks), with one
// restore point; a collection that isn't empty, or a file that isn't an export, is refused.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ask, createCollection, doc, learn, makeEngine, type TestEngine } from './helpers.ts'

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
  assert.equal((await t.api('GET', '/v1/collections/c2/imports/from-export')).body.files[0].state, 'learned')
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
