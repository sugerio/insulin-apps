// Restore points: go back and undo against each point's own manifest, waking from the backup, an engine image
// change, a failed integrity check, changes close together, remove for good and stricter hiding rules.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type TestEngine, ask, createCollection, doc, learn, log, makeEngine, outboxEvents, startImport } from './helpers.ts'

const SIX_MINUTES = 6 * 60_000

/** Three restore points, far enough apart not to share one: v1 = docs 1-2, v2 = + doc 3, v3 = + doc 4. */
async function threeVersions(): Promise<TestEngine> {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(SIX_MINUTES)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(SIX_MINUTES)
  await learn(t, 'c1', 'imp-3', [doc(4)])
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.version, 3)
  return t
}

async function documentIds(t: TestEngine) {
  return (await t.api('GET', '/v1/collections/c1/documents')).body.documents.map((d: any) => d.documentId).sort()
}

async function snapshotOf(t: TestEngine, version: number) {
  return (await t.storage('c1').get<any>(`rp:${String(version).padStart(10, '0')}`)).snapshotId as string
}

test('HIS-01 go back checks the older point against its own manifest, sets later files aside, and undo restores everything', async () => {
  const t = await threeVersions()
  const before = { ids: await documentIds(t), counts: (await t.api('GET', '/v1/collections/c1')).body.counts }
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.deepEqual(points.map((p: any) => [p.version, p.current, p.restorable]), [[3, true, true], [2, false, true], [1, false, true]])

  const preview = (await t.api('GET', '/v1/collections/c1/restore-points/1/preview')).body
  assert.equal(preview.documents, 2)
  assert.deepEqual(preview.setAside.map((d: any) => d.name).sort(), ['doc-3.md', 'doc-4.md'])
  assert.equal(preview.restorable, true)

  // Corrupt the LATEST point's manifest: going back to version 1 must not depend on it.
  const latest = await snapshotOf(t, 3)
  const manifest = await t.object('c1').store.getManifest(latest)
  await t.object('c1').store.putManifest(latest, { ...manifest!, digest: 'not-the-latest' })

  const going = await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.equal(going.status, 200)
  assert.equal(going.body.state, 'going_back')
  const during = await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  assert.equal(during.body.status, 'busy')
  await t.drain('c1')
  const back = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(back.version, 4)
  assert.equal(back.counts.documents, 2, "counts equal that point's")
  assert.equal(t.cloud.starts.at(-1)!.snapshot, await snapshotOf(t, 1), 'started from version 1')
  const checked = (await log(t, 'c1')).filter((e: any) => e.event === 'checksum-ok').at(-1)
  assert.equal(checked.version, 1)
  assert.equal(checked.snapshot, await snapshotOf(t, 1), "the older point's checksums were checked")
  const nowPoints = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.equal(nowPoints[0].summary, 'Went back to version 1')
  const answer = await ask(t, 'c1', 'topic number 4 gateway port')
  assert.ok(!answer.body.passages.some((p: any) => p.text.includes('8004')), 'a set-aside file is not used')

  // Undo goes back to version 3, which is checked against its own manifest too: put the right one back.
  await t.object('c1').store.putManifest(latest, manifest!)
  t.advance(SIX_MINUTES)
  assert.equal((await t.api('POST', '/v1/collections/c1/undo')).status, 200)
  await t.drain('c1')
  const undone = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(undone.version, 5)
  assert.deepEqual(await documentIds(t), before.ids, 'undo: everything equals the state before')
  assert.deepEqual(undone.counts, before.counts)
  assert.match((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0].summary, /^Undid “Went back to version 1”/)
})

