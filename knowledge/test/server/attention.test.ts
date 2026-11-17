import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// Needs attention (design J6, the LAUNCH items): files Insulin couldn't read, values hidden before learning and reported
// answers waiting, for the people who can change a collection; and "Looks right" on What it knows.

let h: Harness
afterEach(() => h?.close())

const encoder = new TextEncoder()
const SCANNED_PDF = `%PDF-1.4\n1 0 obj << /Type /Page /Resources << /XObject << /Im1 2 0 R >> >> >>\nendobj\n2 0 obj << /Type /XObject /Subtype /Image /Width 10 /Height 10 >>\nstream\n\u0001\u0002\u0003\nendstream\nendobj\n%%EOF\n`

async function upload(person: Person, id: string, files: { name: string; text: string }[]): Promise<string[]> {
  const preflight = await h.json<{ files: { name: string; accepted: boolean; fileId?: string }[] }>(person, 'POST', `/api/collections/${id}/preflight`, {
    files: files.map((file) => ({ name: file.name, bytes: encoder.encode(file.text).byteLength })),
  })
  const accepted: string[] = []
  for (const file of preflight.body.files) {
    if (!file.accepted) continue
    const bytes = encoder.encode(files.find((candidate) => candidate.name === file.name)!.text)
    const uploaded = await h.json<{ accepted: boolean }>(person, 'PUT', `/api/collections/${id}/uploads/${file.fileId}`, bytes, { 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' })
    if (uploaded.body.accepted) accepted.push(file.fileId!)
  }
  return accepted
}

type Attention = { collections: { id: string; name: string; role: string; items: Record<string, any>[] }[] }

describe('Needs attention', () => {
  it('lists unreadable files, hidden values and open reports for the collection\'s editors, and nothing for viewers', async () => {
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya, 'Partner Programs')
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    // Values hidden before learning: an address and a phone number in a note.
    await h.note(PEOPLE.maya, id, 'The partner council meets on the first Tuesday. Questions to council@example.test or +1 415 555 0132.', 'Council')
    // A scanned PDF, refused at upload.
    await upload(PEOPLE.maya, id, [{ name: 'Signed form.pdf', text: SCANNED_PDF }])
    // An import that fails three times, naming its file.
    h.engine.control.failNextImport({ collectionId: id, times: 3, fileName: 'Q3 deck.md' })
    const fileIds = await upload(PEOPLE.maya, id, [{ name: 'Q3 deck.md', text: '# Q3\n\nThe deck lists partner wins.' }])
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds })
    h.engine.control.runUntilIdle()
    h.engine.control.runUntilIdle()
    h.engine.control.runUntilIdle()
    await h.tick()
    // A reported answer.
    const report = await h.json<{ report: { id: string } }>(PEOPLE.leo, 'POST', `/api/collections/${id}/reports`, { question: 'When does the council meet?', note: 'It moved to Wednesdays.' })
    expect(report.status).toBe(201)

    const seen = await h.json<Attention>(PEOPLE.eli, 'GET', '/api/attention')
    expect(seen.status).toBe(200)
    const items = seen.body.collections.find((collection) => collection.id === id)!.items
    expect(seen.body.collections[0]!.role).toBe('EDITOR')
    const kinds = items.map((item) => item.kind).sort()
    expect(kinds).toEqual(['hidden', 'reported', 'unreadable', 'unreadable'])
    expect(items.find((item) => item.kind === 'hidden')).toMatchObject({ documentName: 'Council', total: 2 })
    expect(JSON.stringify(items)).not.toContain('council@example.test')
    expect(items.find((item) => item.id.startsWith('upload:'))!.files[0]).toMatchObject({ name: 'Signed form.pdf', reason: expect.stringMatching(/scanned image with no text/) })
    expect(items.find((item) => item.id.startsWith('import:'))!.message).toMatch(/Q3 deck\.md/)
    expect(items.find((item) => item.kind === 'reported')).toMatchObject({ question: 'When does the council meet?', note: 'It moved to Wednesdays.', reportedBy: { name: 'Leo Example' } })

    // Viewers don't see Needs attention, even with a share as Editor (the Viewer cap); outsiders of the collection see nothing of it.
    const viewer = await h.json<{ error: string }>(PEOPLE.leo, 'GET', '/api/attention')
    expect(viewer.status).toBe(403)
    const admin = await h.json<Attention>(PEOPLE.ada, 'GET', '/api/attention')
    expect(admin.body.collections).toEqual([])
    expect((await h.json(PEOPLE.ada, 'GET', `/api/attention?collection=${id}`)).status).toBe(403)
    expect((await h.json(PEOPLE.outsider, 'GET', `/api/attention?collection=${id}`)).status).toBe(404)

    // Settled reports leave the list; the file that couldn't be read leaves it once a file with its name is learned.
    await h.json(PEOPLE.maya, 'PATCH', `/api/collections/${id}/reports/${report.body.report.id}`, { status: 'dismissed' })
    const again = await upload(PEOPLE.maya, id, [{ name: 'Q3 deck.md', text: '# Q3\n\nThe deck lists partner wins, fixed.' }])
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: again })
    h.engine.control.runUntilIdle()
    await h.tick()
    const after = await h.json<Attention>(PEOPLE.maya, 'GET', `/api/attention?collection=${id}`)
    expect(after.body.collections[0]!.items.map((item) => item.kind).sort()).toEqual(['hidden', 'unreadable'])
    expect(after.body.collections[0]!.items.find((item) => item.kind === 'unreadable')!.files[0].name).toBe('Signed form.pdf')
  })

  it('answers assistants only for collections whose switch is on, and is in the catalog for editors', async () => {
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya)
    await h.json(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    const assistant = await h.json<Attention>({ ...PEOPLE.maya, via: 'mcp' }, 'GET', '/api/attention')
    expect(assistant.body.collections).toEqual([])
    const catalog = await h.json<{ endpoints: { path: string }[] }>(PEOPLE.maya, 'GET', '/api/catalog')
    expect(catalog.body.endpoints.map((endpoint) => endpoint.path)).toContain('/api/attention')
    const viewerCatalog = await h.json<{ endpoints: { path: string }[] }>(PEOPLE.leo, 'GET', '/api/catalog')
    expect(viewerCatalog.body.endpoints.map((endpoint) => endpoint.path)).not.toContain('/api/attention')
  })
})

