import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// ACC-06 on every route and every way in (design section 08, "the authorization matrix on every route and every way
// in"): each route of a collection, called by its owner on the site and from an AI assistant, by an API client shared
// at the role it needs, by a collection Viewer, by someone with no role, by another organization with this one's ids,
// and by an assistant with the collection's switch off. An allowed call answers its exact status and does what it
// says; a refused one answers its exact error and changes nothing. Then the routes of the organization.

let open: Harness[] = []
afterEach(() => {
  for (const h of open) h.close()
  open = []
})

type Role = 'VIEWER' | 'EDITOR' | 'ADMIN' | 'OWNER'
const encoder = new TextEncoder()
const mcp = (person: Person): Person => ({ ...person, via: 'mcp' })
const CLIENT: Person = { ...PEOPLE.client, role: 'EDITOR' }
/** An Admin in Knowledge, shared one role below what each route needs. */
const BEA: Person = { id: 'u-bea', role: 'ADMIN', orgRole: 'ADMIN', name: 'Bea Example', email: 'bea@example.test' }
const BELOW: Record<Role, Exclude<Role, 'OWNER'> | null> = { VIEWER: null, EDITOR: 'VIEWER', ADMIN: 'EDITOR', OWNER: 'ADMIN' }
const count = async (h: Harness, sql: string, ...values: unknown[]) => Number(await h.db.prepare(sql).bind(...values).first('n'))

/** What a route's calls need: a collection that knows a note, with two restore points, a report and more. */
interface Fixture {
  h: Harness
  id: string
  docId: string
  factId: string
  passage: { documentId: string; textHash: string }
  reportId: string
  extra: Record<string, string>
}

