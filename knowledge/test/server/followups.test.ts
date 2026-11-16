import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORG_HEADER, type CollectionStatus } from '../../engine/src/contract.ts'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// What the screens rely on and what the Docs promise: hidden values in any script, an empty member search, clearing
// a correction that is still right, waiting imports listed and cancelled, "Yes, this was right", the days of backups,
// and starting a collection from an export.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const encoder = new TextEncoder()
const setLimit = (key: string, value: number | null, org = ORG) =>
  h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, ?, ?, NULL, 0) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).bind(org, key, value).run()

describe('hidden values in any script', () => {
  it('a correction written with full-width digits is kept with them hidden, and Try it hides them too', async () => {
    const id = await h.collection(PEOPLE.maya)
    const text = 'Card ４１１１ １１１１ １１１１ １１１１, or call +４９ ３０ １２３４ ５６７８.'
    const fix = await h.json<{ correction: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text })
    const kept = await h.db.prepare(`SELECT text FROM corrections WHERE id = ?`).bind(fix.body.correction.id).first<{ text: string }>()
    expect(kept!.text).toBe('Card [hidden], or call [hidden].')
    const preview = await h.json<{ text: string }>(PEOPLE.dana, 'POST', '/api/rules/hiding-preview', { text })
    expect(preview.body.text).toBe('Card [hidden], or call [hidden].')
  })
})

describe('sharing', () => {
  it('an empty member search lists no one, without asking the platform (which refuses it)', async () => {
    const empty = await h.json<{ members: unknown[] }>(PEOPLE.maya, 'GET', '/api/members?q=')
    expect(empty).toEqual({ status: 200, body: { members: [] } })
    expect((await h.json<{ members: { id: string }[] }>(PEOPLE.maya, 'GET', '/api/members?q=eli')).body.members.map((member) => member.id)).toEqual([PEOPLE.eli.id])
  })
})

describe('corrections to check', () => {
  it('one that is still right can be cleared, and Needs attention no longer lists it', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    const facts = await h.json<{ facts: { factId: string; documentId: string; passageTextHash: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const fix = await h.json<{ correction: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Discounts stop at 15 percent.', factId: facts.body.facts[0]!.factId })
    const check = { noteId: fix.body.correction.id.replace(/-/g, ''), documentId: facts.body.facts[0]!.documentId, textHash: facts.body.facts[0]!.passageTextHash }
    await h.db.prepare(`INSERT INTO correction_checks (collection_id, note_id, document_id, text_hash, org_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, check.noteId, check.documentId, check.textHash, ORG, h.clock.now).run()
    const items = async () => (await h.json<{ collections: { items: { kind: string; noteId?: string; textHash?: string }[] }[] }>(PEOPLE.maya, 'GET', `/api/attention?collection=${id}`)).body.collections[0]!.items.filter((item) => item.kind === 'needs_check')
    expect(await items()).toMatchObject([{ noteId: check.noteId, textHash: check.textHash }])
    expect((await h.call(PEOPLE.leo, 'POST', `/api/collections/${id}/correction-checks/clear`, check)).status).toBe(403)
    expect((await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/correction-checks/clear`, check)).body).toEqual({ cleared: true })
    expect(await items()).toEqual([])
  })
})

