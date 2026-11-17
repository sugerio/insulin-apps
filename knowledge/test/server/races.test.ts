import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORG_HEADER, type CollectionStatus } from '../../engine/src/contract.ts'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// Requests and ticks that overlap: a cancel and the tick's send, a hold renewed while the old one is lifted, an export
// replaced between being read and being learned, and a correction's import asked about after newer checks arrived.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const setLimit = (key: string, value: number | null) =>
  h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, ?, ?, NULL, 0) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).bind(ORG, key, value).run()
const clearLimits = () => h.db.prepare(`DELETE FROM org_limits WHERE org_id = ?`).bind(ORG).run()
const held = async (importId: string) => Number(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE ref = ? AND state = 'held'`).bind(`import:${importId}`).first('n'))
const stateOf = async (importId: string) => (await h.db.prepare(`SELECT state FROM imports WHERE id = ?`).bind(importId).first<{ state: string }>())?.state
const engineStatus = async (id: string) => (await (await h.engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { headers: { [ORG_HEADER]: ORG } }))).json()) as CollectionStatus
const later = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Statements whose SQL holds `fragment` wait at the gate until it opens (the first time only). */
function gateDb(fragment: string) {
  const db = h.db as unknown as D1Database
  let open!: () => void
  let arrive!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  const reached = new Promise<void>((resolve) => { arrive = resolve })
  let armed = true
  const targets = new WeakMap<object, D1PreparedStatement>()
  const sqlOf = (statement: D1PreparedStatement) => (statement as unknown as { sql: string }).sql
  const wait = async (sql: string) => {
    if (armed && sql.includes(fragment)) {
      armed = false
      arrive()
      await gate
    }
  }
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, name, receiver) {
        if (name === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
        if (name === 'run' || name === 'all' || name === 'first' || name === 'raw') {
          return async (...args: unknown[]) => {
            await wait(sqlOf(target))
            return (target as never as Record<string, (...a: unknown[]) => unknown>)[name]!.apply(target, args)
          }
        }
        return Reflect.get(target, name, receiver)
      },
    })
    targets.set(proxy, statement)
    return proxy
  }
  h.env.DB = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const real = statements.map((statement) => targets.get(statement) ?? statement)
      for (const statement of real) await wait(sqlOf(statement))
      return db.batch(real)
    },
    exec: (sql: string) => db.exec(sql),
  } as unknown as D1Database
  return { reached, release: () => open() }
}

/** The engine's answer to the next import start is lost: `took` says whether the engine got it. */
function loseNextStart(took: boolean) {
  const real = h.env.ENGINE!
  let armed = true
  h.env.ENGINE = {
    fetch: async (request: Request) => {
      if (armed && request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports')) {
        armed = false
        if (took) await real.fetch(request)
        return Response.json({ error: 'internal', message: 'The answer was lost.' }, { status: 502 })
      }
      return real.fetch(request)
    },
  }
}

async function waitingNote() {
  const id = await h.collection(PEOPLE.maya)
  await setLimit('learned_month', 0)
  const added = await h.json<{ import: { importId: string; state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Rule', text: 'Partner discounts stop at 20 percent.' })
  expect(added.body.import.state).toBe('waiting')
  await clearLimits()
  return { id, importId: added.body.import.importId }
}

describe('cancelling a waiting import while the tick sends it', () => {
  it('a cancel that read it unsent is refused once the tick has sent it meanwhile', async () => {
    const { id, importId } = await waitingNote()
    const gate = gateDb(`SET state = 'cancelled'`)
    const cancelling = h.json<{ error: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${importId}`)
    await gate.reached
    // Meanwhile the tick sends it; the engine takes it, and its answer is lost.
    h.engine.control.hold(true)
    loseNextStart(true)
    await h.tick()
    expect(await stateOf(importId)).toBe('waiting')
    gate.release()
    const cancel = await cancelling
    expect(cancel.status).toBe(409)
    expect(await held(importId)).toBeGreaterThan(0)
    h.engine.control.hold(false)
    h.engine.control.runUntilIdle()
    await h.tick()
    await h.tick()
    expect(await stateOf(importId)).toBe('committed')
  })

  it('a 404 from the engine proves nothing about a send made after it was asked', async () => {
    const { id, importId } = await waitingNote()
    loseNextStart(false)
    await h.tick()
    const gate = gateDb(`SET state = 'cancelled'`)
    const cancelling = h.json<{ error: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${importId}`)
    await gate.reached
    // The engine said it never had it; then the tick sends it again, and this time the engine takes it.
    h.engine.control.hold(true)
    loseNextStart(true)
    await h.tick()
    gate.release()
    expect((await cancelling).status).toBe(409)
    expect(await held(importId)).toBeGreaterThan(0)
    h.engine.control.hold(false)
    h.engine.control.runUntilIdle()
    await h.tick()
    await h.tick()
    expect(await stateOf(importId)).toBe('committed')
  })
})

describe('the awake-hours hold', () => {
  it('a hold renewed while the expired one is lifted ends with the engine and Knowledge agreeing', async () => {
    const id = await h.collection(PEOPLE.maya)
    await setLimit('awake_hours_month', 0)
    const ask = () => h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off?' })
    expect((await ask()).status).toBe(429)
    expect((await engineStatus(id)).state).toBe('held')
    // December 1: the renewed hold (until January 1) reaches the engine, and its answer is slow.
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    const real = h.env.ENGINE!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let seen = false
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        if (!seen && request.method === 'POST' && new URL(request.url).pathname.endsWith('/hold')) {
          const body = (await request.clone().json()) as { until: string | null }
          if (body.until?.startsWith('2027-01-01')) {
            seen = true
            const response = await real.fetch(request)
            await gate
            return response
          }
        }
        return real.fetch(request)
      },
    }
    const asking = ask()
    for (let wait = 0; wait < 100 && !seen; wait += 1) await later()
    expect(seen).toBe(true)
    // Meanwhile the tick lets go of the hold that ended on the 1st.
    await h.tick()
    release()
    expect((await asking).status).toBe(429)
    await h.tick()
    const kept = await h.db.prepare(`SELECT until FROM org_holds WHERE org_id = ?`).bind(ORG).first<{ until: number | null }>()
    expect((await engineStatus(id)).state).toBe('held')
    expect(kept?.until).toBe(Date.UTC(2027, 0, 1))
  })
})

describe('an export replaced after it was read', () => {
  it('is refused: the engine learns only the file Knowledge read and reserved for', async () => {
    const source = await h.collection(PEOPLE.maya, 'Source')
    await h.note(PEOPLE.maya, source, 'Gold partners renew every March.', 'Gold')
    const zipOf = async () => {
      const made = await h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${source}/exports`)
      return new Uint8Array(await (await h.call(PEOPLE.maya, 'GET', `/api/collections/${source}/exports/${made.body.export.exportId}?download=1`)).arrayBuffer())
    }
    const small = await zipOf()
    h.clock.advance(10 * 60_000)
    await h.note(PEOPLE.maya, source, 'Silver partners renew every June.', 'Silver')
    await h.note(PEOPLE.maya, source, 'Bronze partners renew every May.', 'Bronze')
    const big = await zipOf()
    const target = await h.collection(PEOPLE.maya, 'Target')
    const pre = await h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${target}/preflight`, { files: [{ name: 'small.zip', bytes: small.byteLength }], export: true })
    const fileId = pre.body.files[0]!.fileId
    expect((await h.json<{ accepted: boolean }>(PEOPLE.maya, 'PUT', `/api/collections/${target}/uploads/${fileId}`, small)).body.accepted).toBe(true)
    // Another upload of the same file id reaches the engine; Knowledge's record of it hasn't changed yet.
    await h.engine.fetch(new Request(`https://engine.test/v1/collections/${target}/inbox/${fileId}`, { method: 'PUT', body: big, headers: { [ORG_HEADER]: ORG, 'content-type': 'application/zip' } }))
    const started = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'POST', `/api/collections/${target}/import-export`, { fileId })
    expect(started.status).toBe(400)
    expect(started.body.message).toMatch(/isn't the one that was checked/)
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${target}/sources`)).body.sources).toEqual([])
  })
})

describe('a correction\'s import asked about later', () => {
  it('doesn\'t clear checks that arrived after the correction was learned', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'The Cobalt gateway listens on port 8001.', 'Ports')
    const found = await h.json<{ passages: { documentId: string; textHash: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'Cobalt gateway port' })
    const passage = found.body.passages[0]!
    const fix = await h.json<{ import: { importId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'The gateway listens on port 9001.', outdated: [{ documentId: passage.documentId, textHash: passage.textHash }] })
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await stateOf(fix.body.import.importId)).toBe('committed')
    // A stricter rule reads the file again; the passage the correction marked reads differently now.
    await h.json(PEOPLE.dana, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Cobalt'] } })
    h.engine.control.runUntilIdle()
    await h.tick()
    const checks = () => h.db.prepare(`SELECT COUNT(*) AS n FROM correction_checks WHERE collection_id = ?`).bind(id).first('n')
    expect(await checks()).toBe(1)
    expect((await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${fix.body.import.importId}`)).status).toBe(200)
    expect(await checks()).toBe(1)
  })
})
