import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ORG_HEADER, type CollectionStatus, type ImportStatus, type OutboxPage, type RestorePoint } from '../../engine/src/contract.ts'
import { createStubEngine, STUB_MARKER } from '../../engine/src/stub/index.ts'
import { sha256Hex } from '../../engine/src/stub/text.ts'
import worker from '../../engine/src/stub/worker.ts'
import { readZip, writeZip, zipEntries, zipStats } from '../../engine/src/stub/zip.ts'

// The in-memory engine against the contract (knowledge/engine/src/contract.ts): every route answers in its shapes,
// organizations are kept apart, and it keeps the real engine's rules the app relies on.

const SETTINGS = { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] }, keepReady: null, awakeMinutes: 10 }

function engineFor(timing = {}) {
  let now = Date.UTC(2026, 10, 16, 9)
  const engine = createStubEngine({ now: () => now, timing })
  const call = async <T = any>(method: string, path: string, body?: unknown, org: string | null = 'org-a', headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...(org ? { [ORG_HEADER]: org } : {}), ...headers } }
    if (body instanceof Uint8Array) init.body = body as Uint8Array<ArrayBuffer>
    else if (body !== undefined) {
      init.body = JSON.stringify(body)
      ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
    }
    const response = await engine.fetch(new Request(`https://engine.test${path}`, init))
    const text = await response.text()
    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* a download */ }
    return { status: response.status, body: parsed as T, headers: response.headers }
  }
  const stage = async (cid: string, fileId: string, name: string, text: string, org = 'org-a') => {
    const bytes = new TextEncoder().encode(text)
    return call('PUT', `/v1/collections/${cid}/inbox/${fileId}`, bytes, org, { 'content-type': 'text/markdown', 'x-file-name': encodeURIComponent(name), 'x-file-sha256': sha256Hex(bytes) })
  }
  const learn = async (cid: string, importId: string, files: { fileId: string; name: string; text: string }[], org = 'org-a') => {
    for (const file of files) await stage(cid, file.fileId, file.name, file.text, org)
    return call<ImportStatus>('POST', `/v1/collections/${cid}/imports`, {
      importId, small: false, notes: [],
      files: files.map((file) => ({ fileId: file.fileId, name: file.name, type: 'text/markdown', bytes: file.text.length, sha256: sha256Hex(file.text) })),
    }, org)
  }
  return { engine, call, stage, learn, advance: (ms: number) => { now += ms } }
}

