import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORG_HEADER, type OutboxEvent } from '../../engine/src/contract.ts'
import { retryParked } from '../../src/app/server/outbox.ts'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// Round 9 of the review: "Waiting to be learned" lists only what the engine hasn't started, and Cancel asks the engine
// for anything sent that isn't finished (F168); a cancel that loses to the tick's claim goes through the engine (F172);
// parked events take turns (F175) and are tried again on the tick only (F176).

let h: Harness
beforeEach(async () => { h = await createHarness({ timing: { importMs: 60_000 } }) })
afterEach(() => h.close())

const stateOf = async (importId: string) => (await h.db.prepare(`SELECT state FROM imports WHERE id = ?`).bind(importId).first<{ state: string }>())?.state
const held = async (importId: string) => Number(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE ref = ? AND state = 'held'`).bind(`import:${importId}`).first('n'))
const queued = async (id: string) => (await h.json<{ imports: { importId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports?state=queued`)).body.imports.map((entry) => entry.importId)
const addNote = async (id: string, title: string) =>
  (await h.json<{ import: { importId: string; state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title, text: `${title} partners renew every March.` })).body.import
const cancel = (id: string, importId: string) => h.json<{ import?: { state: string }; message?: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${importId}`)
const holdOrganization = (until: string | null, version: number) =>
  h.engine.fetch(new Request(`https://engine.test/v1/orgs/${ORG}/hold`, { method: 'POST', headers: { [ORG_HEADER]: ORG, 'content-type': 'application/json' }, body: JSON.stringify({ until, version }) }))

/**
 * The engine answers a new import as the real one does: 202 `queued`, its alarm starting it after the answer; and what
 * it says when it starts hasn't come through its outbox yet.
 */
function answerQueued() {
  const real = h.env.ENGINE!
  h.env.ENGINE = {
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === '/v1/outbox') return Response.json({ events: [], cursor: '', more: false })
      const response = await real.fetch(request)
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports') && response.status === 202) {
        return Response.json({ ...((await response.json()) as object), state: 'queued', queuePosition: null }, { status: 202 })
      }
      return response
    },
  }
}

describe('F168 waiting to be learned, as the engine sees it', () => {
  it('leaves out the import the engine is learning, though Knowledge last heard it was queued, and refuses its cancel', async () => {
    const id = await h.collection(PEOPLE.maya)
    answerQueued()
    const added = await addNote(id, 'Gold')
    expect(added.state).toBe('queued')
    expect(await stateOf(added.importId)).toBe('queued')
    expect(await queued(id)).toEqual([])
    // What the engine said is recorded, and a cancel is refused: it is being learned.
    expect(await stateOf(added.importId)).toBe('learning')
    const refused = await cancel(id, added.importId)
    expect(refused.status).toBe(409)
    expect(refused.body.message).toMatch(/already being learned/)
  })

  it('follows the engine: an import that starts after Knowledge listed it leaves the list once the engine says so', async () => {
    const id = await h.collection(PEOPLE.maya)
    await addNote(id, 'Gold')
    const second = await addNote(id, 'Silver')
    expect(await stateOf(second.importId)).toBe('queued')
    // The first is learned and the second starts in the engine, which tells Knowledge through its outbox.
    h.clock.advance(61_000)
    h.engine.control.advance(0)
    await h.tick()
    expect(await stateOf(second.importId)).toBe('learning')
    expect(await queued(id)).toEqual([])
  })

  it('an interrupted import is tried again in place: it is not listed and can\'t be cancelled', async () => {
    const id = await h.collection(PEOPLE.maya)
    h.engine.control.failNextImport({ collectionId: id, times: 1 })
    const added = await addNote(id, 'Gold')
    h.clock.advance(61_000)
    h.engine.control.advance(0)
    await h.tick()
    expect(await stateOf(added.importId)).toBe('interrupted')
    expect(await queued(id)).toEqual([])
    const refused = await cancel(id, added.importId)
    expect(refused.status).toBe(409)
    expect(refused.body.message).toMatch(/already being learned/)
    expect(await held(added.importId)).toBeGreaterThan(0)
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await stateOf(added.importId)).toBe('committed')
  })

  it('an import the engine put back in its queue is listed again, and cancelled through the engine though Knowledge last heard it started', async () => {
    const id = await h.collection(PEOPLE.maya)
    const added = await addNote(id, 'Gold')
    expect(await stateOf(added.importId)).toBe('learning')
    // The awake-hours stop lands in the engine: the import keeps nothing and waits its turn again.
    await holdOrganization('2026-12-01T00:00:00Z', 1)
    h.engine.control.advance(0)
    await h.tick()
    expect(await stateOf(added.importId)).toBe('queued')
    expect(await queued(id)).toEqual([added.importId])
    // Knowledge may not have heard yet: the engine is asked whatever D1 last saw, short of finished.
    await h.db.prepare(`UPDATE imports SET state = 'learning' WHERE id = ?`).bind(added.importId).run()
    const cancelled = await cancel(id, added.importId)
    expect([cancelled.status, cancelled.body.import?.state]).toEqual([200, 'cancelled'])
    expect(await stateOf(added.importId)).toBe('cancelled')
    expect(await held(added.importId)).toBe(0)
  })
})