async function fixture(min: Role, setup?: (f: Fixture) => Promise<void>): Promise<Fixture> {
  const h = await createHarness({ env: { WEB_FETCH: (async () => new Response('<html><head><title>Terms</title></head><body><p>Gold partners renew every March.</p></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch } })
  open.push(h)
  h.gateway.setMember(ORG, BEA.id, { appRole: 'ADMIN', orgRole: 'ADMIN', name: BEA.name, email: BEA.email })
  await h.call(BEA, 'GET', '/api/me')
  const id = await h.collection(PEOPLE.maya)
  await h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.', 'Approvals')
  h.clock.advance(6 * 60_000)
  await h.note(PEOPLE.maya, id, 'Gold partners renew every March.', 'Tiers')
  expect(await h.share(PEOPLE.maya, id, PEOPLE.eli, 'VIEWER')).toBe(200)
  if (min !== 'OWNER') expect(await h.share(PEOPLE.maya, id, CLIENT, min)).toBe(200)
  if (BELOW[min]) expect(await h.share(PEOPLE.maya, id, BEA, BELOW[min]!)).toBe(200)
  const sources = (await h.json<{ sources: { documentId: string; name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources
  const facts = (await h.json<{ facts: { factId: string; documentId: string; passageTextHash: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)).body.facts
  const report = await h.json<{ report: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/reports`, { question: 'Who signs off?' })
  const f: Fixture = {
    h, id, docId: sources.find((source) => source.name === 'Approvals')!.documentId, factId: facts[0]!.factId,
    passage: { documentId: facts[0]!.documentId, textHash: facts[0]!.passageTextHash }, reportId: report.body.report.id, extra: {},
  }
  await setup?.(f)
  return f
}

interface Route {
  name: string
  method: string
  path: (f: Fixture) => string
  body?: (f: Fixture) => unknown
  min: Role
  browserOnly?: boolean
  /** The collection the route names, when it isn't the fixture's own (a fresh, empty one). */
  target?: (f: Fixture) => string
  status: number
  setup?: (f: Fixture) => Promise<void>
  /** What an allowed call did. */
  effect: (f: Fixture, body: Record<string, unknown>) => Promise<void> | void
}

const ROUTES: Route[] = [
  { name: 'read the collection', method: 'GET', path: (f) => `/api/collections/${f.id}`, min: 'VIEWER', status: 200, effect: (f, body) => expect((body.collection as { id: string }).id).toBe(f.id) },
  { name: 'list its sources', method: 'GET', path: (f) => `/api/collections/${f.id}/sources`, min: 'VIEWER', status: 200, effect: (_, body) => expect(body.sources).toHaveLength(2) },
  { name: 'read a source', method: 'GET', path: (f) => `/api/collections/${f.id}/sources/${f.docId}`, min: 'VIEWER', status: 200, effect: (_, body) => expect((body.source as { text: string }).text).toContain('alliance lead') },
  { name: 'list its facts', method: 'GET', path: (f) => `/api/collections/${f.id}/facts`, min: 'VIEWER', status: 200, effect: (_, body) => expect((body.facts as unknown[]).length).toBeGreaterThan(0) },
  { name: 'check a fact', method: 'POST', path: (f) => `/api/collections/${f.id}/facts/${f.factId}/check`, min: 'EDITOR', status: 200, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM fact_checks WHERE fact_id = ?`, f.factId)).toBe(1) },
  { name: 'list its history', method: 'GET', path: (f) => `/api/collections/${f.id}/history`, min: 'VIEWER', status: 200, effect: (_, body) => expect(body.restorePoints).toHaveLength(2) },
  { name: 'preview going back', method: 'GET', path: (f) => `/api/collections/${f.id}/history/1/preview`, min: 'VIEWER', status: 200, effect: (_, body) => expect(body.preview).toMatchObject({ restorable: true }) },
  { name: 'report an answer', method: 'POST', path: (f) => `/api/collections/${f.id}/reports`, body: () => ({ question: 'Is this right?' }), min: 'VIEWER', status: 201, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM reports WHERE collection_id = ?`, f.id)).toBe(2) },
  { name: 'list its reports', method: 'GET', path: (f) => `/api/collections/${f.id}/reports`, min: 'VIEWER', status: 200, effect: (_, body) => expect(body.reports).toHaveLength(1) },
  { name: 'add a note', method: 'POST', path: (f) => `/api/collections/${f.id}/notes`, body: () => ({ text: 'Silver partners renew every June.' }), min: 'EDITOR', status: 202, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM imports WHERE collection_id = ? AND kind = 'note'`, f.id)).toBe(3) },
  {
    name: 'preflight files', method: 'POST', path: (f) => `/api/collections/${f.id}/preflight`, body: () => ({ files: [{ name: 'Terms.md', bytes: 30 }] }), min: 'EDITOR', status: 200,
    effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM staged_files WHERE collection_id = ? AND state = 'expected'`, f.id)).toBe(1),
  },
  {
    name: 'upload a file', method: 'PUT', path: (f) => `/api/collections/${f.id}/uploads/${f.extra.expected}`, body: () => encoder.encode('Gold partners renew in March.'), min: 'EDITOR', status: 200,
    setup: async (f) => { f.extra.expected = (await f.h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${f.id}/preflight`, { files: [{ name: 'Terms.md', bytes: 29 }] })).body.files[0]!.fileId },
    effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM staged_files WHERE id = ? AND state = 'staged'`, f.extra.expected)).toBe(1),
  },
  {
    name: 'learn uploaded files', method: 'POST', path: (f) => `/api/collections/${f.id}/imports`, body: (f) => ({ fileIds: [f.extra.staged] }), min: 'EDITOR', status: 202,
    setup: async (f) => {
      f.extra.staged = (await f.h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${f.id}/preflight`, { files: [{ name: 'Terms.md', bytes: 29 }] })).body.files[0]!.fileId
      await f.h.call(PEOPLE.maya, 'PUT', `/api/collections/${f.id}/uploads/${f.extra.staged}`, encoder.encode('Gold partners renew in March.'))
    },
    effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM imports WHERE collection_id = ? AND kind = 'files'`, f.id)).toBe(1),
  },
  {
    name: 'follow an import', method: 'GET', path: (f) => `/api/collections/${f.id}/imports/${f.extra.import}`, min: 'VIEWER', status: 200,
    setup: async (f) => { f.extra.import = (await f.h.db.prepare(`SELECT id FROM imports WHERE collection_id = ? ORDER BY created_at LIMIT 1`).bind(f.id).first<{ id: string }>())!.id },
    effect: (_, body) => expect((body.import as { state: string }).state).toBe('committed'),
  },
  {
    name: 'list waiting imports', method: 'GET', path: (f) => `/api/collections/${f.id}/imports?state=waiting`, min: 'VIEWER', status: 200,
    setup: async (f) => { await waiting(f) },
    effect: (_, body) => expect(body.imports).toHaveLength(1),
  },
  {
    name: 'cancel a waiting import', method: 'DELETE', path: (f) => `/api/collections/${f.id}/imports/${f.extra.waiting}`, min: 'EDITOR', status: 200, setup: waiting,
    effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM imports WHERE id = ? AND state = 'cancelled'`, f.extra.waiting)).toBe(1),
  },
  { name: 'add a web page', method: 'POST', path: (f) => `/api/collections/${f.id}/web-pages`, body: () => ({ url: 'https://www.example.com/terms' }), min: 'EDITOR', status: 202, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM imports WHERE collection_id = ? AND kind = 'web_page'`, f.id)).toBe(1) },
  { name: 'stop using a file', method: 'PATCH', path: (f) => `/api/collections/${f.id}/sources/${f.docId}`, body: () => ({ active: false }), min: 'EDITOR', status: 200, effect: async (f) => expect((await f.h.json<{ sources: { documentId: string; active: boolean }[] }>(PEOPLE.maya, 'GET', `/api/collections/${f.id}/sources`)).body.sources.find((source) => source.documentId === f.docId)!.active).toBe(false) },
  { name: 'remove a file for good', method: 'DELETE', path: (f) => `/api/collections/${f.id}/sources/${f.docId}`, min: 'ADMIN', status: 200, effect: (_, body) => expect(body.removed).toMatchObject({ version: 3 }) },
  { name: 'correct an answer', method: 'POST', path: (f) => `/api/collections/${f.id}/corrections`, body: (f) => ({ text: 'Deals above $50,000 need sign-off.', outdated: [f.passage] }), min: 'EDITOR', status: 202, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM corrections WHERE collection_id = ?`, f.id)).toBe(1) },
  {
    name: 'clear a correction to check', method: 'POST', path: (f) => `/api/collections/${f.id}/correction-checks/clear`, body: (f) => ({ noteId: 'n0000000000000000', documentId: f.passage.documentId, textHash: f.passage.textHash }), min: 'EDITOR', status: 200,
    setup: async (f) => { await f.h.db.prepare(`INSERT INTO correction_checks (collection_id, note_id, document_id, text_hash, org_id, at) VALUES (?, 'n0000000000000000', ?, ?, ?, 0)`).bind(f.id, f.passage.documentId, f.passage.textHash, ORG).run() },
    effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM correction_checks WHERE collection_id = ?`, f.id)).toBe(0),
  },
  { name: 'settle a report', method: 'PATCH', path: (f) => `/api/collections/${f.id}/reports/${f.reportId}`, body: () => ({ status: 'dismissed' }), min: 'EDITOR', status: 200, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM reports WHERE id = ? AND status = 'dismissed'`, f.reportId)).toBe(1) },
  { name: 'go back', method: 'POST', path: (f) => `/api/collections/${f.id}/history/1/go-back`, min: 'EDITOR', status: 200, effect: (_, body) => expect((body.collection as { version: number }).version).toBe(3) },
  {
    name: 'undo going back', method: 'POST', path: (f) => `/api/collections/${f.id}/history/undo`, min: 'EDITOR', status: 200,
    setup: async (f) => { expect((await f.h.call(PEOPLE.maya, 'POST', `/api/collections/${f.id}/history/1/go-back`)).status).toBe(200) },
    effect: (_, body) => expect((body.collection as { counts: { activeDocuments: number } }).counts.activeDocuments).toBe(2),
  },
  { name: 'change its settings', method: 'PATCH', path: (f) => `/api/collections/${f.id}`, body: () => ({ purpose: 'Changed.' }), min: 'ADMIN', browserOnly: true, status: 200, effect: async (f) => expect(await f.h.db.prepare(`SELECT purpose FROM collections WHERE id = ?`).bind(f.id).first('purpose')).toBe('Changed.') },
  { name: 'read its sharing', method: 'GET', path: (f) => `/api/collections/${f.id}/sharing`, min: 'VIEWER', browserOnly: true, status: 200, effect: (_, body) => expect((body.shares as { id: string }[]).map((share) => share.id)).toContain(PEOPLE.eli.id) },
  { name: 'share with everyone', method: 'PUT', path: (f) => `/api/collections/${f.id}/sharing/general`, body: () => ({ role: 'VIEWER' }), min: 'ADMIN', browserOnly: true, status: 200, effect: async (f) => expect(await f.h.db.prepare(`SELECT general_role FROM collections WHERE id = ?`).bind(f.id).first('general_role')).toBe('VIEWER') },
  { name: 'share with a person', method: 'PUT', path: (f) => `/api/collections/${f.id}/sharing/person/${PEOPLE.leo.id}`, body: () => ({ role: 'VIEWER' }), min: 'ADMIN', browserOnly: true, status: 200, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM collection_shares WHERE collection_id = ? AND principal_id = ?`, f.id, PEOPLE.leo.id)).toBe(1) },
  { name: 'stop sharing with a person', method: 'DELETE', path: (f) => `/api/collections/${f.id}/sharing/person/${PEOPLE.eli.id}`, min: 'ADMIN', browserOnly: true, status: 200, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM collection_shares WHERE collection_id = ? AND principal_id = ?`, f.id, PEOPLE.eli.id)).toBe(0) },
  { name: 'export it', method: 'POST', path: (f) => `/api/collections/${f.id}/exports`, min: 'ADMIN', browserOnly: true, status: 202, effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM exports WHERE collection_id = ?`, f.id)).toBe(1) },
  {
    name: 'follow an export', method: 'GET', path: (f) => `/api/collections/${f.id}/exports/${f.extra.export}`, min: 'ADMIN', browserOnly: true, status: 200,
    setup: async (f) => { f.extra.export = (await f.h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${f.id}/exports`)).body.export.exportId },
    effect: (_, body) => expect((body.export as { state: string }).state).toBe('ready'),
  },
  { name: 'transfer it', method: 'POST', path: (f) => `/api/collections/${f.id}/transfer`, body: () => ({ to: PEOPLE.ada.id }), min: 'OWNER', browserOnly: true, status: 200, effect: async (f) => expect(await f.h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(f.id).first('owner_id')).toBe(PEOPLE.ada.id) },
  { name: 'delete it', method: 'DELETE', path: (f) => `/api/collections/${f.id}`, body: () => ({ confirmName: 'Partner Programs' }), min: 'OWNER', browserOnly: true, status: 202, effect: async (f) => expect(await f.h.db.prepare(`SELECT state FROM collections WHERE id = ?`).bind(f.id).first('state')).toBe('deleted') },
  {
    name: 'start from an export', method: 'POST', path: (f) => `/api/collections/${f.extra.empty}/import-export`, body: (f) => ({ fileId: f.extra.zip }), target: (f) => f.extra.empty!, min: 'EDITOR', status: 202,
    setup: async (f) => {
      const made = await f.h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${f.id}/exports`)
      const zip = new Uint8Array(await (await f.h.call(PEOPLE.maya, 'GET', `/api/collections/${f.id}/exports/${made.body.export.exportId}?download=1`)).arrayBuffer())
      f.extra.empty = await f.h.collection(PEOPLE.maya, 'Empty')
      await f.h.share(PEOPLE.maya, f.extra.empty, PEOPLE.eli, 'VIEWER')
      await f.h.share(PEOPLE.maya, f.extra.empty, CLIENT, 'EDITOR')
      await f.h.share(PEOPLE.maya, f.extra.empty, BEA, 'VIEWER')
      const pre = await f.h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${f.extra.empty}/preflight`, { files: [{ name: 'export.zip', bytes: zip.byteLength }], export: true })
      f.extra.zip = pre.body.files[0]!.fileId
      await f.h.call(PEOPLE.maya, 'PUT', `/api/collections/${f.extra.empty}/uploads/${f.extra.zip}`, zip)
    },
    effect: async (f) => expect(await count(f.h, `SELECT COUNT(*) AS n FROM imports WHERE collection_id = ?`, f.extra.empty)).toBe(1),
  },
]