describe('the in-memory engine', () => {
  it('serves every route of the contract', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    // BUILD.md's table of the contract's routes, each with a request it can answer or refuse in its own words.
    const routes: [string, string, unknown?][] = [
      ['PUT', '/v1/collections/c1', { settings: SETTINGS }], ['GET', '/v1/collections/c1'], ['POST', '/v1/collections/c1/wake'],
      ['PUT', '/v1/collections/c1/inbox/file0001', new TextEncoder().encode('x')], ['POST', '/v1/collections/c1/inbox/keep', {}], ['POST', '/v1/collections/c1/imports', {}],
      ['GET', '/v1/collections/c1/imports/i1'], ['DELETE', '/v1/collections/c1/imports/i1'], ['POST', '/v1/collections/c1/search', { query: 'x' }], ['POST', '/v1/answer', { question: 'x', passages: [] }],
      ['GET', '/v1/collections/c1/documents'], ['GET', '/v1/collections/c1/documents/d1'], ['PATCH', '/v1/collections/c1/documents/d1', { active: false }],
      ['DELETE', '/v1/collections/c1/documents/d1'], ['GET', '/v1/collections/c1/facts?cursor='], ['POST', '/v1/collections/c1/corrections', {}],
      ['GET', '/v1/collections/c1/restore-points'], ['GET', '/v1/collections/c1/restore-points/1/preview'], ['POST', '/v1/collections/c1/restore-points/1/go-back'],
      ['POST', '/v1/collections/c1/undo'], ['POST', '/v1/collections/c1/exports', { exportId: 'e1' }], ['GET', '/v1/collections/c1/exports/e1'],
      ['POST', '/v1/collections/c1/import-export', {}], ['GET', '/v1/outbox?since=&limit=10'], ['GET', '/v1/health'], ['POST', '/v1/orgs/org-a/hold', { until: null, version: 1 }], ['POST', '/v1/orgs/org-a/purge'], ['DELETE', '/v1/collections/c1'],
    ]
    for (const [method, path, body] of routes) {
      const answer = await call(method, path, body)
      expect({ method, path, routed: answer.body?.message !== 'There is no such route.' }).toEqual({ method, path, routed: true })
      expect(answer.status === 200 || answer.status === 202 || typeof answer.body?.error === 'string').toBe(true)
    }
    expect((await call('GET', '/v1/nothing')).status).toBe(404)
  })

  it('needs the organization header and keeps organizations apart (404, as for an unknown id)', async () => {
    const { call } = engineFor()
    expect((await call('PUT', '/v1/collections/c1', { settings: SETTINGS }, null)).status).toBe(400)
    expect((await call<CollectionStatus>('PUT', '/v1/collections/c1', { settings: SETTINGS })).body).toMatchObject({ collectionId: 'c1', state: 'empty', version: 0 })
    const theirs = await call('GET', '/v1/collections/c1', undefined, 'org-b')
    const unknown = await call('GET', '/v1/collections/nope', undefined, 'org-b')
    expect(theirs).toMatchObject({ status: 404, body: { error: 'not_found' } })
    expect(theirs.body).toEqual(unknown.body)
    expect((await call('PUT', '/v1/collections/c1', { settings: SETTINGS }, 'org-b')).status).toBe(404)
  })

  it('learns all or nothing: committed with a restore point, already here, interrupted and retried, failed after 3 tries', async () => {
    const { call, learn, engine, advance } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const first = await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Rules.md', text: 'Partner discounts stop at 20 percent.' }])
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ state: 'committed', version: 1, files: [{ state: 'learned' }] })
    expect((await learn('c1', 'imp1', [])).status).toBe(200)
    const same = await learn('c1', 'imp2', [{ fileId: 'file0002', name: 'Copy.md', text: 'Partner discounts stop at 20 percent.' }])
    expect(same.body).toMatchObject({ state: 'duplicate', version: null, files: [{ state: 'already_here' }] })
    engine.control.failNextImport({ collectionId: 'c1', times: 1 })
    // Interrupted, it is tried again in place, as the real engine does: still the running import, so not cancellable.
    const interrupted = await learn('c1', 'imp3', [{ fileId: 'file0003', name: 'More.md', text: 'Gold partners get a named contact.' }])
    expect(interrupted.body).toMatchObject({ state: 'interrupted', attempt: 2, version: null })
    expect((await call('DELETE', '/v1/collections/c1/imports/imp3')).body).toMatchObject({ error: 'busy_learning' })
    advance(15_000)
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp3')).body).toMatchObject({ state: 'committed', attempt: 2, version: 2 })
    engine.control.failNextImport({ collectionId: 'c1', times: 3, fileName: 'Deck.md' })
    await learn('c1', 'imp4', [{ fileId: 'file0004', name: 'Notes.md', text: 'Silver partners renew in June.' }, { fileId: 'file0005', name: 'Deck.md', text: 'Bronze partners renew in May.' }])
    engine.control.runUntilIdle()
    const failed = await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp4')
    expect(failed.body).toMatchObject({ state: 'failed', attempt: 3, failedFileId: 'file0005', version: null })
    expect(failed.body.files.find((file) => file.fileId === 'file0005')).toMatchObject({ state: 'failed', reason: 'Couldn\'t learn “Deck.md” after 3 tries.' })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body).toMatchObject({ version: 2, counts: { documents: 2 } })
    // The app hears each try start and each interruption, as from the real engine.
    const outbox = await call<OutboxPage>('GET', '/v1/outbox?limit=500', undefined, null)
    expect(outbox.body.events.filter((event) => event.type === 'import' && event.import.importId === 'imp4').map((event) => (event as { import: ImportStatus }).import.state))
      .toEqual(['learning', 'interrupted', 'learning', 'interrupted', 'learning', 'failed'])
  })

  it('refuses a scanned PDF and a type it can\'t read, failing closed with the reason', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const pdf = new TextEncoder().encode('%PDF-1.4\n/Type /Page /XObject << >>\n%%EOF')
    await call('PUT', '/v1/collections/c1/inbox/scan0001', pdf, 'org-a', { 'content-type': 'application/pdf', 'x-file-name': 'Scan.pdf', 'x-file-sha256': sha256Hex(pdf) })
    const result = await call<ImportStatus>('POST', '/v1/collections/c1/imports', { importId: 'imp1', small: false, notes: [], files: [{ fileId: 'scan0001', name: 'Scan.pdf', type: 'application/pdf', bytes: pdf.length, sha256: sha256Hex(pdf) }] })
    expect(result.body).toMatchObject({ state: 'failed', failedFileId: 'scan0001', files: [{ state: 'failed', reason: '“Scan.pdf” is a scanned image with no text. Upload a PDF with text, or a Word file.' }] })
    expect((await call('PUT', '/v1/collections/c1/inbox/bad00001', pdf, 'org-a', { 'x-file-name': 'x', 'x-file-sha256': '0'.repeat(64) })).status).toBe(400)
  })

  it('answers search at once while waking or learning, and covers only above the threshold', async () => {
    const { call, learn, engine, advance } = engineFor({ wakeMs: 5000 })
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Rules.md', text: 'Partner discounts stop at 20 percent.\n\nGold partners get a named contact.' }])
    const found = await call('POST', '/v1/collections/c1/search', { query: 'Where do partner discounts stop?' })
    expect(found.body).toMatchObject({ status: 'ok', covered: true })
    expect(found.body.passages[0]).toMatchObject({ documentName: 'Rules.md', start: 0, text: 'Partner discounts stop at 20 percent.', textHash: sha256Hex('Partner discounts stop at 20 percent.') })
    expect((await call('POST', '/v1/collections/c1/search', { query: 'office parking rules' })).body).toMatchObject({ status: 'ok', covered: false })
    advance(11 * 60_000)
    expect((await call('POST', '/v1/collections/c1/search', { query: 'discounts' })).body).toMatchObject({ status: 'waking', retryAfterSeconds: 5 })
    advance(5000)
    expect((await call('POST', '/v1/collections/c1/search', { query: 'discounts' })).body.status).toBe('ok')
    engine.control.hold(true)
    await call('POST', '/v1/collections/c1/imports', { importId: 'imp2', small: true, files: [], notes: [{ noteId: 'n1', title: 'Note', text: 'A held note.', outdated: [] }] })
    expect((await call('POST', '/v1/collections/c1/search', { query: 'discounts' })).body.status).toBe('learning')
    expect((await call('GET', '/v1/collections/c1')).body.state).toBe('learning')
  })

  it('goes back, undoes, and can\'t bring back a version that held a file removed for good', async () => {
    const { call, learn, advance } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'One.md', text: 'The first rule.' }])
    advance(6 * 60_000)
    await learn('c1', 'imp2', [{ fileId: 'file0002', name: 'Two.md', text: 'The second rule.' }])
    const preview = await call('GET', '/v1/collections/c1/restore-points/1/preview')
    expect(preview.body).toMatchObject({ version: 1, documents: 1, setAside: [{ name: 'Two.md' }], restorable: true })
    expect((await call<CollectionStatus>('POST', '/v1/collections/c1/restore-points/1/go-back')).body).toMatchObject({ version: 3, counts: { documents: 2, activeDocuments: 1 } })
    // Undo goes back to the version before the current change: here, the one before going back.
    expect((await call<CollectionStatus>('POST', '/v1/collections/c1/undo')).body).toMatchObject({ version: 4, counts: { activeDocuments: 2 } })
    const listed = await call<{ restorePoints: RestorePoint[] }>('GET', '/v1/collections/c1/restore-points')
    expect(listed.body.restorePoints.map((point) => point.summary)).toEqual(['Undid “Went back to version 1”', 'Went back to version 1', 'Added 1 file', 'Added 1 file'])
    const documents = await call<{ documents: { documentId: string; name: string }[] }>('GET', '/v1/collections/c1/documents')
    const two = documents.body.documents.find((document) => document.name === 'Two.md')!
    // The removal's version is promised now and its commit comes through the outbox.
    const removed = await call('DELETE', `/v1/collections/c1/documents/${two.documentId}`)
    expect(removed.body).toEqual({ version: 5, blockedRestorePoints: [2, 3, 4] })
    const outbox = await call<OutboxPage>('GET', '/v1/outbox?limit=500', undefined, null)
    expect(outbox.body.events.filter((event) => event.type === 'committed').at(-1)).toMatchObject({ version: 5, importId: `rm-${two.documentId}-5` })
    const points = await call<{ restorePoints: RestorePoint[] }>('GET', '/v1/collections/c1/restore-points')
    expect(points.body.restorePoints.find((point) => point.version === 2)).toMatchObject({ restorable: false, reason: 'removed_for_good' })
    expect((await call('POST', '/v1/collections/c1/restore-points/2/go-back')).body).toMatchObject({ error: 'not_restorable' })
    expect((await call('POST', '/v1/collections/c1/restore-points/2/go-back')).status).toBe(409)
  })

  it('corrections mark passages outdated, by document and text hash, and rank first', async () => {
    const { call, learn, advance } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Rules.md', text: 'Partner discounts stop at 20 percent.' }])
    advance(6 * 60_000)
    const old = (await call('POST', '/v1/collections/c1/search', { query: 'partner discounts stop' })).body.passages[0]
    const corrected = await call<ImportStatus>('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'fix1', title: 'Correction', text: 'Partner discounts stop at 15 percent.', outdated: [{ documentId: old.documentId, textHash: old.textHash }] } })
    expect(corrected.body).toMatchObject({ state: 'committed', notes: 1 })
    const after = await call('POST', '/v1/collections/c1/search', { query: 'partner discounts stop' })
    expect(after.body.passages.map((passage: { kind: string }) => passage.kind)).toEqual(['note'])
    expect((await call<{ restorePoints: RestorePoint[] }>('GET', '/v1/collections/c1/restore-points')).body.restorePoints[0]!.summary).toBe('Correction')
  })

  it('exports, deletes, purges, and writes an outbox that pages by cursor', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await call('PUT', '/v1/collections/c2', { settings: SETTINGS })
    await call('PUT', '/v1/collections/c3', { settings: SETTINGS }, 'org-b')
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Rules.md', text: 'Write to partners@example.com about discounts.' }])
    const made = await call('POST', '/v1/collections/c1/exports', { exportId: 'exp1' })
    expect(made.body).toMatchObject({ exportId: 'exp1', state: 'ready' })
    const file = await engine.fetch(new Request('https://engine.test/v1/collections/c1/exports/exp1?download=1', { headers: { [ORG_HEADER]: 'org-a' } }))
    expect(file.headers.get('content-disposition')).toMatch(/attachment/)
    const entries = (await readZip(new Uint8Array(await file.arrayBuffer())))!
    const texts = [...entries.values()].map((bytes) => new TextDecoder().decode(bytes)).join('\n')
    expect(texts).toContain('[hidden]')
    expect(texts).not.toContain('partners@example.com')
    expect((await call('DELETE', '/v1/collections/c1')).status).toBe(202)
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.state).toBe('deleted')
    expect((await call('POST', '/v1/collections/c1/search', { query: 'x' })).body).toMatchObject({ error: 'deleting' })
    expect((await call('POST', '/v1/orgs/org-a/purge')).status).toBe(202)
    expect((await call<CollectionStatus>('GET', '/v1/collections/c2')).body.state).toBe('deleted')
    expect((await call<CollectionStatus>('GET', '/v1/collections/c3', undefined, 'org-b')).body.state).toBe('empty')
    const page = await call<OutboxPage>('GET', '/v1/outbox?limit=2', undefined, null)
    expect(page.body.events).toHaveLength(2)
    expect(page.body.more).toBe(true)
    const rest = await call<OutboxPage>(`GET`, `/v1/outbox?since=${page.body.cursor}&limit=500`, undefined, null)
    expect(rest.body.events.filter((event) => event.type === 'deleted').map((event) => event.collectionId)).toEqual(['c1', 'c2'])
    expect((await call('GET', '/v1/health', undefined, null)).body).toMatchObject({ collections: 1 })
  })

  it('keeps imports to 2 per organization, smaller ones first', async () => {
    const { call, learn, advance } = engineFor({ importMs: 1000 })
    for (const cid of ['c1', 'c2', 'c3']) await call('PUT', `/v1/collections/${cid}`, { settings: SETTINGS })
    await learn('c1', 'i1', [{ fileId: 'file0001', name: 'A.md', text: 'Alpha rule.' }])
    await learn('c2', 'i2', [{ fileId: 'file0002', name: 'B.md', text: 'Beta rule.' }])
    const third = await learn('c3', 'i3', [{ fileId: 'file0003', name: 'C.md', text: 'Gamma rule.' }])
    expect(third.body).toMatchObject({ state: 'queued', waitingFor: 'organization', queuePosition: 1 })
    advance(1000)
    expect((await call<ImportStatus>('GET', '/v1/collections/c3/imports/i3')).body.state).toBe('learning')
  })

  it('computes SHA-256 as Web Crypto does, and its Worker serves the control interface', async () => {
    for (const text of ['', 'abc', 'x'.repeat(1000), 'Unicode “quotes” and é'])
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
    const control = await worker.fetch(new Request('https://engine.test/__control/state'), {})
    expect(await control.json()).toEqual({ collections: [], outbox: 0 })
    expect(STUB_MARKER).toBe('insulin-knowledge-in-memory-engine')
  })
})