describe('F172 a cancel that loses to the tick\'s claim', () => {
  it('goes through the engine once, so the send that follows learns nothing', async () => {
    h.close()
    h = await createHarness()
    const id = await h.collection(PEOPLE.maya)
    await h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'learned_month', 0, NULL, 0)`).bind(ORG).run()
    const added = await addNote(id, 'Gold')
    expect(added.state).toBe('waiting')
    // The tick claims it to send it between the cancel's read and its own guarded update.
    const real = h.env.DB
    type Local = D1PreparedStatement & { sql: string }
    h.env.DB = new Proxy(real, {
      get(target, name) {
        if (name === 'batch') {
          return async (statements: Local[]) => {
            if (statements.some((statement) => statement.sql.includes(`SET state = 'cancelled', request = NULL`) && statement.sql.includes('sends = 0'))) {
              await target.prepare(`UPDATE imports SET state = 'queued' WHERE id = ?`).bind(added.importId).run()
            }
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, name)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const cancelled = await cancel(id, added.importId)
    h.env.DB = real
    expect([cancelled.status, cancelled.body.import?.state]).toEqual([200, 'cancelled'])
    expect(await stateOf(added.importId)).toBe('cancelled')
    expect(await held(added.importId)).toBe(0)
    // The tick's send arrives after the cancel: the engine answers it cancelled, and nothing is learned.
    const sent = await h.engine.fetch(new Request(`https://engine.test/v1/collections/${id}/imports`, {
      method: 'POST', headers: { [ORG_HEADER]: ORG, 'content-type': 'application/json' },
      body: JSON.stringify({ importId: added.importId, files: [], notes: [{ noteId: 'n1', title: 'Gold', text: 'Gold partners renew every March.', outdated: [] }], small: true }),
    }))
    expect(((await sent.json()) as { state: string }).state).toBe('cancelled')
    h.engine.control.runUntilIdle()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources).toEqual([])
  })
})