test("HIS-01 a point whose own manifest doesn't match is never opened", async () => {
  const t = await threeVersions()
  const old = await snapshotOf(t, 1)
  const manifest = await t.object('c1').store.getManifest(old)
  await t.object('c1').store.putManifest(old, { ...manifest!, digest: 'tampered' })
  await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  for (let i = 0; i < 4; i++) {
    await t.drain('c1')
    t.advance(5_000)
  }
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.version, 3, 'still at the latest version')
  assert.notEqual(status.state, 'going_back')
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'go-back-failed'))
  assert.equal((await log(t, 'c1')).filter((e: any) => e.event === 'checksum-mismatch' && e.version === 1).length, 2, 'checked twice, opened never')
  // Damaged: History stops offering it, and asking again is refused at once.
  const point = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.find((p: any) => p.version === 1)
  assert.deepEqual([point.restorable, point.reason], [false, 'damaged'])
  const again = await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.deepEqual([again.status, again.body.error], [409, 'not_restorable'])
  assert.match(again.body.message, /failed its check/)
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points/1/preview')).body.reason, 'damaged')
})

test('going back refuses while learning, to an unknown point, and to the current one is a no-op', async () => {
  const t = await threeVersions()
  assert.equal((await t.api('POST', '/v1/collections/c1/restore-points/9/go-back')).status, 404)
  assert.equal((await t.api('GET', '/v1/collections/c1/restore-points/9/preview')).status, 404)
  const same = await t.api('POST', '/v1/collections/c1/restore-points/3/go-back')
  assert.equal(same.status, 200)
  assert.equal(same.body.version, 3)
  t.cloud.jobPolls = 5
  t.advance(SIX_MINUTES)
  await startImport(t, 'c1', 'imp-busy', [doc(9)])
  await t.drain('c1', { steps: 2 })
  const refused = await t.api('POST', '/v1/collections/c1/restore-points/1/go-back')
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'busy_learning')
})

test('HIS-02 waking from the backup: the snapshot handle is gone, the backup brings everything back, and a new restore point exists', async () => {
  const t = await threeVersions()
  t.advance(11 * 60_000)
  await t.drain('c1') // sleeps, and the day's backup is written
  assert.ok((await t.api('GET', '/v1/collections/c1')).body.lastBackupAt)
  const before = await ask(t, 'c1', 'topic number 3 gateway port')
  const countsBefore = (await t.api('GET', '/v1/collections/c1')).body.counts
  t.advance(11 * 60_000)
  await t.drain('c1')

  await t.api('POST', '/v1/collections/c1/__test/drop-snapshot')
  const first = await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 3 gateway port' })
  assert.equal(first.body.status, 'waking')
  await t.drain('c1', { steps: 2 })
  const waking = (await t.api('GET', '/v1/collections/c1')).body
  assert.ok(['waking_from_backup', 'waking'].includes(waking.state), waking.state)
  const after = await ask(t, 'c1', 'topic number 3 gateway port')
  const texts = (res: any) => res.body.passages.map((p: any) => `${p.passageId} ${p.score} ${p.text}`).sort()
  assert.deepEqual(texts(after), texts(before), 'the answers are identical')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual(status.counts, countsBefore)
  assert.equal(status.version, 4, 'a new restore point')
  assert.match((await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0].summary, /^Came back from its backup of \d{4}-\d{2}-\d{2}$/)
  const point3 = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.find((p: any) => p.version === 3)
  assert.deepEqual([point3.restorable, point3.reason], [false, 'expired'])
})

test('HIS-03 after an engine image change the collection moves from its backup, and older points are unavailable', async () => {
  const t = await threeVersions()
  t.advance(11 * 60_000)
  await t.drain('c1')
  const before = await ask(t, 'c1', 'topic number 2 gateway port')
  t.advance(11 * 60_000)
  await t.drain('c1')
  t.cloud.image = 'registry.example/engine@2'
  const after = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.equal(after.body.status, 'ok')
  const ids = (res: any) => res.body.passages.map((p: any) => p.passageId).sort()
  assert.deepEqual(ids(after), ids(before))
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.equal(points[0].current, true)
  assert.equal(points[0].restorable, true)
  for (const p of points.slice(1)) assert.deepEqual([p.restorable, p.reason], [false, 'engine_changed'])
  assert.equal((await t.api('POST', '/v1/collections/c1/restore-points/2/go-back')).body.error, 'not_restorable')
})