describe('the in-memory engine, as the real engine behaves', () => {
  it('folds changes within 5 minutes into one restore point; undo takes both back', async () => {
    const { call, learn, advance } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'One.md', text: 'The first rule.' }])
    advance(6 * 60_000)
    await learn('c1', 'imp2', [{ fileId: 'file0002', name: 'Two.md', text: 'The second rule.' }])
    advance(60_000)
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'fix1', title: 'Correction', text: 'The second rule changed.', outdated: [] } })
    const points = await call<{ restorePoints: RestorePoint[] }>('GET', '/v1/collections/c1/restore-points')
    // Version 2 folded into 3: no longer listed, and can't be previewed or gone back to.
    expect(points.body.restorePoints.map((point) => [point.version, point.summary])).toEqual([[3, 'Added 1 file, Correction'], [1, 'Added 1 file']])
    expect((await call('GET', '/v1/collections/c1/restore-points/2/preview')).status).toBe(404)
    expect((await call<CollectionStatus>('POST', '/v1/collections/c1/undo')).body).toMatchObject({ version: 4, counts: { activeDocuments: 1 } })
    const outbox = await call<OutboxPage>('GET', '/v1/outbox?limit=500', undefined, null)
    const committed = outbox.body.events.filter((event) => event.type === 'committed') as { version: number; importId: string | null }[]
    expect(committed.map((event) => [event.version, event.importId])).toEqual([[1, 'imp1'], [2, 'imp2'], [3, 'fix1'], [4, null]])
    expect((await call('POST', '/v1/collections/c1/undo')).body).toMatchObject({ version: 5 })
  })

  it('stop using commits at once, answers duplicate when nothing changes, and waits while a removal is pending', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'One.md', text: 'The first rule.' }, { fileId: 'file0002', name: 'Two.md', text: 'The second rule.' }])
    const documents = (await call<{ documents: { documentId: string; name: string }[] }>('GET', '/v1/collections/c1/documents')).body.documents
    const [one, two] = [documents.find((d) => d.name === 'One.md')!, documents.find((d) => d.name === 'Two.md')!]
    expect((await call<ImportStatus>('PATCH', `/v1/collections/c1/documents/${one.documentId}`, { active: false })).body).toMatchObject({ state: 'committed', version: 2 })
    expect((await call<ImportStatus>('PATCH', `/v1/collections/c1/documents/${one.documentId}`, { active: false })).body).toMatchObject({ state: 'duplicate', version: 2 })
    engine.control.hold(true)
    expect((await call('DELETE', `/v1/collections/c1/documents/${two.documentId}`)).body).toEqual({ version: 3, blockedRestorePoints: [2] })
    expect((await call('DELETE', `/v1/collections/c1/documents/${two.documentId}`)).body).toEqual({ version: 3, blockedRestorePoints: [2] })
    expect((await call('PATCH', `/v1/collections/c1/documents/${one.documentId}`, { active: true })).body).toMatchObject({ error: 'busy_learning' })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body).toMatchObject({ state: 'learning', version: 2 })
    engine.control.hold(false)
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.version).toBe(3)
  })

  it('stages without a SHA-256 (it computes it), refuses more than 64 MB, and answers a finished delete with deleted', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const staged = await call('PUT', '/v1/collections/c1/inbox/file0001', new TextEncoder().encode('hello'), 'org-a', { 'x-file-name': 'a.txt' })
    expect(staged.body).toEqual({ fileId: 'file0001', bytes: 5, sha256: sha256Hex('hello') })
    expect((await call('PUT', '/v1/collections/c1/inbox/file0002', new Uint8Array(64 * 1024 * 1024 + 1), 'org-a', { 'x-file-name': 'big.txt' })).status).toBe(413)
    expect((await call('DELETE', '/v1/collections/c1')).body).toEqual({ state: 'deleting' })
    expect((await call('DELETE', '/v1/collections/c1')).body).toEqual({ state: 'deleted' })
  })

  it('marks a restore point damaged through the control interface', async () => {
    const { call, learn, engine, advance } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'One.md', text: 'The first rule.' }])
    advance(6 * 60_000)
    await learn('c1', 'imp2', [{ fileId: 'file0002', name: 'Two.md', text: 'The second rule.' }])
    engine.control.damage('org-a', 'c1', 1)
    const points = await call<{ restorePoints: RestorePoint[] }>('GET', '/v1/collections/c1/restore-points')
    expect(points.body.restorePoints.find((point) => point.version === 1)).toMatchObject({ restorable: false, reason: 'damaged' })
    expect((await call('POST', '/v1/collections/c1/restore-points/1/go-back')).status).toBe(409)
    const http = await worker.fetch(new Request('https://engine.test/__control/damage', { method: 'POST', body: JSON.stringify({ org: 'org-a', collectionId: 'nope', version: 1 }) }), {})
    expect(http.status).toBe(400)
  })

  it('numbers outbox events as the cursor that continues after them', async () => {
    const { call, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    for (let index = 0; index < 3; index += 1) engine.control.addUsage('org-a', 'c1', 'awake', 60)
    const first = await call<OutboxPage>('GET', '/v1/outbox?since=&limit=2', undefined, null)
    expect(first.body.events.map((event) => event.id)).toEqual(['000000000001', '000000000002'])
    expect(first.body.cursor).toBe('000000000002')
    const next = await call<OutboxPage>('GET', `/v1/outbox?since=${first.body.events[0]!.id}&limit=10`, undefined, null)
    expect(next.body.events.map((event) => event.id)).toEqual(['000000000002', '000000000003'])
  })

  it('refuses the settings the real engine refuses', async () => {
    const { call } = engineFor()
    for (const settings of [
      { ...SETTINGS, backupDays: 0 }, { ...SETTINGS, backupDays: 3651 }, { ...SETTINGS, awakeMinutes: 0 }, { ...SETTINGS, awakeMinutes: 61 },
      { ...SETTINGS, hiding: { ...SETTINGS.hiding, words: ['x'.repeat(101)] } }, { ...SETTINGS, keepReady: { timeZone: 'Europe/Berlin', days: [1], start: '9am', hours: 1, paused: false } },
      { ...SETTINGS, keepReady: { timeZone: 'Nowhere/Else', days: [1], start: '09:00', hours: 1, paused: false } }, { ...SETTINGS, revision: -1 },
    ]) {
      expect((await call('PUT', '/v1/collections/c1', { settings })).status).toBe(400)
    }
    expect((await call('PUT', '/v1/collections/c1', { settings: { ...SETTINGS, backupDays: 3650 } })).status).toBe(200)
  })

  it('keeps the newest settings: an older revision is refused, the same one again changes nothing', async () => {
    const { call } = engineFor()
    expect((await call<CollectionStatus>('PUT', '/v1/collections/c1', { settings: { ...SETTINGS, awakeMinutes: 20, revision: 2 } })).body.settings.awakeMinutes).toBe(20)
    const older = await call<{ error: string }>('PUT', '/v1/collections/c1', { settings: { ...SETTINGS, awakeMinutes: 30, revision: 1 } })
    expect(older.status).toBe(409)
    expect(older.body.error).toBe('stale_settings')
    expect((await call<CollectionStatus>('PUT', '/v1/collections/c1', { settings: { ...SETTINGS, awakeMinutes: 40, revision: 2 } })).body.settings.awakeMinutes).toBe(20)
    expect((await call<CollectionStatus>('PUT', '/v1/collections/c1', { settings: { ...SETTINGS, awakeMinutes: 50, revision: 3 } })).body.settings.awakeMinutes).toBe(50)
  })

  it('holds an organization as the contract says: removing for good and stop using go ahead, running work stops and waits, and letting go starts it again', async () => {
    const { call, learn, engine, advance } = engineFor({ importMs: 60_000 })
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'One.md', text: 'The first rule.' }])
    engine.control.runUntilIdle()
    await learn('c1', 'imp2', [{ fileId: 'file0002', name: 'Two.md', text: 'The second rule.' }])
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp2')).body.state).toBe('learning')
    expect((await call('POST', '/v1/orgs/org-b/hold', { until: '2026-12-01T00:00:00Z' })).status).toBe(404)
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: 'soon' })).status).toBe(400)
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: '2026-12-01T00:00:00Z', version: 1 })).body).toEqual({ held: true, until: '2026-12-01T00:00:00.000Z' })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.state).toBe('held')
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp2')).body.state).toBe('queued')
    const page = await call<OutboxPage>('GET', '/v1/outbox?since=&limit=100', undefined, null)
    // As the real engine: the app hears it went back to the queue.
    expect(page.body.events.filter((event) => event.type === 'import' && event.import.importId === 'imp2').map((event) => (event as { import: ImportStatus }).import.state)).toEqual(['learning', 'queued'])
    expect((await call<{ status: string }>('POST', '/v1/collections/c1/search', { query: 'first rule' })).body.status).toBe('held')
    expect((await call<CollectionStatus>('POST', '/v1/collections/c1/wake')).body.state).toBe('held')
    expect((await call('POST', '/v1/collections/c1/exports', { exportId: 'e1' })).status).toBe(429)
    expect((await call('POST', '/v1/collections/c1/undo')).status).toBe(429)
    // Stop using needs no container: it commits at once, held or not.
    const listed = await call<{ documents: { documentId: string }[] }>('GET', '/v1/collections/c1/documents')
    expect((await call<ImportStatus>('PATCH', `/v1/collections/c1/documents/${listed.body.documents[0]!.documentId}`, { active: false })).body.state).toBe('committed')
    expect((await call<ImportStatus>('PATCH', `/v1/collections/c1/documents/${listed.body.documents[0]!.documentId}`, { active: true })).body.state).toBe('committed')
    engine.control.runUntilIdle()
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp2')).body.state).toBe('queued')
    const documents = await call<{ documents: { documentId: string }[] }>('GET', '/v1/collections/c1/documents')
    expect((await call('DELETE', `/v1/collections/c1/documents/${documents.body.documents[0]!.documentId}`)).status).toBe(200)
    engine.control.runUntilIdle()
    expect((await call<{ documents: unknown[] }>('GET', '/v1/collections/c1/documents')).body.documents).toHaveLength(0)
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: null, version: 2 })).body).toEqual({ held: false, until: null })
    advance(1)
    engine.control.runUntilIdle()
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp2')).body.state).toBe('committed')
    // A hold ends by itself at its time.
    await call('POST', '/v1/orgs/org-a/hold', { until: new Date(Date.UTC(2026, 10, 16, 10)).toISOString(), version: 3 })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.state).toBe('held')
    advance(2 * 60 * 60 * 1000)
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.state).not.toBe('held')
  })

  it('exports a zip laid out as the real engine\'s, and starts an empty collection from it with its stopped sources and corrections', async () => {
    const { call, learn, engine, stage } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Tiers.md', text: 'Gold partners renew every March.' }, { fileId: 'file0002', name: 'Old.md', text: 'Silver partners renew every June.' }])
    engine.control.runUntilIdle()
    const documents = (await call<{ documents: { documentId: string; name: string }[] }>('GET', '/v1/collections/c1/documents')).body.documents
    await call('PATCH', `/v1/collections/c1/documents/${documents.find((document) => document.name === 'Old.md')!.documentId}`, { active: false })
    const found = await call<{ passages: { documentId: string; textHash: string }[] }>('POST', '/v1/collections/c1/search', { query: 'gold partners renew' })
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'n1', title: 'Correction', text: 'Gold partners renew every April.', outdated: [found.body.passages[0]] } })
    engine.control.runUntilIdle()
    await call('POST', '/v1/collections/c1/exports', { exportId: 'e1' })
    const download = await engine.fetch(new Request('https://engine.test/v1/collections/c1/exports/e1?download=1', { headers: { [ORG_HEADER]: 'org-a' } }))
    expect(download.headers.get('content-type')).toBe('application/zip')
    const zip = new Uint8Array(await download.arrayBuffer())
    const names = new TextDecoder().decode(zip)
    for (const entry of ['README.txt', 'collection.json', 'notes.json', 'facts.json', 'corrections.json', 'history.json', `documents/${documents[0]!.documentId}.json`]) expect(names).toContain(entry)
    // The real engine's reader takes it: the same layout, ids, notes and marks. (Loaded by its address: it is the
    // engine's code, checked by the engine's own settings, not the app's.)
    const reader = new URL('../../engine/src/exportfile.ts', import.meta.url).href
    const { openExport } = (await import(/* @vite-ignore */ reader)) as { openExport: (bytes: Uint8Array) => Promise<{ documents: { info: { name: string } }[]; marks: unknown[] } | null> }
    const real = await openExport(zip)
    expect(real?.documents.map((document) => document.info.name).sort()).toEqual(['Correction', 'Old.md', 'Tiers.md'])
    expect(real?.marks).toHaveLength(1)

    await call('PUT', '/v1/collections/c2', { settings: SETTINGS })
    await call('PUT', '/v1/collections/c2/inbox/file0009', zip, 'org-a', { 'content-type': 'application/zip', 'x-file-name': 'export.zip' })
    const started = await call<ImportStatus>('POST', '/v1/collections/c2/import-export', { importId: 'restore1', fileId: 'file0009', sha256: sha256Hex(zip) })
    expect(started.status).toBe(202)
    engine.control.runUntilIdle()
    expect((await call<ImportStatus>('GET', '/v1/collections/c2/imports/restore1')).body.state).toBe('committed')
    const shape = async (cid: string) => (await call<{ documents: { name: string; active: boolean; kind: string }[] }>('GET', `/v1/collections/${cid}/documents`)).body.documents
      .map(({ name, active, kind }) => ({ name, active, kind })).sort((a, b) => a.name.localeCompare(b.name))
    expect(await shape('c2')).toEqual(await shape('c1'))
    const passages = async (cid: string) => (await call<{ passages: { text: string }[] }>('POST', `/v1/collections/${cid}/search`, { query: 'gold partners renew' })).body.passages.map((passage) => passage.text)
    expect(await passages('c2')).toEqual(await passages('c1'))
    expect((await call<CollectionStatus>('GET', '/v1/collections/c2')).body.counts).toEqual((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.counts)
    expect((await call<{ restorePoints: unknown[] }>('GET', '/v1/collections/c2/restore-points')).body.restorePoints).toHaveLength(1)
    // Only into an empty collection, and only a Knowledge export.
    await call('PUT', '/v1/collections/c1/inbox/file0010', zip, 'org-a', { 'content-type': 'application/zip' })
    expect((await call<{ error: string }>('POST', '/v1/collections/c1/import-export', { importId: 'restore2', fileId: 'file0010', sha256: sha256Hex(zip) })).status).toBe(409)
    await call('PUT', '/v1/collections/c3', { settings: SETTINGS })
    await stage('c3', 'file0011', 'notes.md', '# not an export')
    const wrong = await call<{ error: string }>('POST', '/v1/collections/c3/import-export', { importId: 'restore3', fileId: 'file0011', sha256: sha256Hex('# not an export') })
    expect(wrong.status).toBe(409)
    expect(wrong.body.error).toBe('bad_request')
    // A zip with an export's files but a document id the real engine wouldn't read is refused the same way.
    const odd = await writeZip([['README.txt', 'x'], ['collection.json', '{"collectionId":"c1","version":1}'], ['notes.json', '{"notes":[]}'], ['corrections.json', '{"corrections":[]}'],
      ['documents/doc-1.json', '{"document":{"documentId":"doc-1","kind":"file","name":"a.md","type":"text/markdown","bytes":1,"pages":null,"sha256":"x","active":true}}'], ['documents/doc-1.txt', 'a']])
    await call('PUT', '/v1/collections/c3/inbox/file0012', odd, 'org-a', { 'content-type': 'application/zip' })
    expect((await call('POST', '/v1/collections/c3/import-export', { importId: 'restore4', fileId: 'file0012', sha256: sha256Hex(odd) })).status).toBe(409)
  })

  it('a queued export learns with the hiding rules in force when it learns, and keeps corrected passages corrected', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Ports.md', text: 'The Cobalt gateway listens on port 8001.' }])
    engine.control.runUntilIdle()
    const found = await call<{ passages: { documentId: string; textHash: string }[] }>('POST', '/v1/collections/c1/search', { query: 'Cobalt gateway port' })
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'n1', title: 'Correction', text: 'The gateway listens on port 9001 now.', outdated: [found.body.passages[0]] } })
    engine.control.runUntilIdle()
    await call('POST', '/v1/collections/c1/exports', { exportId: 'e1' })
    const zip = new Uint8Array(await (await engine.fetch(new Request('https://engine.test/v1/collections/c1/exports/e1?download=1', { headers: { [ORG_HEADER]: 'org-a' } }))).arrayBuffer())
    // Queued while the organization is held; the rules get stricter before it learns.
    await call('PUT', '/v1/collections/c2', { settings: SETTINGS })
    await call('POST', '/v1/orgs/org-a/hold', { until: '2026-12-01T00:00:00Z', version: 1 })
    await call('PUT', '/v1/collections/c2/inbox/file0009', zip, 'org-a', { 'content-type': 'application/zip' })
    expect((await call('POST', '/v1/collections/c2/import-export', { importId: 'restore1', fileId: 'file0009', sha256: sha256Hex(zip) })).status).toBe(202)
    await call('PUT', '/v1/collections/c2', { settings: { ...SETTINGS, hiding: { ...SETTINGS.hiding, words: ['Cobalt', '8001'] }, revision: 5 } })
    await call('POST', '/v1/orgs/org-a/hold', { until: null, version: 2 })
    engine.control.runUntilIdle()
    expect((await call<ImportStatus>('GET', '/v1/collections/c2/imports/restore1')).body.state).toBe('committed')
    const documents = (await call<{ documents: { documentId: string; name: string }[] }>('GET', '/v1/collections/c2/documents')).body.documents
    const ports = await call<{ text: string }>('GET', `/v1/collections/c2/documents/${documents.find((document) => document.name === 'Ports.md')!.documentId}`)
    expect(ports.body.text).toBe('The [hidden] gateway listens on port [hidden].')
    // The passage the correction marked is still outdated under its new hash: only the correction answers.
    const answers = (await call<{ passages: { text: string }[] }>('POST', '/v1/collections/c2/search', { query: 'gateway listens on port' })).body.passages.map((passage) => passage.text)
    expect(answers.some((text) => text.includes('9001'))).toBe(true)
    expect(answers.some((text) => text.includes('[hidden] gateway'))).toBe(false)
  })

  it('reads an export within what its entries claim: an entry that inflates past its size is no export', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const good = await writeZip([['README.txt', 'x'], ['collection.json', '{"collectionId":"c0","version":1}'], ['notes.json', '{"notes":[]}'], ['corrections.json', '{"corrections":[]}'], ['documents/d_000000000000000000000001.json', '0'.repeat(8 * 1024 * 1024)], ['documents/d_000000000000000000000001.txt', 'a']])
    // The central directory says the big entry is one byte; it inflates to 8 MB.
    const forged = good.slice()
    const view = new DataView(forged.buffer)
    let at = view.getUint32(forged.length - 22 + 16, true)
    for (let entry = 0; entry < 6; entry += 1) {
      const nameLength = view.getUint16(at + 28, true)
      const name = new TextDecoder().decode(forged.subarray(at + 46, at + 46 + nameLength))
      if (name.endsWith('.json') && name.startsWith('documents/')) view.setUint32(at + 24, 1, true)
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    }
    expect(await readZip(forged)).toBeNull()
    expect(await readZip(good, { entryBytes: 1024 * 1024 })).toBeNull()
    await call('PUT', '/v1/collections/c1/inbox/file0009', forged, 'org-a', { 'content-type': 'application/zip' })
    const started = await call<{ error: string }>('POST', '/v1/collections/c1/import-export', { importId: 'restore1', fileId: 'file0009', sha256: sha256Hex(forged) })
    expect(started.status).toBe(409)
  })

  it('starts from the export it was asked to, by its checksum: a different file is refused', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Tiers.md', text: 'Gold partners renew every March.' }])
    engine.control.runUntilIdle()
    await call('POST', '/v1/collections/c1/exports', { exportId: 'e1' })
    const zip = new Uint8Array(await (await engine.fetch(new Request('https://engine.test/v1/collections/c1/exports/e1?download=1', { headers: { [ORG_HEADER]: 'org-a' } }))).arrayBuffer())
    await call('PUT', '/v1/collections/c2', { settings: SETTINGS })
    const staged = await call<{ sha256: string }>('PUT', '/v1/collections/c2/inbox/file0009', zip, 'org-a', { 'content-type': 'application/zip' })
    const other = await call<{ error: string }>('POST', '/v1/collections/c2/import-export', { importId: 'restore1', fileId: 'file0009', sha256: '0'.repeat(64) })
    expect(other.status).toBe(409)
    expect(other.body.error).toBe('bad_request')
    expect((await call('POST', '/v1/collections/c2/import-export', { importId: 'restore2', fileId: 'file0009' })).status).toBe(400)
    expect((await call('POST', '/v1/collections/c2/import-export', { importId: 'restore3', fileId: 'file0009', sha256: staged.body.sha256 })).status).toBe(202)
  })

  it('reads an export lazily within one budget: entries it doesn\'t need are never inflated, and too much in all is refused', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const manifests: [string, string][] = [['README.txt', 'x'], ['collection.json', '{"format":2,"collectionId":"c0","version":1}'], ['notes.json', '{"notes":[]}'], ['corrections.json', '{"corrections":[]}']]
    const details = (documentId: string, name: string) => JSON.stringify({ document: { documentId, kind: 'file', name, type: 'text/markdown', bytes: 1, pages: null, sha256: 'a'.repeat(64), active: true }, noteId: null, truncated: false, pages: [], hidden: {}, outdated: [] })
    const extras: [string, string][] = Array.from({ length: 48 }, (_, index) => [`extra/${index}.bin`, '0'.repeat(3 * 1024 * 1024)])
    const document: [string, string][] = [['documents/d_000000000000000000000001.json', details('d_000000000000000000000001', 'a.md')], ['documents/d_000000000000000000000001.txt', 'Gold partners renew every March.']]
    const padded = await writeZip([...manifests, ...extras, ...document])
    expect(padded.byteLength).toBeLessThan(1024 * 1024)
    const before = zipStats.inflated
    const staged = await call<{ sha256: string }>('PUT', '/v1/collections/c1/inbox/file0001', padded, 'org-a', { 'content-type': 'application/zip' })
    expect((await call('POST', '/v1/collections/c1/import-export', { importId: 'restore1', fileId: 'file0001', sha256: staged.body.sha256 })).status).toBe(202)
    expect(zipStats.inflated - before).toBeLessThan(64 * 1024)
    // Thirty documents of 3 MB of text each is more than an export may bring back in all: refused before inflating.
    const many: [string, string][] = Array.from({ length: 30 }, (_, index) => {
      const documentId = `d_${String(index + 1).padStart(24, '0')}`
      return [[`documents/${documentId}.json`, details(documentId, `${index}.md`)], [`documents/${documentId}.txt`, 'a'.repeat(3 * 1024 * 1024)]] as [string, string][]
    }).flat()
    const heavy = await writeZip([...manifests, ...many])
    await call('PUT', '/v1/collections/c3', { settings: SETTINGS })
    const stagedHeavy = await call<{ sha256: string }>('PUT', '/v1/collections/c3/inbox/file0003', heavy, 'org-a', { 'content-type': 'application/zip' })
    const start = zipStats.inflated
    expect((await call('POST', '/v1/collections/c3/import-export', { importId: 'restore3', fileId: 'file0003', sha256: stagedHeavy.body.sha256 })).status).toBe(409)
    expect(zipStats.inflated - start).toBeLessThan(64 * 1024)
  })

  it('takes the newest hold the app wants: an older one, late, changes nothing and is answered with the state the newer made', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: '2026-12-01T00:00:00Z' })).status).toBe(400)
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: '2026-12-01T00:00:00Z', version: 3 })).body).toEqual({ held: true, until: '2026-12-01T00:00:00.000Z' })
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: null, version: 2 })).body).toEqual({ held: true, until: '2026-12-01T00:00:00.000Z' })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.state).toBe('held')
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: null, version: 4 })).body).toEqual({ held: false, until: null })
    // The same version sent again changes nothing either.
    expect((await call('POST', '/v1/orgs/org-a/hold', { until: '2026-12-01T00:00:00Z', version: 4 })).body).toEqual({ held: false, until: null })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.state).not.toBe('held')
  })

  it('starts from a valid export whose notes list for people is past 8 MiB, as the real engine\'s reader does', async () => {
    const { call, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    // 450 notes of 20,000 characters: notes.json, which neither reader reads back, is over 8 MiB.
    for (let batch = 0; batch < 450; batch += 50) {
      const notes = Array.from({ length: 50 }, (_, index) => ({ noteId: `note${batch + index}`, title: `Note ${batch + index}`, text: `Note ${String(batch + index).padStart(3, '0')}. ` + 'lorem ipsum '.repeat(1665), outdated: [] }))
      expect((await call('POST', '/v1/collections/c1/imports', { importId: `notes${batch}`, small: true, files: [], notes })).status).toBe(202)
      engine.control.runUntilIdle()
    }
    await call('POST', '/v1/collections/c1/exports', { exportId: 'e1' })
    const zip = new Uint8Array(await (await engine.fetch(new Request('https://engine.test/v1/collections/c1/exports/e1?download=1', { headers: { [ORG_HEADER]: 'org-a' } }))).arrayBuffer())
    expect(zipEntries(zip)!.get('notes.json')!.size).toBeGreaterThan(8 * 1024 * 1024)
    const reader = new URL('../../engine/src/exportfile.ts', import.meta.url).href
    const { openExport } = (await import(/* @vite-ignore */ reader)) as { openExport: (bytes: Uint8Array) => Promise<{ documents: unknown[] } | null> }
    expect((await openExport(zip))?.documents).toHaveLength(450)
    await call('PUT', '/v1/collections/c2', { settings: SETTINGS })
    await call('PUT', '/v1/collections/c2/inbox/file0009', zip, 'org-a', { 'content-type': 'application/zip' })
    expect((await call('POST', '/v1/collections/c2/import-export', { importId: 'restore1', fileId: 'file0009', sha256: sha256Hex(zip) })).status).toBe(202)
    engine.control.runUntilIdle()
    expect((await call<ImportStatus>('GET', '/v1/collections/c2/imports/restore1')).body.state).toBe('committed')
    expect((await call<CollectionStatus>('GET', '/v1/collections/c2')).body.counts).toEqual((await call<CollectionStatus>('GET', '/v1/collections/c1')).body.counts)
  }, 60_000)

  it('a correction of a passage already corrected wins over the earlier one', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Ports.md', text: 'The gateway listens on port 8001.' }])
    engine.control.runUntilIdle()
    const passage = (await call<{ passages: { documentId: string; textHash: string }[] }>('POST', '/v1/collections/c1/search', { query: 'gateway port' })).body.passages[0]!
    const ref = { documentId: passage.documentId, textHash: passage.textHash }
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'n1', title: 'Correction', text: 'The gateway listens on port 9001.', outdated: [ref] } })
    engine.control.runUntilIdle()
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix2', note: { noteId: 'n2', title: 'Correction', text: 'The gateway listens on port 9002.', outdated: [ref] } })
    engine.control.runUntilIdle()
    const answers = (await call<{ passages: { text: string }[] }>('POST', '/v1/collections/c1/search', { query: 'gateway listens on port' })).body.passages.map((found) => found.text)
    expect(answers.some((text) => text.includes('9002'))).toBe(true)
    expect(answers.some((text) => text.includes('9001'))).toBe(false)
  })

  it('an export hidden again asks for a check of every corrected passage whose text changed', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Ports.md', text: 'The Cobalt gateway listens on port 8001.' }])
    engine.control.runUntilIdle()
    const passage = (await call<{ passages: { documentId: string; textHash: string }[] }>('POST', '/v1/collections/c1/search', { query: 'Cobalt gateway port' })).body.passages[0]!
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'n1', title: 'Correction', text: 'The gateway listens on port 9001.', outdated: [{ documentId: passage.documentId, textHash: passage.textHash }] } })
    engine.control.runUntilIdle()
    await call('POST', '/v1/collections/c1/exports', { exportId: 'e1' })
    const zip = new Uint8Array(await (await engine.fetch(new Request('https://engine.test/v1/collections/c1/exports/e1?download=1', { headers: { [ORG_HEADER]: 'org-a' } }))).arrayBuffer())
    await call('PUT', '/v1/collections/c2', { settings: { ...SETTINGS, hiding: { ...SETTINGS.hiding, words: ['Cobalt'] } } })
    const staged = await call<{ sha256: string }>('PUT', '/v1/collections/c2/inbox/file0009', zip, 'org-a', { 'content-type': 'application/zip' })
    const since = (await call<OutboxPage>('GET', '/v1/outbox?since=&limit=500', undefined, null)).body.cursor
    await call('POST', '/v1/collections/c2/import-export', { importId: 'restore1', fileId: 'file0009', sha256: staged.body.sha256 })
    engine.control.runUntilIdle()
    const events = (await call<OutboxPage>('GET', `/v1/outbox?since=${since}&limit=500`, undefined, null)).body.events
    const checks = events.filter((event) => event.type === 'needs_check' && event.collectionId === 'c2')
    expect(checks).toMatchObject([{ noteId: 'n1', documentId: passage.documentId, previousTextHash: passage.textHash }])
    expect((checks[0] as { textHash: string }).textHash).not.toBe(passage.textHash)
  })

  it('cancels an import it hasn\'t started, remembers an id it never had as cancelled, and refuses one it is learning', async () => {
    const { call, learn, engine } = engineFor({ importMs: 60_000 })
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    // An id it never had: remembered as cancelled, so a submission with it arriving later learns nothing, and the
    // staged file it names goes.
    const unknown = await call<ImportStatus>('DELETE', '/v1/collections/c1/imports/late1')
    expect([unknown.status, unknown.body.state]).toEqual([200, 'cancelled'])
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/late1')).body.state).toBe('cancelled')
    const since = (await call<OutboxPage>('GET', '/v1/outbox?since=&limit=500', undefined, null)).body.cursor
    const late = await learn('c1', 'late1', [{ fileId: 'file0001', name: 'Late.md', text: 'Arrived late.' }])
    expect([late.status, late.body.state]).toEqual([200, 'cancelled'])
    expect((await call<OutboxPage>('GET', `/v1/outbox?since=${since}&limit=500`, undefined, null)).body.events).toMatchObject([{ type: 'import', import: { importId: 'late1', state: 'cancelled' } }])
    const again = { importId: 'other1', small: false, notes: [], files: [{ fileId: 'file0001', name: 'Late.md', type: 'text/markdown', bytes: 13, sha256: sha256Hex('Arrived late.') }] }
    expect((await call('POST', '/v1/collections/c1/imports', again)).status).toBe(400)
    // One learning is refused; one queued behind it is cancelled, the same when asked again, and never learned.
    await learn('c1', 'imp1', [{ fileId: 'file0002', name: 'One.md', text: 'The first rule.' }])
    await learn('c1', 'imp2', [{ fileId: 'file0003', name: 'Two.md', text: 'The second rule.' }])
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp1')).body.state).toBe('learning')
    const busy = await call<{ error: string }>('DELETE', '/v1/collections/c1/imports/imp1')
    expect([busy.status, busy.body.error]).toEqual([409, 'busy_learning'])
    expect((await call<ImportStatus>('DELETE', '/v1/collections/c1/imports/imp2')).body.state).toBe('cancelled')
    expect((await call<ImportStatus>('DELETE', '/v1/collections/c1/imports/imp2')).body.state).toBe('cancelled')
    engine.control.runUntilIdle()
    expect((await call<ImportStatus>('GET', '/v1/collections/c1/imports/imp2')).body.state).toBe('cancelled')
    expect((await call<{ documents: { name: string }[] }>('GET', '/v1/collections/c1/documents')).body.documents.map((document) => document.name)).toEqual(['One.md'])
    expect((await call('POST', '/v1/collections/c1/imports', { ...again, importId: 'other2', files: [{ ...again.files[0], fileId: 'file0003' }] })).status).toBe(400)
    // Finished: refused as well.
    expect((await call('DELETE', '/v1/collections/c1/imports/imp1')).status).toBe(409)
  })

  it('keeps the newer correction of a passage through exports and back: the order corrections were made goes with them', async () => {
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Doors.md', text: 'Code alpha opens the north door.\n\nCode bravo opens the north door.' }])
    engine.control.runUntilIdle()
    const find = async (query: string) => (await call<{ passages: { documentId: string; textHash: string }[] }>('POST', '/v1/collections/c1/search', { query })).body.passages[0]!
    const [alpha, bravo] = [await find('code alpha north door'), await find('code bravo north door')]
    expect(alpha.textHash).not.toBe(bravo.textHash)
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix1', note: { noteId: 'n1', title: 'Older', text: 'Code alpha opens the south door.', outdated: [{ documentId: alpha.documentId, textHash: alpha.textHash }] } })
    engine.control.runUntilIdle()
    await call('POST', '/v1/collections/c1/corrections', { importId: 'fix2', note: { noteId: 'n2', title: 'Newer', text: 'Code bravo opens the east door.', outdated: [{ documentId: bravo.documentId, textHash: bravo.textHash }] } })
    engine.control.runUntilIdle()
    // Out to an export and back into a new collection, twice.
    const roundTrip = async (from: string, to: string) => {
      await call('POST', `/v1/collections/${from}/exports`, { exportId: `e${from}` })
      const zip = new Uint8Array(await (await engine.fetch(new Request(`https://engine.test/v1/collections/${from}/exports/e${from}?download=1`, { headers: { [ORG_HEADER]: 'org-a' } }))).arrayBuffer())
      await call('PUT', `/v1/collections/${to}`, { settings: SETTINGS })
      const staged = await call<{ sha256: string }>('PUT', `/v1/collections/${to}/inbox/file0009`, zip, 'org-a', { 'content-type': 'application/zip' })
      expect((await call('POST', `/v1/collections/${to}/import-export`, { importId: `restore${to}`, fileId: 'file0009', sha256: staged.body.sha256 })).status).toBe(202)
      engine.control.runUntilIdle()
      return zip
    }
    const first = await roundTrip('c1', 'c2')
    const reader = new URL('../../engine/src/exportfile.ts', import.meta.url).href
    const { openExport } = (await import(/* @vite-ignore */ reader)) as { openExport: (bytes: Uint8Array) => Promise<{ marks: { seq: number }[] } | null> }
    expect((await openExport(first))?.marks.map((mark) => mark.seq).sort()).toEqual([1, 2])
    await roundTrip('c2', 'c3')
    // A stricter rule makes the two passages one: the newer correction keeps it, the older is no longer used.
    await call('PUT', '/v1/collections/c3', { settings: { ...SETTINGS, hiding: { ...SETTINGS.hiding, words: ['alpha', 'bravo'] }, revision: 2 } })
    engine.control.runUntilIdle()
    const notes = (await call<{ documents: { name: string; kind: string; active: boolean }[] }>('GET', '/v1/collections/c3/documents')).body.documents
      .filter((document) => document.kind === 'note').map(({ name, active }) => ({ name, active })).sort((a, b) => a.name.localeCompare(b.name))
    expect(notes).toEqual([{ name: 'Newer', active: true }, { name: 'Older', active: false }])
  })

  it('checks an export\'s hidden values before building any: millions of starts in a small zip are refused at once', async () => {
    const { call } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const documentId = 'd_000000000000000000000001'
    const details = JSON.stringify({ document: { documentId, kind: 'file', name: 'a.md', type: 'text/markdown', bytes: 8, pages: null, sha256: 'a'.repeat(64), active: true }, noteId: null, truncated: false, pages: [], hidden: { word: new Array(1_900_000).fill(0) }, outdated: [] })
    expect(details.length).toBeLessThan(4 * 1024 * 1024)
    const zip = await writeZip([['README.txt', 'x'], ['collection.json', '{"format":2,"collectionId":"c0","version":1}'], [`documents/${documentId}.json`, details], [`documents/${documentId}.txt`, '[hidden]']])
    expect(zip.byteLength).toBeLessThan(64 * 1024)
    const staged = await call<{ sha256: string }>('PUT', '/v1/collections/c1/inbox/file0001', zip, 'org-a', { 'content-type': 'application/zip' })
    const before = process.memoryUsage().heapUsed
    const started = await call('POST', '/v1/collections/c1/import-export', { importId: 'restore1', fileId: 'file0001', sha256: staged.body.sha256 })
    const grown = process.memoryUsage().heapUsed - before
    expect(started.status).toBe(409)
    expect(grown).toBeLessThan(48 * 1024 * 1024)
  })

  it('clears staged files nobody imported after a day, unless kept for a waiting import, at most 45 days', async () => {
    const { call, stage, advance } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    for (const [fileId, text] of [['file0001', 'Alpha'], ['file0002', 'Beta'], ['file0003', 'Gamma']]) await stage('c1', fileId!, `${text}.md`, text!)
    const until = '2026-12-03T00:00:00.000Z'
    expect((await call('POST', '/v1/collections/c1/inbox/keep', { fileIds: ['file0001', 'file0003', 'file0009'], until })).body).toEqual({ kept: ['file0001', 'file0003'] })
    expect((await call('POST', '/v1/collections/c1/inbox/keep', { fileIds: ['file0001'], until: '2027-01-05T00:00:00.000Z' })).status).toBe(400)
    expect((await call('POST', '/v1/collections/c1/inbox/keep', { fileIds: ['file0001'] })).status).toBe(400)
    const importOf = (importId: string, fileId: string, text: string) => call<ImportStatus>('POST', '/v1/collections/c1/imports', {
      importId, small: false, notes: [], files: [{ fileId, name: `${text}.md`, type: 'text/markdown', bytes: text.length, sha256: sha256Hex(text) }],
    })
    advance(25 * 60 * 60 * 1000)
    expect((await importOf('imp2', 'file0002', 'Beta')).status).toBe(400)
    advance(Date.parse('2026-12-02T00:00:00Z') - Date.parse('2026-11-17T10:00:00Z'))
    expect((await importOf('imp1', 'file0001', 'Alpha')).status).toBe(202)
    advance(Date.parse('2026-12-03T00:01:00Z') - Date.parse('2026-12-02T00:00:00Z'))
    expect((await importOf('imp3', 'file0003', 'Gamma')).status).toBe(400)
  })
})
