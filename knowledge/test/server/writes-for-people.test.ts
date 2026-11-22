import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// What an API client that writes for people needs (an agent proposes, a person approves, the client writes):
// - K3 `x-on-behalf-of` on changes: a label kept with the import, answered with it and shown in History, never access;
// - K4 `expectedVersion` on notes and corrections: refused at another version (409 version_changed, nothing created),
//   checked again when the import applies (a failed import with error version_changed), and replayed first;
// - K7 `GET /api/collections/{id}/gaps`: the questions nothing covered, for Editors with permission to change content.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

/** An API client of the organization, Editor in Knowledge ("CRM sync"). */
const CLIENT: Person = { ...PEOPLE.client, role: 'EDITOR' }
const RULE = 'Deals above $25,000 need sign-off from the alliance lead.'
const count = async (sql: string, ...values: unknown[]) => Number(await h.db.prepare(sql).bind(...values).first('n'))
const setLimit = (key: string, value: number | null) =>
  h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, ?, ?, NULL, 0) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).bind(ORG, key, value).run()
const clearLimits = () => h.db.prepare(`DELETE FROM org_limits WHERE org_id = ?`).bind(ORG).run()

type ImportAnswer = { import: { importId: string; state: string; version: number | null; onBehalfOf: string | null; error: { error: string; message: string } | null } }

/** A collection Maya owns, which knows one note (version 1), shared with the API client as Editor. */
async function collection(): Promise<string> {
  const id = await h.collection(PEOPLE.maya)
  await h.note(PEOPLE.maya, id, RULE, 'Approvals')
  expect(await h.share(PEOPLE.maya, id, CLIENT, 'EDITOR')).toBe(200)
  return id
}

const versionOf = async (id: string) => (await h.json<{ engine: { version: number } }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)).body.engine.version
const importOf = async (id: string, importId: string, person: Person = CLIENT) => (await h.json<ImportAnswer>(person, 'GET', `/api/collections/${id}/imports/${importId}`)).body.import
const settle = async () => {
  h.engine.control.runUntilIdle()
  await h.tick()
}
const note = (id: string, body: Record<string, unknown>, headers: Record<string, string> = {}, person: Person = CLIENT) =>
  h.json<ImportAnswer & { error?: string; message?: string; currentVersion?: number; header?: string }>(person, 'POST', `/api/collections/${id}/notes`, body, headers)