test('an engine change with a new database format learns everything again from the stored text', async () => {
  const t = await threeVersions()
  t.advance(11 * 60_000)
  await t.drain('c1')
  t.cloud.image = 'registry.example/engine@3'
  t.cloud.dataFormat = 'fmt-2'
  const after = await ask(t, 'c1', 'topic number 2 gateway port')
  for (let i = 0; i < 3 && after.body.status !== 'ok'; i++) await t.drain('c1')
  const final = await ask(t, 'c1', 'topic number 2 gateway port')
  assert.equal(final.body.status, 'ok')
  assert.ok(final.body.passages.some((p: any) => p.text.includes('8002')))
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 4)
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'from-backup-relearn'))
})

test('HIS-04 a failed integrity check: one retry, then the previous restore point answers and the message names it', async () => {
  const t = await threeVersions()
  t.advance(11 * 60_000)
  await t.drain('c1')
  // No backup holds version 3 under this test: drop them, so the previous restore point is used.
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic' })
  let sawRepairing = false
  for (let i = 0; i < 30; i++) {
    await t.drain('c1', { steps: 1 })
    if ((await t.api('GET', '/v1/collections/c1')).body.state === 'repairing') sawRepairing = true
  }
  const mismatches = (await log(t, 'c1')).filter((e: any) => e.event === 'checksum-mismatch')
  assert.equal(mismatches.length, 2, 'one retry')
  assert.ok(sawRepairing)
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.equal(points.find((p: any) => p.version === 4).summary, 'Answering from version 2 after version 3 failed its check')
  // Then everything is learned again from the saved text, the file of version 3 included.
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.deepEqual([status.version, status.counts.documents], [5, 4])
  assert.ok((await outboxEvents(t)).some((e) => e.type === 'state' && e.state === 'repairing' && e.version === 2))
  // The version that failed twice is damaged: listed, not offered, refused.
  const failed = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.find((p: any) => p.version === 3)
  assert.deepEqual([failed.restorable, failed.reason], [false, 'damaged'])
  const refused = await t.api('POST', '/v1/collections/c1/restore-points/3/go-back')
  assert.deepEqual([refused.status, refused.body.error], [409, 'not_restorable'])
  const two = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.find((p: any) => p.version === 2)
  assert.equal(two.restorable, true, 'the point it answers from is fine')
})

test('damaged marks every restore point on the failed snapshot, and with nothing earlier the collection learns again from its text', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1), doc(2)])
  t.advance(SIX_MINUTES)
  // A change without new data: version 2 uses version 1's snapshot.
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents[1]
  await t.api('PATCH', `/v1/collections/c1/documents/${target.documentId}`, { active: false })
  t.advance(11 * 60_000)
  await t.drain('c1')
  for (const key of t.backups.keys()) await t.backups.delete(key)
  await t.api('POST', '/v1/collections/c1/__test/corrupt-manifest')
  await t.api('POST', '/v1/collections/c1/search', { query: 'topic number 1' })
  for (let i = 0; i < 8; i++) {
    await t.drain('c1')
    t.advance(60_000)
  }
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  for (const v of [1, 2]) assert.deepEqual([points.find((p: any) => p.version === v).reason], ['damaged'], `version ${v}`)
  assert.ok((await log(t, 'c1')).some((e: any) => e.event === 'repair-relearn'))
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.version, 3)
  assert.deepEqual([status.counts.documents, status.counts.activeDocuments], [2, 1], 'the stop-using choice survives')
  assert.deepEqual([points[0].restorable, points[0].summary], [true, 'Learned everything again from its saved text'])
  const answer = await ask(t, 'c1', 'topic number 1 gateway port')
  assert.ok(answer.body.passages.some((p: any) => p.text.includes('8001')))
})

