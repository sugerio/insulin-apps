import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ORG_HEADER, type CollectionStatus, type ImportStatus, type OutboxPage, type RestorePoint } from '../../engine/src/contract.ts'
import { createStubEngine, STUB_MARKER } from '../../engine/src/stub/index.ts'
import { sha256Hex } from '../../engine/src/stub/text.ts'
import worker from '../../engine/src/stub/worker.ts'

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
      ['PUT', '/v1/collections/c1/inbox/file0001', new TextEncoder().encode('x')], ['POST', '/v1/collections/c1/imports', {}],
      ['GET', '/v1/collections/c1/imports/i1'], ['POST', '/v1/collections/c1/search', { query: 'x' }], ['POST', '/v1/answer', { question: 'x', passages: [] }],
      ['GET', '/v1/collections/c1/documents'], ['GET', '/v1/collections/c1/documents/d1'], ['PATCH', '/v1/collections/c1/documents/d1', { active: false }],
      ['DELETE', '/v1/collections/c1/documents/d1'], ['GET', '/v1/collections/c1/facts?cursor='], ['POST', '/v1/collections/c1/corrections', {}],
      ['GET', '/v1/collections/c1/restore-points'], ['GET', '/v1/collections/c1/restore-points/1/preview'], ['POST', '/v1/collections/c1/restore-points/1/go-back'],
      ['POST', '/v1/collections/c1/undo'], ['POST', '/v1/collections/c1/exports', { exportId: 'e1' }], ['GET', '/v1/collections/c1/exports/e1'],
      ['GET', '/v1/outbox?since=&limit=10'], ['GET', '/v1/health'], ['POST', '/v1/orgs/org-a/purge'], ['DELETE', '/v1/collections/c1'],
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
    const { call, learn, engine } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    const first = await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Rules.md', text: 'Partner discounts stop at 20 percent.' }])
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ state: 'committed', version: 1, files: [{ state: 'learned' }] })
    expect((await learn('c1', 'imp1', [])).status).toBe(200)
    const same = await learn('c1', 'imp2', [{ fileId: 'file0002', name: 'Copy.md', text: 'Partner discounts stop at 20 percent.' }])
    expect(same.body).toMatchObject({ state: 'duplicate', version: null, files: [{ state: 'already_here' }] })
    engine.control.failNextImport({ collectionId: 'c1', times: 1 })
    const retried = await learn('c1', 'imp3', [{ fileId: 'file0003', name: 'More.md', text: 'Gold partners get a named contact.' }])
    expect(retried.body).toMatchObject({ state: 'committed', attempt: 2, version: 2 })
    engine.control.failNextImport({ collectionId: 'c1', times: 3, fileName: 'Deck.md' })
    const failed = await learn('c1', 'imp4', [{ fileId: 'file0004', name: 'Notes.md', text: 'Silver partners renew in June.' }, { fileId: 'file0005', name: 'Deck.md', text: 'Bronze partners renew in May.' }])
    expect(failed.body).toMatchObject({ state: 'failed', attempt: 3, failedFileId: 'file0005', version: null })
    expect(failed.body.files.find((file) => file.fileId === 'file0005')).toMatchObject({ state: 'failed', reason: 'Couldn\'t learn “Deck.md” after 3 tries.' })
    expect((await call<CollectionStatus>('GET', '/v1/collections/c1')).body).toMatchObject({ version: 2, counts: { documents: 2 } })
    const outbox = await call<OutboxPage>('GET', '/v1/outbox?limit=500', undefined, null)
    expect(outbox.body.events.filter((event) => event.type === 'import' && event.import.importId === 'imp4').map((event) => (event as { import: ImportStatus }).import.state)).toEqual(['interrupted', 'interrupted', 'failed'])
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
    const { call, learn } = engineFor()
    await call('PUT', '/v1/collections/c1', { settings: SETTINGS })
    await call('PUT', '/v1/collections/c2', { settings: SETTINGS })
    await call('PUT', '/v1/collections/c3', { settings: SETTINGS }, 'org-b')
    await learn('c1', 'imp1', [{ fileId: 'file0001', name: 'Rules.md', text: 'Write to partners@example.com about discounts.' }])
    const made = await call('POST', '/v1/collections/c1/exports', { exportId: 'exp1' })
    expect(made.body).toMatchObject({ exportId: 'exp1', state: 'ready' })
    const file = await call('GET', '/v1/collections/c1/exports/exp1?download=1')
    expect(file.headers.get('content-disposition')).toMatch(/attachment/)
    expect(JSON.stringify(file.body)).toContain('[hidden]')
    expect(JSON.stringify(file.body)).not.toContain('partners@example.com')
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
})