/** An import waiting for the 1st in the fixture's collection. */
async function waiting(f: Fixture) {
  await f.h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'learned_month', 0, NULL, 0)`).bind(ORG).run()
  f.extra.waiting = (await f.h.json<{ import: { importId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${f.id}/notes`, { text: 'Waits for the 1st.' })).body.import.importId
}

type Caller = { name: string; person: Person; switchOff?: boolean }
const OWNER: Caller = { name: 'its owner, on the site', person: PEOPLE.maya }
const OWNER_MCP: Caller = { name: 'its owner, from an AI assistant', person: mcp(PEOPLE.maya) }
const API_CLIENT: Caller = { name: 'an API client shared at the role needed', person: CLIENT }
const VIEWER: Caller = { name: 'a collection Viewer', person: PEOPLE.eli }
const NO_ROLE: Caller = { name: 'someone with no role in it', person: PEOPLE.ada }
const ONE_BELOW: Caller = { name: 'an Admin in Knowledge shared one role below what it needs', person: BEA }
const OTHER_ORG: Caller = { name: 'another organization, with its ids', person: PEOPLE.outsider }
const SWITCH_OFF: Caller = { name: 'its owner\'s assistant, with the switch off', person: mcp(PEOPLE.maya), switchOff: true }

/** What a caller gets: the route's own status, or the error that refuses it. */
function expected(route: Route, caller: Caller): { status: number; error?: string } {
  const ok = { status: route.status }
  if (caller === OTHER_ORG) return { status: 404, error: 'not_found' }
  if (route.browserOnly && caller.person.via && caller.person.via !== 'browser') return { status: 403, error: 'browser_only' }
  if (caller === SWITCH_OFF) return { status: 403, error: 'assistants_off' }
  if (caller === NO_ROLE || caller === ONE_BELOW) return { status: 403, error: 'forbidden' }
  if (caller === VIEWER) return route.min === 'VIEWER' ? ok : { status: 403, error: 'forbidden' }
  if (caller === API_CLIENT && route.min === 'OWNER') return { status: 403, error: 'forbidden' }
  return ok
}