describe('Needs attention across many collections', () => {
  const roomFor = (collections: number) => h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'collections', ?, NULL, 0)`).bind(ORG, collections).run()
  /** The statements D1 is sent while `work` runs. */
  async function statements(work: () => Promise<unknown>): Promise<number> {
    const prepare = h.db.prepare.bind(h.db)
    let count = 0
    h.db.prepare = (query: string) => { count += 1; return prepare(query) }
    try {
      await work()
    } finally {
      h.db.prepare = prepare
    }
    return count
  }

  it('covers every collection the person can change, past the 20th by name, with the same few queries for any number', async () => {
    h = await createHarness()
    await roomFor(100)
    const ids: string[] = []
    for (let index = 1; index <= 25; index += 1) ids.push(await h.collection(PEOPLE.maya, `Collection ${String(index).padStart(2, '0')}`))
    await h.share(PEOPLE.maya, ids[24]!, PEOPLE.eli, 'EDITOR')
    for (const id of [ids[0]!, ids[24]!]) await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/reports`, { question: 'Who signs off?', note: 'Wrong person.' })
    const seen = await h.json<Attention>(PEOPLE.maya, 'GET', '/api/attention')
    // Must catch: the collections after the 20th by name were left out, with no sign of them.
    expect(seen.body.collections).toHaveLength(25)
    expect(seen.body.collections.filter((collection) => collection.items.length).map((collection) => collection.name)).toEqual(['Collection 01', 'Collection 25'])
    expect(seen.body.collections.find((collection) => collection.id === ids[24])!.items).toEqual([expect.objectContaining({ kind: 'reported', question: 'Who signs off?' })])
    expect((seen.body as unknown as { notice: unknown }).notice).toBeNull()
    // Eli's share is found in the same query: the 25th, as an Editor.
    expect((await h.json<Attention>(PEOPLE.eli, 'GET', '/api/attention')).body.collections).toMatchObject([{ id: ids[24], role: 'EDITOR', items: [{ kind: 'reported' }] }])
    // As many statements for 25 collections as for 1.
    const many = await statements(() => h.json(PEOPLE.maya, 'GET', '/api/attention'))
    const one = await statements(() => h.json(PEOPLE.eli, 'GET', '/api/attention'))
    expect(many).toBe(one)
  })

  it('reads the engine for at most 50 collections, those changed most recently, and says so for the rest', async () => {
    h = await createHarness()
    await roomFor(100)
    const ids: string[] = []
    for (let index = 1; index <= 52; index += 1) {
      const id = await h.collection(PEOPLE.maya, `Hidden ${String(index).padStart(2, '0')}`)
      await h.note(PEOPLE.maya, id, `Write to person${index}@example.test about rule ${index}.`, `Note ${index}`)
      h.clock.advance(60_000)
      ids.push(id)
    }
    // A collection with nothing learned lately isn't read at all.
    ids.push(await h.collection(PEOPLE.maya, 'Nothing lately'))
    const engine = h.env.ENGINE!
    const reads: string[] = []
    h.env.ENGINE = { fetch: async (request) => { if (/\/documents$/.test(new URL(request.url).pathname)) reads.push(new URL(request.url).pathname); return engine.fetch(request) } }
    const seen = await h.json<Attention & { notice: string | null }>(PEOPLE.maya, 'GET', '/api/attention')
    expect(reads).toHaveLength(50)
    expect(seen.body.collections).toHaveLength(53)
    const partial = seen.body.collections.filter((collection) => (collection as { partial?: boolean }).partial).map((collection) => collection.name)
    expect(partial).toEqual(['Hidden 01', 'Hidden 02'])
    expect(seen.body.collections.filter((collection) => collection.items.some((item) => item.kind === 'hidden'))).toHaveLength(50)
    expect(seen.body.notice).toMatch(/aren't listed here for 2 collections/)
    // One collection on its own is always read in full.
    const alone = await h.json<Attention & { notice: string | null }>(PEOPLE.maya, 'GET', `/api/attention?collection=${ids[0]}`)
    expect(alone.body.collections[0]!.items).toEqual([expect.objectContaining({ kind: 'hidden', documentName: 'Note 1' })])
    expect(alone.body.notice).toBeNull()
  })
})