test('HIS-05 changes close together share one restore point', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1)])
  t.advance(SIX_MINUTES)
  const before = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.length
  for (const n of [1, 2, 3]) {
    const res = await t.api('POST', '/v1/collections/c1/imports', {
      importId: `note-${n}`,
      files: [],
      notes: [{ noteId: `n${n}`, title: `Note ${n}`, text: `Note number ${n} about the gateway.`, outdated: [] }],
      small: true,
    })
    assert.equal(res.status, 202)
    await t.drain('c1')
    t.advance(60_000)
  }
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  assert.equal(points.length, before + 1, 'the count is one')
  assert.equal(points[0].summary, 'Added 3 notes')
  // Undo takes back all three at once.
  await t.api('POST', '/v1/collections/c1/undo')
  await t.drain('c1')
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 1)
})

test('HIS-07 remove for good: the text is gone from the engine and the latest backup, and earlier points are blocked', async () => {
  const t = await threeVersions()
  t.advance(11 * 60_000)
  await t.drain('c1') // a backup holding all four files
  const secret = 'Topic number 3 says the gateway port is 8003'
  assert.ok(t.backups.keys().some((k) => t.backups.text(k)?.includes(secret)))
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-3.md')

  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.version, 4)
  assert.deepEqual(removed.body.blockedRestorePoints, [2, 3])
  // At once: not listed, not readable, not found by questions, its text gone from R2.
  assert.equal((await t.api('GET', `/v1/collections/c1/documents/${target.documentId}`)).status, 404)
  assert.ok(!(await t.api('GET', '/v1/collections/c1/documents')).body.documents.some((d: any) => d.documentId === target.documentId))
  assert.ok(!t.files.keys('text/').some((k) => k.includes(target.documentId)))
  // Again: the same answer.
  assert.deepEqual((await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)).body, removed.body)

  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.version, 4)
  assert.equal(status.counts.documents, 3)
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  for (const v of [2, 3]) {
    const p = points.find((x: any) => x.version === v)
    assert.deepEqual([p.restorable, p.reason], [false, 'removed_for_good'])
    const refused = await t.api('POST', `/v1/collections/c1/restore-points/${v}/go-back`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'not_restorable')
  }
  assert.equal(points.find((x: any) => x.version === 1).restorable, true)
  for (const key of t.backups.keys()) assert.ok(!t.backups.text(key)!.includes(secret), `the backup no longer contains the text (${key})`)
  assert.ok(t.backups.keys().some((k) => k.endsWith('latest.json')), 'a new latest backup was written')
  const latest = JSON.parse(t.backups.text(t.backups.keys().find((k) => k.endsWith('latest.json'))!)!)
  assert.equal(latest.version, 4)
  const grep = (await t.api('POST', '/v1/collections/c1/__test/grep', { values: [secret] })).body
  assert.deepEqual(grep[secret], { container: 0, text: 0, backups: 0, exports: 0 })
  const answer = await ask(t, 'c1', 'topic number 3 gateway port 8003')
  assert.ok(!answer.body.passages.some((p: any) => p.text.includes('8003')))
})

test('a removal for good goes ahead of a running import, which starts over without losing a try', async () => {
  const t = await threeVersions()
  t.advance(SIX_MINUTES)
  t.cloud.jobPolls = 6
  await startImport(t, 'c1', 'imp-big', [doc(7), doc(8)])
  await t.drain('c1', { steps: 3 })
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-1.md')
  const removed = await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  assert.equal(removed.body.version, 4)
  t.cloud.jobPolls = 1
  await t.drain('c1')
  t.advance(60_000)
  await t.drain('c1')
  const removal = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints.find((p: any) => p.version === 4)
  assert.match(removal.summary, /Removed 1 file for good/)
  const big = (await t.api('GET', '/v1/collections/c1/imports/imp-big')).body
  assert.equal(big.state, 'committed')
  assert.equal(big.attempt, 1)
  assert.equal(big.version, 5)
  assert.equal((await t.api('GET', '/v1/collections/c1')).body.counts.documents, 5)
})