describe('K4 expectedVersion on notes and corrections', () => {
  it('at another version: 409 version_changed with currentVersion, and nothing is created (the key can be used again)', async () => {
    const id = await collection()
    expect(await versionOf(id)).toBe(1)
    const before = { imports: await count(`SELECT COUNT(*) AS n FROM imports`), reservations: await count(`SELECT COUNT(*) AS n FROM reservations`) }
    const refused = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.', expectedVersion: 0 }, { 'idempotency-key': 'agent-key-0001' })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ error: 'version_changed', currentVersion: 1 })
    expect(refused.body.message).toMatch(/changed since version 0: it is at version 1 now, so nothing was added/)
    const correction = await h.json<{ error: string; currentVersion: number }>(CLIENT, 'POST', `/api/collections/${id}/corrections`, { text: 'Deals above $50,000 need sign-off.', expectedVersion: 7 })
    expect(correction.status).toBe(409)
    expect(correction.body).toMatchObject({ error: 'version_changed', currentVersion: 1 })
    expect({ imports: await count(`SELECT COUNT(*) AS n FROM imports`), reservations: await count(`SELECT COUNT(*) AS n FROM reservations`) }).toEqual(before)
    expect(await count(`SELECT COUNT(*) AS n FROM corrections`)).toBe(0)
    expect(await count(`SELECT COUNT(*) AS n FROM idempotency WHERE key = 'agent-key-0001'`)).toBe(0)
    // The same key, now with the version the collection is at: accepted and learned, the import naming the version it made.
    const accepted = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.', expectedVersion: 1 }, { 'idempotency-key': 'agent-key-0001' })
    expect(accepted.status).toBe(202)
    await settle()
    expect(await importOf(id, accepted.body.import.importId)).toMatchObject({ state: 'committed', version: 2, error: null })
    expect(await versionOf(id)).toBe(2)
    expect((await h.json<{ collections: { id: string; version: number }[] }>(CLIENT, 'GET', '/api/collections')).body.collections.find((entry) => entry.id === id)?.version).toBe(2)
  })

  it('an accepted request sent again with the same key answers its import first, though the collection moved on', async () => {
    const id = await collection()
    const body = { title: 'Tiers', text: 'Gold partners renew every March.', expectedVersion: 1 }
    const first = await note(id, body, { 'idempotency-key': 'agent-key-0002' })
    expect(first.status).toBe(202)
    await settle()
    expect(await versionOf(id)).toBe(2)
    const replayed = await h.call(CLIENT, 'POST', `/api/collections/${id}/notes`, body, { 'idempotency-key': 'agent-key-0002' })
    expect(replayed.status).toBe(202)
    expect(replayed.headers.get('idempotent-replay')).toBe('true')
    expect(((await replayed.json()) as ImportAnswer).import.importId).toBe(first.body.import.importId)
    // Its saved answer gone (a day later, or a Worker cut short before it was saved): the import is found again, not refused.
    await h.db.prepare(`DELETE FROM idempotency WHERE key = 'agent-key-0002'`).run()
    const again = await note(id, body, { 'idempotency-key': 'agent-key-0002' })
    expect(again.status).toBe(202)
    expect(again.body.import).toMatchObject({ importId: first.body.import.importId, state: 'committed', version: 2 })
    expect(await count(`SELECT COUNT(*) AS n FROM imports WHERE kind = 'note'`)).toBe(2)
    // A correction too.
    const fix = { text: 'Deals above $50,000 need sign-off.', expectedVersion: 2 }
    const fixed = await h.json<ImportAnswer>(CLIENT, 'POST', `/api/collections/${id}/corrections`, fix, { 'idempotency-key': 'agent-key-0003' })
    expect(fixed.status).toBe(202)
    await settle()
    const fixedAgain = await h.json<ImportAnswer>(CLIENT, 'POST', `/api/collections/${id}/corrections`, fix, { 'idempotency-key': 'agent-key-0003' })
    expect(fixedAgain.status).toBe(202)
    expect(fixedAgain.body.import.importId).toBe(fixed.body.import.importId)
    expect(await count(`SELECT COUNT(*) AS n FROM corrections`)).toBe(1)
  })

  it('accepted, then queued behind a change that commits first: it fails with version_changed when it applies, learning nothing', async () => {
    const id = await collection()
    h.engine.control.hold(true)
    const ahead = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.' }, {}, PEOPLE.maya)
    expect(ahead.status).toBe(202)
    const behind = await note(id, { title: 'Silver', text: 'Silver partners renew every June.', expectedVersion: 1 })
    expect(behind.status).toBe(202)
    h.engine.control.hold(false)
    await settle()
    expect(await importOf(id, ahead.body.import.importId)).toMatchObject({ state: 'committed', version: 2 })
    const failed = await importOf(id, behind.body.import.importId)
    expect(failed.state).toBe('failed')
    expect(failed.error).toMatchObject({ error: 'version_changed' })
    expect(failed.error!.message).toMatch(/it is at version 2 now, not 1, so nothing was learned/)
    expect((await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources.map((source) => source.name).sort()).toEqual(['Approvals', 'Tiers'])
    expect(await h.db.prepare(`SELECT error_code FROM imports WHERE id = ?`).bind(behind.body.import.importId).first('error_code')).toBe('version_changed')
    // Its writer is told in its status; Needs attention, for what only a person can settle, doesn't list it.
    const attention = await h.json<{ collections: { id: string; items: { kind: string }[] }[] }>(PEOPLE.maya, 'GET', '/api/attention')
    expect(attention.body.collections.find((entry) => entry.id === id)?.items.filter((item) => item.kind === 'unreadable')).toEqual([])
    // What it reserved is free again.
    expect(await count(`SELECT COUNT(*) AS n FROM reservations WHERE ref = ? AND state = 'held'`, `import:${behind.body.import.importId}`)).toBe(0)
  })

  it('a change committed while it learns (a file stopped) fails it at the commit', async () => {
    const id = await collection()
    const [approvals] = (await h.json<{ sources: { documentId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources
    h.engine.control.hold(true)
    const learning = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.', expectedVersion: 1 })
    expect(learning.status).toBe(202)
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}/sources/${approvals!.documentId}`, { active: false })).status).toBe(200)
    h.engine.control.hold(false)
    await settle()
    expect(await importOf(id, learning.body.import.importId)).toMatchObject({ state: 'failed', error: { error: 'version_changed' } })
    expect(await versionOf(id)).toBe(2)
  })

  it('an import that waited for the 1st, applied after the version moved, fails with version_changed', async () => {
    const id = await collection()
    const [approvals] = (await h.json<{ sources: { documentId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources
    await setLimit('learned_month', 1)
    const waiting = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.', expectedVersion: 1 }, { 'x-on-behalf-of': 'Ana Lee' })
    expect(waiting.status).toBe(202)
    expect(waiting.body.import).toMatchObject({ state: 'waiting', onBehalfOf: 'Ana Lee' })
    const kept = JSON.parse(String(await h.db.prepare(`SELECT request FROM imports WHERE id = ?`).bind(waiting.body.import.importId).first('request'))) as { expectedVersion?: number }
    expect(kept.expectedVersion).toBe(1)
    // The collection moves on while it waits (stopping a file learns nothing, so the month's limit doesn't stop it).
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}/sources/${approvals!.documentId}`, { active: false })).status).toBe(200)
    await settle()
    expect(await versionOf(id)).toBe(2)
    // The 1st: it is sent with the version it was based on, and the engine refuses to learn it.
    await clearLimits()
    await settle()
    await settle()
    const failed = await importOf(id, waiting.body.import.importId)
    expect(failed).toMatchObject({ state: 'failed', error: { error: 'version_changed' }, onBehalfOf: 'Ana Lee' })
    expect((await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources.map((source) => source.name)).toEqual(['Approvals'])
  })

  it('without expectedVersion nothing is checked: changes queued together are all learned', async () => {
    const id = await collection()
    h.engine.control.hold(true)
    const first = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.' })
    const second = await note(id, { title: 'Silver', text: 'Silver partners renew every June.' })
    expect([first.status, second.status]).toEqual([202, 202])
    h.engine.control.hold(false)
    await settle()
    expect((await importOf(id, first.body.import.importId)).state).toBe('committed')
    expect((await importOf(id, second.body.import.importId)).state).toBe('committed')
  })

  it('expectedVersion must be a whole number, 0 or more', async () => {
    const id = await collection()
    for (const expectedVersion of [-1, 1.5, '1', null]) {
      const refused = await note(id, { text: 'Gold partners renew every March.', expectedVersion })
      expect({ expectedVersion, status: refused.status, error: refused.body.error }).toEqual({ expectedVersion, status: 400, error: 'bad_request' })
    }
    expect(await count(`SELECT COUNT(*) AS n FROM imports WHERE kind = 'note'`)).toBe(1)
  })
})

describe('K3 x-on-behalf-of on changes', () => {
  it('over 200 characters or with control characters: 400 naming the header, and nothing is created', async () => {
    const id = await collection()
    const before = await count(`SELECT COUNT(*) AS n FROM imports`)
    for (const value of ['A'.repeat(201), 'Ana\u0007Lee', 'Ana\u0085Lee']) {
      const refused = await note(id, { text: 'Gold partners renew every March.' }, { 'x-on-behalf-of': value })
      expect(refused.status).toBe(400)
      expect(refused.body).toMatchObject({ error: 'bad_request', header: 'x-on-behalf-of' })
      expect(refused.body.message).toMatch(/x-on-behalf-of/)
    }
    const fix = await h.json<{ error: string; header: string }>(CLIENT, 'POST', `/api/collections/${id}/corrections`, { text: 'Deals above $50,000 need sign-off.' }, { 'x-on-behalf-of': 'B'.repeat(201) })
    expect(fix.body).toMatchObject({ error: 'bad_request', header: 'x-on-behalf-of' })
    expect(await count(`SELECT COUNT(*) AS n FROM imports`)).toBe(before)
    // Exactly 200 characters, trimmed, is kept; blank is the same as none.
    const longest = await note(id, { text: 'Gold partners renew every March.' }, { 'x-on-behalf-of': `  ${'C'.repeat(200)}  ` })
    expect(longest.status).toBe(202)
    expect(longest.body.import.onBehalfOf).toBe('C'.repeat(200))
    const blank = await note(id, { text: 'Silver partners renew every June.' }, { 'x-on-behalf-of': '   ' })
    expect(blank.body.import.onBehalfOf).toBeNull()
    // A label grants nothing: a Viewer naming someone is still refused.
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'VIEWER')
    expect((await note(id, { text: 'From a Viewer.' }, { 'x-on-behalf-of': 'Maya Example' }, PEOPLE.eli)).body.error).toBe('forbidden')
  })

  it('is kept with the import and answered with it: the change, its status, the lists and History', async () => {
    const id = await collection()
    h.clock.advance(6 * 60_000)
    const added = await note(id, { title: 'Tiers', text: 'Gold partners renew every March.' }, { 'x-on-behalf-of': 'Ana Lee' })
    expect(added.status).toBe(202)
    expect(added.body.import.onBehalfOf).toBe('Ana Lee')
    expect(await h.db.prepare(`SELECT on_behalf_of FROM imports WHERE id = ?`).bind(added.body.import.importId).first('on_behalf_of')).toBe('Ana Lee')
    await settle()
    expect(await importOf(id, added.body.import.importId)).toMatchObject({ state: 'committed', onBehalfOf: 'Ana Lee' })
    // A correction, within 5 minutes: the same restore point, and the client named once for Ana Lee.
    const fixed = await h.json<ImportAnswer>(CLIENT, 'POST', `/api/collections/${id}/corrections`, { text: 'Gold partners renew every April.' }, { 'x-on-behalf-of': 'Ana Lee' })
    expect(fixed.body.import.onBehalfOf).toBe('Ana Lee')
    await settle()
    type Point = { version: number; madeBy: { id: string; type: string; name: string | null; onBehalfOf: string | null }[] }
    const history = (await h.json<{ restorePoints: Point[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/history`)).body.restorePoints
    expect(history.map((point) => point.version)).toEqual([3, 1])
    expect(history[0]!.madeBy).toEqual([{ id: CLIENT.id, type: 'client', name: 'CRM sync', onBehalfOf: 'Ana Lee' }])
    expect(history[1]!.madeBy).toEqual([{ id: PEOPLE.maya.id, type: 'person', name: 'Maya Example', onBehalfOf: null }])
    // Going back is a change with no import: it names no one.
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/history/1/go-back`)).status).toBe(200)
    const after = (await h.json<{ restorePoints: Point[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/history`)).body.restorePoints
    expect(after[0]).toMatchObject({ version: 4, madeBy: [] })
  })

  it('names each writer of a shared restore point once per whom they acted for', async () => {
    const id = await collection()
    h.clock.advance(6 * 60_000)
    await note(id, { title: 'Tiers', text: 'Gold partners renew every March.' }, {}, PEOPLE.maya)
    await note(id, { title: 'Silver', text: 'Silver partners renew every June.' }, { 'x-on-behalf-of': 'Ana Lee' })
    await note(id, { title: 'Bronze', text: 'Bronze partners renew every May.' }, { 'x-on-behalf-of': 'Bo Chen' })
    await note(id, { title: 'Copper', text: 'Copper partners renew every July.' }, { 'x-on-behalf-of': 'Ana Lee' })
    await settle()
    const [latest] = (await h.json<{ restorePoints: { madeBy: { name: string | null; onBehalfOf: string | null }[] }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/history`)).body.restorePoints
    expect(latest!.madeBy.map((entry) => [entry.name, entry.onBehalfOf])).toEqual([['Maya Example', null], ['CRM sync', 'Ana Lee'], ['CRM sync', 'Bo Chen']])
  })

  it('a retry with the same key keeps the first request\'s value: it isn\'t part of the request a retry repeats', async () => {
    const id = await collection()
    const body = { title: 'Tiers', text: 'Gold partners renew every March.' }
    const first = await note(id, body, { 'idempotency-key': 'agent-key-0101', 'x-on-behalf-of': 'Ana Lee' })
    expect(first.status).toBe(202)
    const replayed = await note(id, body, { 'idempotency-key': 'agent-key-0101', 'x-on-behalf-of': 'Bo Chen' })
    expect(replayed.status).toBe(202)
    expect(replayed.body.import).toMatchObject({ importId: first.body.import.importId, onBehalfOf: 'Ana Lee' })
    await h.db.prepare(`DELETE FROM idempotency WHERE key = 'agent-key-0101'`).run()
    const again = await note(id, body, { 'idempotency-key': 'agent-key-0101', 'x-on-behalf-of': 'Bo Chen' })
    expect(again.body.import).toMatchObject({ importId: first.body.import.importId, onBehalfOf: 'Ana Lee' })
    expect(await h.db.prepare(`SELECT on_behalf_of FROM imports WHERE id = ?`).bind(first.body.import.importId).first('on_behalf_of')).toBe('Ana Lee')
  })

  it('on web pages and while an import waits for the 1st; a value sent as UTF-8 reads as UTF-8', async () => {
    h.env.WEB_FETCH = (async () => new Response('<html><head><title>Terms</title></head><body><p>Gold partners renew every March.</p></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch
    const id = await collection()
    const page = await h.json<ImportAnswer>(CLIENT, 'POST', `/api/collections/${id}/web-pages`, { url: 'https://www.example.com/terms' }, { 'x-on-behalf-of': 'Ana Lee' })
    expect(page.status).toBe(202)
    expect(page.body.import.onBehalfOf).toBe('Ana Lee')
    await setLimit('learned_month', 0)
    // "José Núñez" as its UTF-8 bytes, one character each, as HTTP carries them.
    const bytes = String.fromCharCode(...new TextEncoder().encode('José Núñez'))
    const waiting = await note(id, { text: 'Silver partners renew every June.' }, { 'x-on-behalf-of': bytes })
    expect(waiting.body.import).toMatchObject({ state: 'waiting', onBehalfOf: 'José Núñez' })
    const listed = await h.json<{ imports: { importId: string; createdBy: { id: string; name: string | null }; onBehalfOf: string | null }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports?state=waiting`)
    expect(listed.body.imports).toEqual([expect.objectContaining({ importId: waiting.body.import.importId, createdBy: { id: CLIENT.id, name: 'CRM sync' }, onBehalfOf: 'José Núñez' })])
    expect(await importOf(id, waiting.body.import.importId, PEOPLE.maya)).toMatchObject({ state: 'waiting', onBehalfOf: 'José Núñez' })
  })
})

describe('K7 GET /api/collections/{id}/gaps', () => {
  type Gaps = { gaps: { question: string; asked: number; firstAskedAt: string; lastAskedAt: string }[]; next?: string; error?: string }
  const search = (id: string, query: string, person: Person = PEOPLE.maya) => h.json<{ covered: boolean }>(person, 'POST', '/api/search', { collections: [id], query })
  const gaps = (id: string, person: Person = CLIENT, query = '') => h.json<Gaps>(person, 'GET', `/api/collections/${id}/gaps${query}`)

  it('lists the questions nothing covered, newest asked first, with how often and when; values the organization hides show as [hidden]', async () => {
    const id = await collection()
    const other = await h.collection(PEOPLE.maya, 'Other')
    await h.note(PEOPLE.maya, other, RULE)
    expect((await search(id, 'What is the office parking policy?')).body.covered).toBe(false)
    h.clock.advance(60_000)
    expect((await search(id, 'Can I email dana@example.test about the travel budget?', PEOPLE.maya)).body.covered).toBe(false)
    h.clock.advance(60_000)
    await search(id, 'What is the office parking policy??')
    await search(other, 'Who orders the team lunch?')
    // Covered questions aren't gaps.
    expect((await search(id, 'Who signs off deals above $25,000?')).body.covered).toBe(true)
    await h.db.prepare(`UPDATE gaps SET status = 'answered' WHERE question LIKE 'Who orders%'`).run()
    const listed = await gaps(id)
    expect(listed.status).toBe(200)
    expect(listed.body.next).toBeUndefined()
    expect(listed.body.gaps).toEqual([
      { question: 'What is the office parking policy?', asked: 2, firstAskedAt: new Date(Date.UTC(2026, 10, 16, 9, 0, 0)).toISOString(), lastAskedAt: new Date(Date.UTC(2026, 10, 16, 9, 2, 0)).toISOString() },
      { question: 'Can I email [hidden] about the travel budget?', asked: 1, firstAskedAt: new Date(Date.UTC(2026, 10, 16, 9, 1, 0)).toISOString(), lastAskedAt: new Date(Date.UTC(2026, 10, 16, 9, 1, 0)).toISOString() },
    ])
    expect((await gaps(other, PEOPLE.maya)).body.gaps).toEqual([])
  })

  it('pages: 50 by default, at most 100, `next` while there are more, ties kept in order across pages', async () => {
    const id = await collection()
    const at = Date.UTC(2026, 10, 10)
    // 55 open questions, the last 10 asked at the same moment, so a page ends inside a tie.
    const statements = Array.from({ length: 55 }, (_, n) => h.db.prepare(
      `INSERT INTO gaps (collection_id, question_key, org_id, question, asked, first_asked_at, last_asked_at, status) VALUES (?, ?, ?, ?, 1, ?, ?, 'open')`,
    ).bind(id, `question ${String(n).padStart(2, '0')}`, ORG, `Question ${n}?`, at, n < 10 ? at : at + n * 1000))
    await h.db.batch(statements)
    const first = await gaps(id)
    expect(first.body.gaps).toHaveLength(50)
    expect(first.body.gaps[0]!.question).toBe('Question 54?')
    expect(first.body.next).toEqual(expect.any(String))
    const second = await gaps(id, CLIENT, `?cursor=${first.body.next}`)
    expect(second.body.gaps).toHaveLength(5)
    expect(second.body.next).toBeUndefined()
    const all = [...first.body.gaps, ...second.body.gaps].map((gap) => gap.question)
    expect(new Set(all).size).toBe(55)
    expect(all.slice(45)).toEqual(['Question 0?', 'Question 1?', 'Question 2?', 'Question 3?', 'Question 4?', 'Question 5?', 'Question 6?', 'Question 7?', 'Question 8?', 'Question 9?'])
    const small = await gaps(id, CLIENT, '?limit=7')
    expect(small.body.gaps).toHaveLength(7)
    const rest = await gaps(id, CLIENT, `?limit=100&cursor=${small.body.next}`)
    expect(rest.body.gaps).toHaveLength(48)
    expect(rest.body.next).toBeUndefined()
    for (const query of ['?limit=0', '?limit=101', '?limit=ten', '?cursor=not-a-cursor', '?cursor=%25%25']) {
      const refused = await gaps(id, CLIENT, query)
      expect({ query, status: refused.status, error: refused.body.error }).toEqual({ query, status: 400, error: 'bad_request' })
    }
  })

  it('for Editors and above with permission to change content: a Viewer, and an API client allowed only to ask, are refused', async () => {
    const id = await collection()
    await search(id, 'What is the office parking policy?')
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'VIEWER')
    expect((await gaps(id, PEOPLE.maya)).body.gaps).toHaveLength(1)
    expect((await gaps(id, { ...PEOPLE.maya, via: 'mcp' })).body.gaps).toHaveLength(1)
    expect((await gaps(id, CLIENT)).body.gaps).toHaveLength(1)
    expect(await gaps(id, PEOPLE.eli)).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    // Shared as Editor, but its role in Knowledge only asks and reads: it acts as Viewer.
    const askOnly: Person = { ...CLIENT, permissions: ['knowledge.use'] }
    expect(await gaps(id, askOnly)).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    const editorWhoReads: Person = { ...PEOPLE.maya, permissions: ['knowledge.use'] }
    expect(await gaps(id, editorWhoReads)).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(await gaps(id, PEOPLE.ada)).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(await gaps(id, PEOPLE.outsider)).toMatchObject({ status: 404, body: { error: 'not_found' } })
    // The catalog lists it only for those who may use it.
    const listed = async (person: Person) => (await h.json<{ endpoints: { method: string; path: string }[] }>(person, 'GET', '/api/catalog')).body.endpoints.some((entry) => entry.path === '/api/collections/{id}/gaps')
    expect(await listed(CLIENT)).toBe(true)
    expect(await listed(askOnly)).toBe(false)
    expect(await listed(PEOPLE.leo)).toBe(false)
    // With the switch for assistants and API clients off, they get 403 assistants_off; the owner on the site still sees it.
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    expect(await gaps(id, CLIENT)).toMatchObject({ status: 403, body: { error: 'assistants_off' } })
    expect((await gaps(id, PEOPLE.maya)).status).toBe(200)
  })
})