describe('Looks right', () => {
  it('records who checked a fact; going back keeps it; viewers can\'t check', async () => {
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'EDITOR')
    await h.note(PEOPLE.maya, id, 'Gold partners get a dedicated partner manager.', 'Tiers')
    const facts = await h.json<{ facts: { factId: string; sentence: string; checked: unknown }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const fact = facts.body.facts[0]!
    expect(fact.checked).toBeNull()
    const checked = await h.json<{ check: { by: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/facts/${encodeURIComponent(fact.factId)}/check`)
    expect(checked.status).toBe(200)
    expect(checked.body.check.by).toBe('Maya Example')
    const after = await h.json<{ facts: { factId: string; checked: { by: string; at: string } | null }[] }>(PEOPLE.leo, 'GET', `/api/collections/${id}/facts`)
    expect(after.body.facts.find((candidate) => candidate.factId === fact.factId)!.checked).toMatchObject({ by: 'Maya Example' })
    // Leo is a Viewer in Knowledge: shared as Editor, he acts as Viewer.
    expect((await h.json(PEOPLE.leo, 'POST', `/api/collections/${id}/facts/${encodeURIComponent(fact.factId)}/check`)).status).toBe(403)
    expect((await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/facts/${encodeURIComponent('bad id!')}/check`)).status).toBe(400)
  })
})