/** What a refused call must leave as it was: the collection and what it holds (not who was seen, or saved answers). */
async function fingerprint(h: Harness): Promise<string> {
  const tables = ['imports', 'reports', 'corrections', 'collection_shares', 'fact_checks', 'exports', 'correction_checks', 'history', 'reservations']
  const counts = await Promise.all(tables.map(async (table) => [table, await count(h, `SELECT COUNT(*) AS n FROM ${table}`)]))
  const rows = await h.db.prepare(`SELECT id, owner_id, general_role, purpose, state, documents, version FROM collections ORDER BY id`).all()
  const staged = await h.db.prepare(`SELECT id, state FROM staged_files ORDER BY id`).all()
  const shares = await h.db.prepare(`SELECT principal_id, role, status FROM collection_shares ORDER BY principal_id`).all()
  return JSON.stringify({ counts, rows: rows.results, staged: staged.results, shares: shares.results })
}

async function call(f: Fixture, route: Route, caller: Caller) {
  const response = await f.h.call(caller.person, route.method, route.path(f), route.body?.(f))
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
}

describe('ACC-06 every route of a collection, every way in', () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.name}`, async () => {
      // Refusals share one collection (they change nothing); the switch is turned off last.
      const refused = [OWNER_MCP, API_CLIENT, VIEWER, NO_ROLE, ONE_BELOW, OTHER_ORG, SWITCH_OFF].filter((caller) => expected(route, caller).status !== route.status)
      const shared = await fixture(route.min, route.setup)
      for (const caller of refused) {
        if (caller.switchOff) expect((await shared.h.call(PEOPLE.maya, 'PATCH', `/api/collections/${route.target?.(shared) ?? shared.id}`, { assistants: false })).status).toBe(200)
        const before = await fingerprint(shared.h)
        const answer = await call(shared, route, caller)
        expect({ caller: caller.name, status: answer.status, error: answer.body.error }).toEqual({ caller: caller.name, ...expected(route, caller) })
        shared.h.engine.control.runUntilIdle()
        expect({ caller: caller.name, unchanged: await fingerprint(shared.h) }).toEqual({ caller: caller.name, unchanged: before })
      }
      // Every allowed way in, each on its own collection: the exact status, and what the call did.
      for (const caller of [OWNER, OWNER_MCP, API_CLIENT, VIEWER].filter((candidate) => expected(route, candidate).status === route.status)) {
        const f = await fixture(route.min, route.setup)
        const answer = await call(f, route, caller)
        expect({ caller: caller.name, status: answer.status, error: answer.body.error }).toEqual({ caller: caller.name, status: route.status, error: undefined })
        await route.effect(f, answer.body)
      }
    }, 30_000)
  }
})

describe('ACC-06 the organization\'s routes, every way in', () => {
  async function base() {
    const h = await createHarness()
    open.push(h)
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.', 'Approvals')
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'VIEWER')
    await h.share(PEOPLE.maya, id, CLIENT, 'VIEWER')
    return { h, id }
  }
  const status = async (h: Harness, person: Person, method: string, path: string, body?: unknown) => {
    const response = await h.json<Record<string, unknown>>(person, method, path, body)
    return { status: response.status, error: response.body.error, body: response.body }
  }

  it('lists, starts and finds collections as each caller may', async () => {
    const { h, id } = await base()
    const listed = async (person: Person) => ((await h.json<{ collections: { id: string }[] }>(person, 'GET', '/api/collections')).body.collections ?? []).map((collection) => collection.id)
    expect(await listed(PEOPLE.maya)).toEqual([id])
    expect(await listed(mcp(PEOPLE.maya))).toEqual([id])
    expect(await listed(CLIENT)).toEqual([id])
    expect(await listed(PEOPLE.ada)).toEqual([])
    expect(await listed(PEOPLE.outsider)).toEqual([])
    expect((await status(h, PEOPLE.maya, 'POST', '/api/collections', { name: 'On the site' })).status).toBe(201)
    expect((await status(h, mcp(PEOPLE.maya), 'POST', '/api/collections', { name: 'From an assistant' })).status).toBe(201)
    expect(await status(h, CLIENT, 'POST', '/api/collections', { name: 'By a client' })).toMatchObject({ status: 403, error: 'forbidden' })
    expect(await status(h, PEOPLE.leo, 'POST', '/api/collections', { name: 'By a Viewer' })).toMatchObject({ status: 403, error: 'forbidden' })
    expect(await count(h, `SELECT COUNT(*) AS n FROM collections WHERE org_id = ?`, ORG)).toBe(3)
    expect(((await status(h, PEOPLE.dana, 'GET', '/api/collections/others')).body.collections as { id: string }[]).map((collection) => collection.id)).toContain(id)
    expect(await status(h, PEOPLE.maya, 'GET', '/api/collections/others')).toMatchObject({ status: 403, error: 'forbidden' })
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    expect(await listed(mcp(PEOPLE.maya))).not.toContain(id)
  })

  it('searches and asks as each caller may', async () => {
    const { h, id } = await base()
    const search = { collections: [id], query: 'Who signs off deals above $25,000?' }
    const found = await status(h, PEOPLE.eli, 'POST', '/api/search', search)
    expect(found.status).toBe(200)
    expect((found.body.passages as unknown[]).length).toBeGreaterThan(0)
    expect((await status(h, CLIENT, 'POST', '/api/search', search)).status).toBe(200)
    expect(await status(h, PEOPLE.ada, 'POST', '/api/search', search)).toMatchObject({ status: 403, error: 'forbidden' })
    expect(await status(h, PEOPLE.outsider, 'POST', '/api/search', search)).toMatchObject({ status: 404, error: 'not_found' })
    const asked = await status(h, PEOPLE.eli, 'POST', '/api/ask', { collections: [id], question: search.query })
    expect(asked.body.outcome).toBe('answered')
    expect(await status(h, mcp(PEOPLE.maya), 'POST', '/api/ask', { collections: [id], question: search.query })).toMatchObject({ status: 403, error: 'browser_only' })
    expect((await status(h, PEOPLE.eli, 'POST', `/api/answers/${asked.body.answerId}/right`)).status).toBe(200)
    expect(await status(h, PEOPLE.maya, 'POST', `/api/answers/${asked.body.answerId}/right`)).toMatchObject({ status: 404, error: 'not_found' })
    // "Yes" is checked against the answer's collections now: the switch for assistants, and a share taken back.
    const again = await status(h, PEOPLE.eli, 'POST', '/api/ask', { collections: [id], question: 'Who signs off big deals?' })
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    expect(await status(h, mcp(PEOPLE.eli), 'POST', `/api/answers/${again.body.answerId}/right`)).toMatchObject({ status: 403, error: 'assistants_off' })
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: true })
    expect(await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${id}/sharing/person/${PEOPLE.eli.id}`)).toMatchObject({ status: 200 })
    expect(await status(h, PEOPLE.eli, 'POST', `/api/answers/${again.body.answerId}/right`)).toMatchObject({ status: 403, error: 'forbidden' })
    expect(await count(h, `SELECT COUNT(*) AS n FROM questions WHERE answer_id = ? AND marked_right_at IS NOT NULL`, again.body.answerId)).toBe(0)
    await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { assistants: false })
    expect(await status(h, mcp(PEOPLE.maya), 'POST', '/api/search', search)).toMatchObject({ status: 403, error: 'assistants_off' })
  })

  it('Needs attention, people and the organization\'s rules, usage and health, as each caller may', async () => {
    const { h, id } = await base()
    expect((await status(h, PEOPLE.maya, 'GET', '/api/attention')).body.collections).toMatchObject([{ id }])
    expect((await status(h, mcp(PEOPLE.maya), 'GET', '/api/attention')).status).toBe(200)
    expect(await status(h, PEOPLE.leo, 'GET', '/api/attention')).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.maya, 'GET', '/api/members?q=eli')).body.members).toMatchObject([{ id: PEOPLE.eli.id }])
    expect(await status(h, mcp(PEOPLE.maya), 'GET', '/api/members?q=eli')).toMatchObject({ status: 403, error: 'browser_only' })
    expect(await status(h, PEOPLE.leo, 'GET', '/api/members?q=eli')).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.ada, 'GET', '/api/rules')).body.timeZone).toBe('UTC')
    expect(await status(h, PEOPLE.maya, 'GET', '/api/rules')).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.ada, 'PUT', '/api/rules', { timeZone: 'Europe/Berlin' })).body.timeZone).toBe('Europe/Berlin')
    expect(await status(h, mcp(PEOPLE.dana), 'PUT', '/api/rules', { timeZone: 'UTC' })).toMatchObject({ status: 403, error: 'browser_only' })
    expect(await status(h, PEOPLE.maya, 'PUT', '/api/rules', { timeZone: 'UTC' })).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.ada, 'POST', '/api/rules/hiding-preview', { text: 'Write to dana@example.test' })).body.text).toBe('Write to [hidden]')
    expect(await status(h, PEOPLE.maya, 'POST', '/api/rules/hiding-preview', { text: 'x' })).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.ada, 'POST', '/api/rules/ask-for-more', { note: 'More please.' })).status).toBe(202)
    expect(await status(h, PEOPLE.maya, 'POST', '/api/rules/ask-for-more', { note: 'More please.' })).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.ada, 'GET', '/api/usage')).body.limits).toBeTruthy()
    expect(await status(h, PEOPLE.maya, 'GET', '/api/usage')).toMatchObject({ status: 403, error: 'forbidden' })
    expect((await status(h, PEOPLE.ada, 'GET', '/api/health')).body.organization).toMatchObject({ collections: 1 })
    expect(await status(h, PEOPLE.maya, 'GET', '/api/health')).toMatchObject({ status: 403, error: 'forbidden' })
    for (const person of [PEOPLE.leo, CLIENT, PEOPLE.outsider]) {
      expect((await status(h, person, 'GET', '/api/me')).status).toBe(200)
      expect((await status(h, person, 'GET', '/api/catalog')).status).toBe(200)
    }
  })
})