describe('parked events', () => {
  /** Parks, for each collection, a head event and one waiting behind it; `failing` heads keep failing. */
  async function parkFor(collections: string[], failing: Set<string>) {
    const base = h.clock.now - 60 * 60_000
    let seq = 1000
    const heads = new Map<string, string>()
    for (const [index, collectionId] of collections.entries()) {
      for (const role of ['head', 'behind'] as const) {
        seq += 1
        const event = { id: String(seq).padStart(12, '0'), at: new Date(base).toISOString(), org: ORG, collectionId, type: 'usage', kind: 'awake', seconds: 1 } satisfies OutboxEvent
        if (role === 'head') heads.set(collectionId, event.id)
        await h.db.prepare(`INSERT INTO parked_events (id, org_id, collection_id, event, error, attempts, parked_at, tried_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`)
          .bind(event.id, ORG, collectionId, JSON.stringify(event), role === 'head' ? 'D1_ERROR: refused' : null, role === 'head' ? 1 : 0, base + index).run()
      }
    }
    const refused = new Set([...failing].map((collectionId) => heads.get(collectionId)!))
    const real = h.env.DB
    type Local = D1PreparedStatement & { sql: string; params: unknown[] }
    h.env.DB = new Proxy(real, {
      get(target, name) {
        if (name === 'batch') {
          return async (statements: Local[]) => {
            if (statements.some((statement) => statement.sql.startsWith('INSERT INTO engine_events') && refused.has(String(statement.params[0])))) throw new Error('D1_ERROR: refused')
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, name)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const parkedIn = async (collectionId: string) => Number(await h.db.prepare(`SELECT COUNT(*) AS n FROM parked_events WHERE collection_id = ?`).bind(collectionId).first('n'))

  it('F175 every parked collection gets its turn: one that fails again goes to the back, with the events behind it', async () => {
    const collections = Array.from({ length: 30 }, (_, index) => `c${String(index + 1).padStart(2, '0')}`)
    // The 25 parked first keep failing; the last 5 failed once and would apply now.
    await parkFor(collections, new Set(collections.slice(0, 25)))
    await retryParked(h.env, h.clock.now, Date.now() + 10_000)
    expect(await parkedIn('c26')).toBe(2)
    h.clock.advance(5 * 60_000)
    await retryParked(h.env, h.clock.now, Date.now() + 10_000)
    for (const collectionId of collections.slice(25)) expect(await parkedIn(collectionId)).toBe(0)
    for (const collectionId of collections.slice(0, 25)) expect(await parkedIn(collectionId)).toBe(2)
  })

  it('F176 a request\'s pull leaves parked events alone; the tick tries them again', async () => {
    const id = await h.collection(PEOPLE.maya)
    await parkFor([id], new Set([id]))
    const attempts = () => h.db.prepare(`SELECT attempts FROM parked_events WHERE collection_id = ? AND error IS NOT NULL`).bind(id).first('attempts')
    for (let index = 0; index < 3; index += 1) expect((await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}`)).status).toBe(200)
    expect(await attempts()).toBe(1)
    await h.tick()
    expect(await attempts()).toBe(2)
  })
})

describe('F169 a corrected passage that loses a merge without moving', () => {
  it('leaves one check, under the newer correction: the retired correction\'s check goes', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Door codes, as they stand.\n\nCode alpha opens the north door.\n\nCode bravo opens the north door.', 'Doors')
    const passageOf = async (query: string) => (await h.json<{ passages: { documentId: string; textHash: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query })).body.passages[0]!
    const [alpha, bravo] = [await passageOf('code alpha north door'), await passageOf('code bravo north door')]
    const correct = async (text: string, ref: { documentId: string; textHash: string }) => {
      const made = await h.json<{ correction: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text, outdated: [{ documentId: ref.documentId, textHash: ref.textHash }] })
      h.engine.control.runUntilIdle()
      await h.tick()
      return made.body.correction.id.replace(/-/g, '')
    }
    // The older correction is on bravo, the newer on alpha.
    const older = await correct('Code bravo opens the east door.', bravo)
    const newer = await correct('Code alpha opens the south door.', alpha)
    const rules = (words: string[]) => h.json(PEOPLE.dana, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words } })
    const checks = async () => (await h.db.prepare(`SELECT note_id FROM correction_checks WHERE collection_id = ? ORDER BY note_id`).bind(id).all<{ note_id: string }>()).results.map((row) => row.note_id)
    // Hiding "bravo" changes bravo's passage only: its (older) correction asks to be checked.
    await rules(['bravo'])
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await checks()).toEqual([older])
    // Hiding "alpha" too makes alpha's passage read as bravo's: the newer correction keeps it, and one check is left.
    await rules(['bravo', 'alpha'])
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await checks()).toEqual([newer])
  })
})