test('HID-04 a stricter rule re-reads old files in the background, hides the word, and blocks older points', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'The codename is Bluewater.'), doc(2)])
  t.advance(SIX_MINUTES)
  await learn(t, 'c1', 'imp-2', [doc(3)])
  t.advance(SIX_MINUTES)
  const put = await t.api('PUT', '/v1/collections/c1', {
    settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } },
  })
  assert.equal(put.status, 200)
  await t.drain('c1')
  const status = (await t.api('GET', '/v1/collections/c1')).body
  assert.equal(status.version, 3)
  const point = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0]
  assert.match(point.summary, /Read 1 file again with stricter hiding/)
  for (const key of t.files.keys('text/')) assert.ok(!t.files.text(key)!.includes('Bluewater'), key)
  const points = (await t.api('GET', '/v1/collections/c1/restore-points')).body.restorePoints
  for (const v of [1, 2]) assert.deepEqual([points.find((p: any) => p.version === v).reason], ['newly_hidden'])
  const usage = (await outboxEvents(t)).filter((e) => e.type === 'usage' && e.kind === 'learning')
  assert.ok(usage.length >= 3, 'the re-read counts as learning')
  // A rule made less strict doesn't re-read anything.
  const before = t.cloud.calls.filter((c) => c.detail === 'reread').length
  await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: false, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluewater'] } } })
  await t.drain('c1')
  assert.equal(t.cloud.calls.filter((c) => c.detail === 'reread').length, before)
})

test('HIS-07 remove for good also takes the document out of every stored facts file', async () => {
  const t = makeEngine()
  await createCollection(t)
  const secret = 'Project Kestrel pays the vendor 41000 dollars.'
  await learn(t, 'c1', 'imp-1', [doc(1), { fileId: 'f9', name: 'deal.md', text: `${secret}\n\nMore about the deal.` }])
  t.advance(SIX_MINUTES)
  await learn(t, 'c1', 'imp-2', [doc(2)])
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'deal.md')
  await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
  await t.drain('c1')
  assert.deepEqual(t.files.keys().filter((k) => t.files.text(k)!.includes('41000')), [])
})

test('an export being built when a file is removed for good does not keep the removed text', async () => {
  const t = await threeVersions()
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-3.md')
  const get = t.files.get.bind(t.files)
  let removed = false
  t.files.get = async (key: string) => {
    const object = await get(key)
    if (!removed && key.endsWith(`/docs/${target.documentId}.json`)) {
      // The export has read the text; the removal arrives before it finishes.
      removed = true
      await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
    }
    return object
  }
  await t.api('POST', '/v1/collections/c1/exports', { exportId: 'exp-1' })
  await t.drain('c1')
  t.files.get = get
  assert.ok(removed)
  const status = (await t.api('GET', '/v1/collections/c1/exports/exp-1')).body
  if (status.state === 'ready') {
    const zip = new TextDecoder('latin1').decode(new Uint8Array(await (await t.api('GET', '/v1/collections/c1/exports/exp-1?download=1')).response.arrayBuffer()))
    assert.ok(!zip.includes(target.documentId), 'the export holds nothing of the removed file')
  }
  for (const key of t.files.keys('exports/')) assert.ok(!t.files.text(key)!.includes(target.documentId))
})

