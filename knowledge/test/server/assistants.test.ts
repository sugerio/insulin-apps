import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_ROUTES } from '../../src/app/server/catalog.ts'
import { createHarness, ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// AI assistants (MCP, acting as their person) and API clients (principals of their own): plans AGT-01 to AGT-07.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const mcp = (person: Person): Person => ({ ...person, via: 'mcp' })
const search = (person: Person, collections: unknown, query = 'partner discounts percent') => h.json<Record<string, any>>(person, 'POST', '/api/search', { collections, query })

describe('AI assistants and API clients', () => {
  it('AGT-01 an assistant lists only its person\'s collections, with names and purposes', async () => {
    const mine = await h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
    await h.collection(PEOPLE.eli, 'Eli only')
    const listed = await h.json<{ collections: { id: string; name: string; purpose: string }[] }>(mcp(PEOPLE.maya), 'GET', '/api/collections')
    // Must catch: a collection not shared with the Editor is absent.
    expect(listed.body.collections).toEqual([expect.objectContaining({ id: mine, name: 'Partner Programs', purpose: 'What the partner team knows' })])
  })

  it('AGT-02 every search names collections: none is 400 collection_required, 6 is too_many_collections, 2 searches only those', async () => {
    const ids = [] as string[]
    for (let index = 0; index < 6; index += 1) ids.push(await h.collection(PEOPLE.maya, `Collection ${index}`))
    for (const person of [mcp(PEOPLE.maya), PEOPLE.maya]) {
      const none = await h.json<{ error: string; message: string }>(person, 'POST', '/api/search', { query: 'anything' })
      // Must catch: the 400 with none.
      expect(none.status).toBe(400)
      expect(none.body.error).toBe('collection_required')
      expect((await search(person, [])).body.error).toBe('collection_required')
      expect((await search(person, ids)).body.error).toBe('too_many_collections')
    }
    await h.note(PEOPLE.maya, ids[0]!, 'Partner discounts stop at 20 percent.')
    await h.note(PEOPLE.maya, ids[2]!, 'Partner discounts need approval above 10 percent.')
    const two = await search(mcp(PEOPLE.maya), [ids[0], ids[1]])
    expect(two.body.collections.map((entry: { id: string }) => entry.id)).toEqual([ids[0], ids[1]])
    expect(two.body.passages.every((passage: { collectionId: string }) => passage.collectionId === ids[0])).toBe(true)
    expect(await h.db.prepare(`SELECT COUNT(DISTINCT collection_id) AS n FROM questions WHERE answer_id IN (SELECT answer_id FROM questions WHERE collection_id = ?)`).bind(ids[0]).first('n')).toBe(2)
    const asked = await h.db.prepare(`SELECT DISTINCT collection_id FROM questions`).all<{ collection_id: string }>()
    expect(asked.results.map((row) => row.collection_id).sort()).toEqual([ids[0], ids[1]].sort())
  })

  it('AGT-03 an assistant gets its person\'s access: no role 403, the switch off 403, a demotion at once', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    expect((await search(mcp(PEOPLE.eli), [id])).status).toBe(403)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    expect((await search(mcp(PEOPLE.eli), [id])).status).toBe(200)
    expect((await h.call(mcp(PEOPLE.eli), 'POST', `/api/collections/${id}/notes`, { text: 'From the assistant.' })).status).toBe(202)
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    const off = await search(mcp(PEOPLE.eli), [id])
    // Must catch: the switch-off 403.
    expect(off.status).toBe(403)
    expect(off.body.error).toBe('assistants_off')
    expect((await search(PEOPLE.eli, [id])).status).toBe(200)
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: true })
    const demoted = mcp({ ...PEOPLE.eli, role: 'VIEWER' })
    expect((await h.call(demoted, 'POST', `/api/collections/${id}/notes`, { text: 'Not any more.' })).status).toBe(403)
  })

  it('AGT-04 API clients need a share by name: general access isn\'t enough', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.call(PEOPLE.maya, 'PUT', `/api/collections/${id}/sharing/general`, { role: 'VIEWER' })
    // Must catch: the 403 under general access.
    expect((await search(PEOPLE.client, [id])).status).toBe(403)
    expect((await h.json<{ collections: unknown[] }>(PEOPLE.client, 'GET', '/api/collections')).body.collections).toEqual([])
    expect(await h.share(PEOPLE.maya, id, PEOPLE.client, 'VIEWER')).toBe(200)
    const found = await search(PEOPLE.client, [id])
    expect(found.status).toBe(200)
    expect(found.body.covered).toBe(true)
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    expect((await search(PEOPLE.client, [id])).status).toBe(403)
    expect((await h.call(PEOPLE.client, 'POST', '/api/collections', { name: 'From a client' })).status).toBe(403)
  })

  it('AGT-05 a sleeping collection answers "waking, ask again" at once, not after the wake', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    h.engine.control.setState(ORG, id, 'asleep')
    const started = performance.now()
    const asleep = await search(mcp(PEOPLE.maya), [id])
    // Must catch: the 2-second bound.
    expect(performance.now() - started).toBeLessThan(2000)
    expect(asleep.status).toBe(200)
    expect(asleep.body).toMatchObject({ status: 'waking', covered: false, passages: [] })
    expect(asleep.body.retryAfterSeconds).toBeGreaterThan(0)
    expect(asleep.body.message).toMatch(/Waking up “Partner Programs”/)
    // The question didn't count: nothing was answered.
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM usage_counters WHERE key = 'questions_month'`).first('n')).toBe(0)
    h.clock.advance(61_000)
    expect((await search(mcp(PEOPLE.maya), [id])).body.status).toBe('ok')
  })

  it('AGT-06 the catalog lists only what the caller may call, with the collection requirement and error codes', async () => {
    const client = await h.json<{ endpoints: { method: string; path: string; summary: string; errors: string[] }[] }>({ ...PEOPLE.client, role: 'ADMIN' }, 'GET', '/api/catalog')
    const routes = client.body.endpoints.map((entry) => `${entry.method} ${entry.path}`)
    // Must catch: share and delete aren't listed.
    expect(routes.filter((route) => /sharing|members|exports|transfer|^DELETE \/api\/collections\/\{id\}$|^PATCH \/api\/collections\/\{id\}$|^PUT \/api\/rules$/.test(route))).toEqual([])
    expect(routes).not.toContain('POST /api/ask')
    expect(routes).not.toContain('POST /api/collections')
    expect(routes).not.toContain('POST /api/scheduled')
    const searchEntry = client.body.endpoints.find((entry) => entry.path === '/api/search')!
    expect(searchEntry.summary).toMatch(/named collections/)
    expect(searchEntry.errors.join(' ')).toMatch(/collection_required/)
    expect(searchEntry.errors.join(' ')).toMatch(/too_many_collections/)
    const viewer = await h.json<{ endpoints: { method: string; path: string }[] }>(PEOPLE.leo, 'GET', '/api/catalog')
    expect(viewer.body.endpoints.map((entry) => `${entry.method} ${entry.path}`)).not.toContain('POST /api/collections/{id}/notes')
    const browser = await h.json<{ endpoints: { method: string; path: string }[] }>(PEOPLE.maya, 'GET', '/api/catalog')
    expect(browser.body.endpoints.map((entry) => `${entry.method} ${entry.path}`)).toContain('PUT /api/collections/{id}/sharing/{type}/{principalId}')
    expect(CATALOG_ROUTES).not.toContain('POST /api/scheduled')
  })

  it('AGT-07 questions from an assistant count as asked from the assistant', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await search(mcp(PEOPLE.maya), [id])
    await search(mcp(PEOPLE.maya), [id])
    await h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'What are the partner discounts?' })
    const numbers = await h.json<{ questions: Record<string, number> }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)
    // Must catch: the count by surface.
    expect(numbers.body.questions).toEqual({ browser: 1, mcp: 2, api: 0 })
  })
})