describe('imports waiting for the 1st', () => {
  it('a collection lists its waiting imports, and cancelling one frees what it held and never learns it', async () => {
    const id = await h.collection(PEOPLE.maya)
    await setLimit('learned_month', 0)
    const waiting = await h.json<{ import: { importId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Rule', text: 'Discounts stop at 20 percent.' })
    const list = await h.json<{ imports: { importId: string; kind: string; notes: number; createdBy: { id: string; name: string | null }; waitsFor: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports?state=waiting`)
    expect(list.body.imports).toMatchObject([{ importId: waiting.body.import.importId, kind: 'note', notes: 1, createdBy: { id: PEOPLE.maya.id, name: 'Maya Example' }, waitsFor: '2026-12-01T00:00:00Z' }])
    expect((await h.call(PEOPLE.leo, 'DELETE', `/api/collections/${id}/imports/${waiting.body.import.importId}`)).status).toBe(403)
    const cancelled = await h.json<{ import: { state: string } }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${waiting.body.import.importId}`)
    expect(cancelled.body.import.state).toBe('cancelled')
    expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE org_id = ? AND state = 'held' AND ref LIKE 'import:%'`).bind(ORG).first('n'))).toBe(0)
    expect((await h.json<{ imports: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports?state=waiting`)).body.imports).toEqual([])
    expect((await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${waiting.body.import.importId}`)).status).toBe(409)
    await h.db.prepare(`DELETE FROM org_limits`).run()
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources).toEqual([])
  })
})

describe('was this right?', () => {
  it('Yes marks the answer right, once, for whoever asked; the collection counts answers marked right', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.')
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'VIEWER')
    const answer = await h.json<{ answerId: string }>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    await h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000 again?' })
    expect((await h.call(PEOPLE.eli, 'POST', `/api/answers/${answer.body.answerId}/right`)).status).toBe(404)
    expect((await h.json(PEOPLE.maya, 'POST', `/api/answers/${answer.body.answerId}/right`)).body).toEqual({ markedRight: true })
    expect((await h.json(PEOPLE.maya, 'POST', `/api/answers/${answer.body.answerId}/right`)).body).toEqual({ markedRight: true })
    const detail = await h.json<{ answers: { total: number; markedRight: number } }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)
    expect(detail.body.answers).toEqual({ total: 2, markedRight: 1 })
  })
})

describe('days of daily backups', () => {
  it('are the organization\'s backup_days, 30 by default, on the collection and on Health', async () => {
    const id = await h.collection(PEOPLE.maya)
    expect((await h.json<{ backupDays: number }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)).body.backupDays).toBe(30)
    await setLimit('backup_days', 7)
    expect((await h.json<{ backupDays: number }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)).body.backupDays).toBe(7)
    expect((await h.json<{ backupDays: number }>(PEOPLE.dana, 'GET', '/api/health')).body.backupDays).toBe(7)
  })
})

describe('starting a collection from an export', () => {
  /** A collection with a file it stopped using, a note and a correction, exported; the export's bytes. */
  async function exported() {
    const id = await h.collection(PEOPLE.maya, 'Partner Programs')
    const pre = await h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'Tiers.md', bytes: 61 }, { name: 'Old.md', bytes: 35 }] })
    await h.call(PEOPLE.maya, 'PUT', `/api/collections/${id}/uploads/${pre.body.files[0]!.fileId}`, encoder.encode('Gold partners renew every March and get a 20 percent discount.'))
    await h.call(PEOPLE.maya, 'PUT', `/api/collections/${id}/uploads/${pre.body.files[1]!.fileId}`, encoder.encode('Silver partners renew every June now.'))
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: pre.body.files.map((file) => file.fileId) })
    h.engine.control.runUntilIdle()
    await h.tick()
    await h.note(PEOPLE.maya, id, 'Platinum partners get a named alliance lead.', 'Platinum')
    const sources = (await h.json<{ sources: { documentId: string; name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}/sources/${sources.find((source) => source.name === 'Old.md')!.documentId}`, { active: false })
    const found = await h.json<{ passages: { documentId: string; textHash: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'When do gold partners renew?' })
    const passage = found.body.passages[0]!
    expect((await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Gold partners renew every April.', outdated: [{ documentId: passage.documentId, textHash: passage.textHash }] })).status).toBe(202)
    h.engine.control.runUntilIdle()
    await h.tick()
    const made = await h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/exports`)
    const file = await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/exports/${made.body.export.exportId}?download=1`)
    expect(file.headers.get('content-type')).toBe('application/zip')
    return { id, bytes: new Uint8Array(await file.arrayBuffer()) }
  }

  /** Preflight, upload and start, as the wizard does. */
  async function startFrom(target: string, bytes: Uint8Array, name = 'partner-programs.zip') {
    const pre = await h.json<{ files: { fileId?: string; accepted: boolean; reason?: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${target}/preflight`, { files: [{ name, bytes: bytes.byteLength }], export: true })
    if (!pre.body.files?.[0]?.accepted) return { pre, uploaded: null, started: null }
    const uploaded = await h.json<{ accepted: boolean; reason: string | null }>(PEOPLE.maya, 'PUT', `/api/collections/${target}/uploads/${pre.body.files[0]!.fileId}`, bytes)
    const started = uploaded.body.accepted ? await h.json<{ import: { state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${target}/import-export`, { fileId: pre.body.files[0]!.fileId }) : null
    return { pre, uploaded, started }
  }

  it('brings back the same sources, the files it stopped using, its corrections and the same answers', async () => {
    const { id, bytes } = await exported()
    const target = await h.collection(PEOPLE.maya, 'Partner Programs, again')
    const { started } = await startFrom(target, bytes)
    expect(started!.status).toBe(202)
    h.engine.control.runUntilIdle()
    await h.tick()
    const shape = async (collection: string) => (await h.json<{ sources: { name: string; active: boolean; kind: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${collection}/sources`)).body.sources
      .map(({ name, active, kind }) => ({ name, active, kind })).sort((a, b) => a.name.localeCompare(b.name))
    expect(await shape(target)).toEqual(await shape(id))
    expect((await shape(target)).find((source) => source.name === 'Old.md')).toMatchObject({ active: false })
    const answer = async (collection: string) => (await h.json<{ passages: { text: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [collection], query: 'When do gold partners renew?' })).body.passages.map((passage) => passage.text)
    expect(await answer(target)).toEqual(await answer(id))
    expect((await answer(target))[0]).toContain('April')
    const counts = async (collection: string) => (await engineStatusOf(collection)).counts
    expect(await counts(target)).toEqual(await counts(id))
    expect((await h.json<{ restorePoints: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${target}/history`)).body.restorePoints).toHaveLength(1)
  })

  it('takes a Knowledge export only, only there, and only into an empty collection, within the organization\'s limits', async () => {
    const { id, bytes } = await exported()
    // Anywhere else a zip is a file Knowledge can't read.
    const plain = await h.json<{ files: { accepted: boolean }[] }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'partner-programs.zip', bytes: bytes.byteLength }] })
    expect(plain.body.files[0]!.accepted).toBe(false)
    // Into a collection that already knows something: refused.
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'partner-programs.zip', bytes: bytes.byteLength }], export: true })).status).toBe(409)
    const target = await h.collection(PEOPLE.maya, 'Fresh')
    // Not a zip, or a zip that isn't an export.
    expect((await startFrom(target, encoder.encode('# notes'), 'notes.md')).pre.body.files[0]!.accepted).toBe(false)
    const other = await startFrom(target, zipOf({ 'readme.txt': 'just a zip' }))
    expect(other.uploaded!.body).toMatchObject({ accepted: false, reason: expect.stringMatching(/isn't a Knowledge export/) })
    // Its documents count against the organization's limits before anything starts.
    await setLimit('documents', 3)
    const refused = await startFrom(target, bytes)
    expect(refused.started!.status).toBe(429)
    await setLimit('documents', null)
    expect((await startFrom(target, bytes)).started!.status).toBe(202)
  })
})

async function engineStatusOf(id: string): Promise<CollectionStatus> {
  const response = await h.engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { headers: { [ORG_HEADER]: ORG } }))
  return (await response.json()) as CollectionStatus
}

/** A plain zip (stored, no compression) of a few text files. */
function zipOf(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    const head = new DataView(new ArrayBuffer(46))
    head.setUint32(0, 0x02014b50, true)
    head.setUint16(4, 20, true)
    head.setUint16(6, 20, true)
    head.setUint32(16, crc, true)
    head.setUint32(20, data.length, true)
    head.setUint32(24, data.length, true)
    head.setUint16(28, nameBytes.length, true)
    head.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    central.push(new Uint8Array(head.buffer), nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const size = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, Object.keys(files).length, true)
  end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