test('a re-read finishing after a removal for good does not bring the removed text back', async () => {
  const t = await threeVersions()
  t.advance(SIX_MINUTES)
  const target = (await t.api('GET', '/v1/collections/c1/documents')).body.documents.find((d: any) => d.name === 'doc-1.md')
  const put = t.files.put.bind(t.files)
  let removed = false
  t.files.put = async (key: string, value: unknown, options?: any) => {
    const result = await put(key, value, options)
    if (!removed && key.includes(`/docs/${target.documentId}.json`)) {
      removed = true
      await t.api('DELETE', `/v1/collections/c1/documents/${target.documentId}`)
    }
    return result
  }
  await t.api('PUT', '/v1/collections/c1', { settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['gateway'] } } })
  await t.drain('c1')
  t.advance(60_000)
  await t.drain('c1')
  t.files.put = put
  assert.ok(removed)
  assert.ok(!t.files.keys('text/').some((k) => k.endsWith(`/docs/${target.documentId}.json`)), 'no text of the removed file in R2')
  assert.deepEqual(t.files.keys().filter((k) => t.files.text(k)!.includes('port is 8001')), [])
})

test('FIX-02 a re-read that changes a corrected passage asks for the correction to be checked; one that leaves it alone does not', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'Owner of the gateway is Morgan.'), doc(2)])
  t.advance(SIX_MINUTES)
  const found = await ask(t, 'c1', 'topic number 1 gateway port')
  const old = found.body.passages.find((p: any) => p.text.includes('8001'))
  await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n1', title: 'Port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [{ documentId: old.documentId, textHash: old.textHash }] },
  })
  await t.drain('c1')
  t.advance(SIX_MINUTES)
  const hiding = (words: string[]) => ({ settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words } } })
  // Unchanged: the word is only in another passage of the same file.
  await t.api('PUT', '/v1/collections/c1', hiding(['Morgan']))
  await t.drain('c1')
  assert.ok(!(await outboxEvents(t)).some((e) => e.type === 'needs_check'))
  assert.match((await ask(t, 'c1', 'topic number 1 gateway port')).body.passages[0].text, /9001/, 'the correction still applies')
  t.advance(SIX_MINUTES)
  // Changed: the corrected passage itself loses a word.
  await t.api('PUT', '/v1/collections/c1', hiding(['Morgan', 'gateway']))
  await t.drain('c1')
  const checks = (await outboxEvents(t)).filter((e) => e.type === 'needs_check')
  assert.equal(checks.length, 1)
  assert.deepEqual([checks[0].noteId, checks[0].documentId], ['n1', old.documentId])
  assert.equal(typeof checks[0].textHash, 'string')
})

test('F162 a needs_check says which hash the mark had before the re-read moved it, so each check replaces the one before', async () => {
  const t = makeEngine()
  await createCollection(t)
  await learn(t, 'c1', 'imp-1', [doc(1, 'Second paragraph.')])
  t.advance(SIX_MINUTES)
  const h0 = (await ask(t, 'c1', 'topic number 1 gateway port')).body.passages.find((p: any) => p.text.includes('8001'))
  await t.api('POST', '/v1/collections/c1/corrections', {
    importId: 'fix-1',
    note: { noteId: 'n1', title: 'Port', text: 'Topic number 1: the gateway port is now 9001.', outdated: [{ documentId: h0.documentId, textHash: h0.textHash }] },
  })
  await t.drain('c1')
  const hiding = (words: string[]) => ({ settings: { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words } } })
  const reread = async (words: string[]) => {
    t.advance(SIX_MINUTES)
    await t.api('PUT', '/v1/collections/c1', hiding(words))
    await t.drain('c1')
    return (await outboxEvents(t)).filter((e) => e.type === 'needs_check')
  }
  // H0 -> H1 -> H2: the corrected passage loses a word, then another.
  const first = await reread(['gateway'])
  assert.equal(first.length, 1)
  assert.equal(first[0].previousTextHash, h0.textHash)
  const h1 = first[0].textHash
  assert.notEqual(h1, h0.textHash)
  const second = await reread(['gateway', 'Topic'])
  assert.equal(second.length, 2)
  assert.deepEqual([second[1].previousTextHash, second[1].noteId, second[1].previousNoteId], [h1, 'n1', 'n1'], 'the second check replaces the first')
  assert.notEqual(second[1].textHash, h1)
})
