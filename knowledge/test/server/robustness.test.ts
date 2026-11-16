import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkCitations } from '../../src/app/server/ask.ts'
import { applyEngineEvent } from '../../src/app/server/outbox.ts'
import { watchLimits } from '../../src/app/server/tick.ts'
import { createHarness, GATEWAY, ORG, OTHER_ORG, PEOPLE, type Harness, type Person } from '../support/harness.ts'

// What happens when things go wrong or race: engine failures that leave no answer, concurrent changes, a tick cut
// short, the platform answering late, and the limits that every way in must meet.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const encoder = new TextEncoder()
const HOUR = 3600

/** Preflight and upload files as the site does; the accepted file ids. */
async function upload(person: Person, id: string, files: { name: string; text: string }[]): Promise<string[]> {
  const preflight = await h.json<{ files: { name: string; accepted: boolean; fileId?: string }[] }>(person, 'POST', `/api/collections/${id}/preflight`, {
    files: files.map((file) => ({ name: file.name, bytes: encoder.encode(file.text).byteLength })),
  })
  const ids: string[] = []
  for (const file of preflight.body.files) {
    if (!file.accepted) continue
    const bytes = encoder.encode(files.find((candidate) => candidate.name === file.name)!.text)
    const uploaded = await h.json<{ accepted: boolean }>(person, 'PUT', `/api/collections/${id}/uploads/${file.fileId}`, bytes, { 'content-type': 'application/octet-stream' })
    if (uploaded.body.accepted) ids.push(file.fileId!)
  }
  return ids
}

async function override(limits: Record<string, number | null>) {
  h.gateway.limits.status = 200
  h.gateway.limits.pages.push({ defaults: {}, organizations: [{ id: ORG, limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, { value, until: null }])) }] })
  await h.tick()
}

/** The D1 binding, with `check(sql, bound)` run before each statement executes (it throws to make it fail). */
function wrapDb(check: (sql: string, bound: number) => void) {
  const db = h.db as unknown as D1Database
  const targets = new WeakMap<object, D1PreparedStatement>()
  const shape = (statement: D1PreparedStatement) => statement as unknown as { sql: string; params?: unknown[] }
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, name, receiver) {
        if (name === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
        if (name === 'run' || name === 'all' || name === 'first' || name === 'raw') {
          return (...args: unknown[]) => {
            check(shape(target).sql, shape(target).params?.length ?? 0)
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
    batch: (statements: D1PreparedStatement[]) => {
      const real = statements.map((statement) => targets.get(statement) ?? statement)
      for (const statement of real) check(shape(statement).sql, shape(statement).params?.length ?? 0)
      return db.batch(real)
    },
    exec: (sql: string) => db.exec(sql),
  } as unknown as D1Database
}

/** Statements whose SQL holds `fragment` fail the first time they run, as when D1 is briefly unavailable. */
function failOnce(fragment: string) {
  let armed = true
  wrapDb((sql) => {
    if (armed && sql.includes(fragment)) {
      armed = false
      throw new Error('D1_ERROR: the database is unavailable')
    }
  })
}

describe('imports and engine failures', () => {
  it('an import the engine took but answered with an error is kept: a retry with the same key learns it once', async () => {
    const id = await h.collection(PEOPLE.maya)
    const engine = h.env.ENGINE!
    let fail = true
    h.env.ENGINE = {
      fetch: async (request) => {
        const answer = await engine.fetch(request)
        if (fail && request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports')) {
          fail = false
          return Response.json({ error: 'internal', message: 'The connection dropped.' }, { status: 503 })
        }
        return answer
      },
    }
    const key = { 'idempotency-key': 'note-once-0001' }
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'Partner discounts stop at 20 percent.' }, key)).status).toBe(503)
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'Partner discounts stop at 20 percent.' }, key)).status).toBe(202)
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources).toHaveLength(1)
    expect(await h.db.prepare(`SELECT COALESCE(SUM(used), 0) AS n FROM usage_counters WHERE key = 'learned_month'`).first('n')).toBe(1)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE state = 'held' AND key != 'awake_hours_month'`).first('n')).toBe(0)
  })

  it('an import with a file already here counts only the files learned this month', async () => {
    const id = await h.collection(PEOPLE.maya)
    const first = await upload(PEOPLE.maya, id, [{ name: 'A.md', text: 'Alpha rule.' }])
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: first })
    await h.tick()
    const second = await upload(PEOPLE.maya, id, [{ name: 'A copy.md', text: 'Alpha rule.' }, { name: 'B.md', text: 'Beta rule.' }])
    // Learned later, so what it learned arrives through the outbox.
    h.engine.control.hold(true)
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: second })
    h.engine.control.hold(false)
    await h.tick()
    expect(await h.db.prepare(`SELECT SUM(used) AS n FROM usage_counters WHERE key = 'learned_month'`).first('n')).toBe(2)
  })

  it('an import event whose effects fail to save is applied again, not lost', async () => {
    const id = await h.collection(PEOPLE.maya)
    h.engine.control.failNextImport({ collectionId: id, times: 3 })
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'A note that fails.' })).status).toBe(202)
    // The request saw the import as queued: its final state comes through the outbox.
    await h.db.prepare(`UPDATE imports SET state = 'learning' WHERE org_id = ?`).bind(ORG).run()
    await h.db.prepare(`UPDATE reservations SET state = 'held' WHERE org_id = ? AND key != 'awake_hours_month'`).bind(ORG).run()
    const outbox = await h.engine.fetch(new Request('https://engine.test/v1/outbox?limit=500'))
    const failed = ((await outbox.json()) as { events: { id: string; type: string; import?: { state: string } }[] }).events.find((event) => event.type === 'import' && event.import?.state === 'failed')!
    await h.db.prepare(`DELETE FROM engine_events WHERE id = ?`).bind(failed.id).run()
    const real = h.env.DB
    failOnce('UPDATE imports SET state')
    await expect(applyEngineEvent(h.env, failed as never, h.clock.now)).rejects.toThrow()
    h.env.DB = real
    expect(await applyEngineEvent(h.env, failed as never, h.clock.now)).toBe(true)
    expect(await h.db.prepare(`SELECT state FROM imports WHERE org_id = ?`).bind(ORG).first('state')).toBe('failed')
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE state = 'held' AND key != 'awake_hours_month'`).first('n')).toBe(0)
  })

  it('stored text is reserved above the file\'s size, since hiding can make it longer', async () => {
    const id = await h.collection(PEOPLE.maya)
    await override({ storage_bytes: 7 })
    const early = await h.json<{ error: string; limit: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'Short.txt', bytes: 6 }] })
    expect(early.status).toBe(429)
    expect(early.body.limit).toBe('storage_bytes')
    await override({ storage_bytes: null })
    const ids = await upload(PEOPLE.maya, id, [{ name: 'Short.txt', text: 'abc@de' }])
    await override({ storage_bytes: 7 })
    const refused = await h.json<{ error: string; limit: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: ids })
    expect(refused.status).toBe(429)
    expect(refused.body.limit).toBe('storage_bytes')
  })

  it('an import of 98 files stays within D1\'s bound parameters', async () => {
    const id = await h.collection(PEOPLE.maya)
    const ids = await upload(PEOPLE.maya, id, Array.from({ length: 98 }, (_, index) => ({ name: `File ${index}.txt`, text: `Rule number ${index}.` })))
    expect(ids).toHaveLength(98)
    // D1 refuses a statement with more than 100 bound parameters; the local stand-in doesn't, so this one does.
    wrapDb((sql, values) => {
      if (values > 100) throw new Error(`D1_ERROR: too many SQL variables (${values}) in ${sql.slice(0, 40)}`)
    })
    const started = await h.json<{ import: { files: unknown[] } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: ids })
    expect(started.status).toBe(202)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM staged_files WHERE state = 'used'`).first('n')).toBe(98)
  })

  it('notes longer than the engine takes are refused by the app, in plain words', async () => {
    const id = await h.collection(PEOPLE.maya)
    const refused = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'x'.repeat(20_001) })
    expect(refused.status).toBe(400)
    expect(refused.body.message).toMatch(/20,?000/)
  })
})

describe('ownership, sharing and members', () => {
  it('a transfer whose owner changed meanwhile is refused and changes nothing', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    const real = h.env.GATEWAY_FETCH!
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/members/status')) await h.db.prepare(`UPDATE collections SET owner_id = ? WHERE id = ?`).bind(PEOPLE.dana.id, id).run()
      return real(input, init)
    }) as typeof fetch
    const mail = h.gateway.mail.length
    const refused = await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id })
    expect(refused.status).toBe(409)
    expect(await h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(id).first('owner_id')).toBe(PEOPLE.dana.id)
    expect((await h.db.prepare(`SELECT principal_id, role FROM collection_shares WHERE collection_id = ? ORDER BY principal_id`).bind(id).all()).results).toEqual([{ principal_id: PEOPLE.eli.id, role: 'EDITOR' }])
    expect(h.gateway.mail.slice(mail)).toEqual([])
  })

  it('a transfer sent again with the same key answers what it answered the first time', async () => {
    const id = await h.collection(PEOPLE.maya)
    const key = { 'idempotency-key': 'transfer-once-0001' }
    const first = await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id }, key)
    const again = await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id }, key)
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(again.headers.get('idempotent-replay')).toBe('true')
  })

  it('the first tick checks the people Knowledge already holds: an owner who left before it loses the collection', async () => {
    const id = await h.collection(PEOPLE.maya)
    h.gateway.setMember(ORG, PEOPLE.maya.id, { member: false })
    await h.tick()
    expect(await h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(id).first('owner_id')).toBe(PEOPLE.dana.id)
  })

  it('people not yet checked by a resync are away: no collection opens for them until they are', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.tick()
    h.gateway.eventsExpired = true
    const real = h.env.GATEWAY_FETCH!
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/members/status') ? Response.json({ error: 'unavailable' }, { status: 503 }) : real(input, init))) as typeof fetch
    await h.tick()
    expect((await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}`)).status).toBe(403)
    expect((await h.json<{ collections: unknown[] }>(PEOPLE.maya, 'GET', '/api/collections')).body.collections).toEqual([])
    expect((await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'anything' })).status).toBe(403)
    h.env.GATEWAY_FETCH = real
    await h.tick()
    expect((await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}`)).status).toBe(200)
  })

  it('an owner who left is moved once member status answers again, even if it failed the first time', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.tick()
    await h.db.prepare(`UPDATE members SET owner_since = NULL`).run()
    const real = h.env.GATEWAY_FETCH!
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/members/status') ? Response.json({ error: 'rate_limited' }, { status: 429 }) : real(input, init))) as typeof fetch
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.maya.id })
    await h.tick()
    h.env.GATEWAY_FETCH = real
    await h.tick()
    expect(await h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(id).first('owner_id')).toBe(PEOPLE.dana.id)
  })

  it('a custom role without permission to change content counts as a Viewer: ownership moves, and sharing says so', async () => {
    const id = await h.collection(PEOPLE.maya)
    const elis = await h.collection(PEOPLE.eli, 'Eli\'s')
    await h.share(PEOPLE.eli, elis, PEOPLE.ada, 'EDITOR')
    await h.tick()
    h.gateway.addEvent({ type: 'role_changed', org: ORG, user: PEOPLE.maya.id, orgRole: 'APPS', appRole: 'EDITOR', permissions: ['knowledge.use', 'knowledge.collections.create'] })
    h.gateway.addEvent({ type: 'role_changed', org: ORG, user: PEOPLE.ada.id, orgRole: 'APPS', appRole: 'EDITOR', permissions: ['knowledge.use'] })
    await h.tick()
    expect(await h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(id).first('owner_id')).toBe(PEOPLE.dana.id)
    const sharing = await h.json<{ shares: { id: string; actsAsViewer: boolean }[] }>(PEOPLE.eli, 'GET', `/api/collections/${elis}/sharing`)
    expect(sharing.body.shares.find((share) => share.id === PEOPLE.ada.id)?.actsAsViewer).toBe(true)
  })
})

describe('limits every way in', () => {
  it('at 100 awake hours, imports, exports and going back are refused before the engine works', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'The first rule.')
    h.clock.advance(6 * 60_000)
    await h.note(PEOPLE.maya, id, 'The second rule.')
    h.engine.control.addUsage(ORG, id, 'awake', 100 * HOUR)
    await h.tick()
    for (const [method, path, body] of [
      ['POST', `/api/collections/${id}/notes`, { text: 'A third rule.' }],
      ['POST', `/api/collections/${id}/exports`, undefined],
      ['POST', `/api/collections/${id}/history/1/go-back`, undefined],
      ['POST', `/api/collections/${id}/corrections`, { text: 'The first rule changed.' }],
    ] as const) {
      const refused = await h.json<{ error: string; limit: string }>(PEOPLE.maya, method, path, body)
      expect({ path, status: refused.status, limit: refused.body.limit }).toEqual({ path, status: 429, limit: 'awake_hours_month' })
    }
  })

  it('a settings PATCH refused at a limit changes nothing', async () => {
    const a = await h.collection(PEOPLE.maya, 'A')
    const b = await h.collection(PEOPLE.maya, 'B')
    const window = { days: [1, 2, 3], start: '09:00', hours: 2 }
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${a}`, { keepReady: window })).status).toBe(200)
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${b}`, { name: 'Renamed B', keepReady: window })).status).toBe(429)
    expect(await h.db.prepare(`SELECT name FROM collections WHERE id = ?`).bind(b).first('name')).toBe('B')
  })

  it('settings the engine missed are sent again by the tick', async () => {
    const id = await h.collection(PEOPLE.maya)
    const engine = h.env.ENGINE!
    let fail = true
    h.env.ENGINE = {
      fetch: async (request) => {
        if (fail && request.method === 'PUT' && /\/v1\/collections\/[^/]+$/.test(new URL(request.url).pathname)) {
          fail = false
          return Response.json({ error: 'internal', message: 'down' }, { status: 503 })
        }
        return engine.fetch(request)
      },
    }
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { keepReady: { days: [1], start: '09:00', hours: 1 } })).status).toBe(200)
    await h.tick()
    const status = await (await engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { headers: { 'x-knowledge-org': ORG } }))).json() as { settings: { keepReady: unknown } }
    expect(status.settings.keepReady).toMatchObject({ days: [1], start: '09:00', hours: 1 })
  })

  it('the organization\'s days of daily backups reach the engine, and follow a change', async () => {
    const id = await h.collection(PEOPLE.maya)
    const settings = async () => ((await (await h.engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { headers: { 'x-knowledge-org': ORG } }))).json()) as { settings: { backupDays: number } }).settings
    expect((await settings()).backupDays).toBe(30)
    await override({ backup_days: 7 })
    await h.tick()
    expect((await settings()).backupDays).toBe(7)
  })

  it('80% of a standing limit mails the admins again after use dropped below and rose again', async () => {
    await override({ collections: 5 })
    const ids = []
    for (let index = 0; index < 4; index += 1) ids.push(await h.collection(PEOPLE.maya, `C${index}`))
    await h.tick()
    const near = () => h.gateway.mail.filter((mail) => /80% of collections/.test(mail.subject) && mail.to === PEOPLE.dana.email).length
    expect(near()).toBe(1)
    await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${ids[0]}`, { confirmName: 'C0' })
    await h.tick()
    await h.collection(PEOPLE.maya, 'C4')
    await h.tick()
    expect(near()).toBe(2)
  })

  it('at the documents-learned limit, new files wait for the 1st and are learned then by themselves', async () => {
    const id = await h.collection(PEOPLE.maya)
    await override({ learned_month: 1 })
    await h.note(PEOPLE.maya, id, 'The first rule.')
    const waiting = await h.json<{ import: { importId: string; state: string }; waiting?: { until: string; message: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'A rule that waits.' })
    expect(waiting.status).toBe(202)
    expect(waiting.body.import.state).toBe('waiting')
    expect(waiting.body.waiting).toMatchObject({ until: '2026-12-01T00:00:00Z' })
    expect(waiting.body.waiting!.message).toMatch(/December 1/)
    const status = await h.json<{ import: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${waiting.body.import.importId}`)
    expect(status.body.import.state).toBe('waiting')
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources).toHaveLength(2)
    expect((await h.json<{ import: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${waiting.body.import.importId}`)).body.import.state).toBe('committed')
  })

  it('files waiting for the 1st are kept by the engine past its day, and learned on the 1st', async () => {
    const id = await h.collection(PEOPLE.maya)
    await override({ learned_month: 1 })
    await h.note(PEOPLE.maya, id, 'The first rule.')
    const ids = await upload(PEOPLE.maya, id, [{ name: 'Gold.md', text: 'Gold partners renew every March.' }])
    const waiting = await h.json<{ import: { importId: string; state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: ids })
    expect(waiting.body.import.state).toBe('waiting')
    h.clock.now = Date.UTC(2026, 10, 25)
    await h.tick()
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ import: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${waiting.body.import.importId}`)).body.import.state).toBe('committed')
    expect((await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources.map((source) => source.name)).toContain('Gold.md')
  })

  it('a waiting file the engine no longer has is named, in plain words, and the others still wait', async () => {
    const id = await h.collection(PEOPLE.maya)
    const old = await upload(PEOPLE.maya, id, [{ name: 'Old.md', text: 'Silver partners renew every June.' }])
    h.clock.advance(25 * 60 * 60 * 1000)
    await override({ learned_month: 1 })
    await h.note(PEOPLE.maya, id, 'The first rule.')
    const fresh = await upload(PEOPLE.maya, id, [{ name: 'Gold.md', text: 'Gold partners renew every March.' }])
    type Files = { name: string; state: string; reason?: string }[]
    const waiting = await h.json<{ import: { importId: string; state: string; files: Files }; waiting: { message: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: [...old, ...fresh] })
    expect(waiting.body.import.state).toBe('waiting')
    expect(waiting.body.waiting.message).toContain('Insulin couldn\'t keep “Old.md” until then: add it again.')
    expect(waiting.body.import.files).toEqual([{ fileId: fresh[0], name: 'Gold.md', state: 'waiting' }, expect.objectContaining({ name: 'Old.md', state: 'failed', reason: expect.stringMatching(/Add it again/) })])
    const again = await h.json<{ import: { files: Files } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${waiting.body.import.importId}`)
    expect(again.body.import.files.map((file) => [file.name, file.state])).toEqual([['Gold.md', 'waiting'], ['Old.md', 'failed']])
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ import: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${waiting.body.import.importId}`)).body.import.state).toBe('committed')
    const names = (await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources.map((source) => source.name)
    expect(names).toContain('Gold.md')
    expect(names).not.toContain('Old.md')
  })

  it('files still waiting after a 1st (the month already full again) are kept for the next one', async () => {
    const id = await h.collection(PEOPLE.maya)
    await override({ learned_month: 1 })
    await h.note(PEOPLE.maya, id, 'The first rule.')
    const first = await upload(PEOPLE.maya, id, [{ name: 'Gold.md', text: 'Gold partners renew every March.' }])
    const second = await upload(PEOPLE.maya, id, [{ name: 'Silver.md', text: 'Silver partners renew every June.' }])
    const a = await h.json<{ import: { importId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: first })
    const b = await h.json<{ import: { importId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: second })
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    const state = async (importId: string) => (await h.json<{ import: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports/${importId}`)).body.import.state
    expect([await state(a.body.import.importId), await state(b.body.import.importId)]).toEqual(['committed', 'waiting'])
    h.clock.now = Date.UTC(2027, 0, 1, 0, 5)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await state(b.body.import.importId)).toBe('committed')
  })
})

describe('asking and fixing', () => {
  it('a citation with more digits than any source is still a citation outside the sources', () => {
    expect(checkCitations({ text: 'True [1] and false [1000].', citations: [1], model: 'm' }, 2)).toBeNull()
    expect(checkCitations({ text: 'Both [1, 2].', citations: [], model: 'm' }, 2)).toEqual([1, 2])
    expect(checkCitations({ text: 'Out of range [1, 3].', citations: [], model: 'm' }, 2)).toBeNull()
  })

  it('a written answer whose writer cited passages it wasn\'t given shows the sources alone', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.')
    h.engine.control.setAnswerMode('bad_citation')
    const answer = await h.json<{ outcome: string; text: string | null }>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    expect(answer.body).toMatchObject({ outcome: 'sources_only', text: null })
  })

  it('only collections that cover the question are cited', async () => {
    const covered = await h.collection(PEOPLE.maya, 'Covered')
    const other = await h.collection(PEOPLE.maya, 'Other')
    await h.note(PEOPLE.maya, covered, 'Gold partners renew every March.')
    await h.note(PEOPLE.maya, other, 'Silver tiers exist.')
    const answer = await h.json<{ sources: { collectionId: string }[] }>(PEOPLE.maya, 'POST', '/api/ask', { collections: [covered, other], question: 'When do gold partners renew?' })
    expect(answer.body.sources.map((source) => source.collectionId)).toEqual([covered])
  })

  it('the organization\'s own model is called through the platform\'s integration proxy over the gateway binding', async () => {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const real = h.env.GATEWAY_FETCH!
    h.env.SUGER_INTEGRATIONS_URL = `${GATEWAY}/integrations`
    h.env.INTEGRATION_FETCH = undefined
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/integrations/')) {
        seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
        return Response.json({ choices: [{ message: { content: 'The alliance lead signs them off [1].' } }] })
      }
      return real(input, init)
    }) as typeof fetch
    await h.call(PEOPLE.dana, 'PUT', '/api/rules', { answerWriter: { kind: 'own', integrationKey: 'acme-llm', url: 'https://llm.example.com/v1/chat/completions', model: 'acme-model-1' } })
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.')
    const answer = await h.json<{ outcome: string; writer: string }>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    expect(answer.body).toMatchObject({ outcome: 'answered', writer: 'own' })
    expect(seen[0]!.url).toBe(`${GATEWAY}/integrations/acme-llm/proxy/llm.example.com/v1/chat/completions`)
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer app-token')
    expect(seen[0]!.headers.get('x-suger-organization-id')).toBe(ORG)
  })

  it('fixing a fact while the collection is asleep queues the fix without a search, and doesn\'t wake it', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.\n\nDeals above $25,000 need sign-off from the alliance lead.')
    const facts = await h.json<{ facts: { factId: string; sentence: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const fact = facts.body.facts.find((entry) => /20 percent/.test(entry.sentence))!
    h.engine.control.setState(ORG, id, 'asleep')
    const fixed = await h.json<{ correction: { outdated: { textHash: string }[] } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { factId: fact.factId, text: 'Partner discounts stop at 15 percent.' })
    expect(fixed.status).toBe(202)
    expect(fixed.body.correction.outdated).toHaveLength(1)
  })

  it('a report is fixed when its correction is learned, and stays open if learning fails', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    const report = await h.json<{ report: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/reports`, { question: 'Where do discounts stop?' })
    h.engine.control.hold(true)
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Partner discounts stop at 15 percent.', reportId: report.body.report.id })
    const statusOf = () => h.db.prepare(`SELECT status FROM reports WHERE id = ?`).bind(report.body.report.id).first('status')
    expect(await statusOf()).toBe('open')
    h.engine.control.failNextImport({ collectionId: id, times: 3 })
    h.engine.control.hold(false)
    await h.tick()
    expect(await statusOf()).toBe('open')
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Partner discounts stop at 15 percent.', reportId: report.body.report.id })
    await h.tick()
    expect(await statusOf()).toBe('fixed')
  })

  it('a fix can tell the person who added the file, who gets a link and not the text', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    const files = await upload(PEOPLE.eli, id, [{ name: 'Discounts.md', text: 'Partner discounts stop at 20 percent.' }])
    await h.call(PEOPLE.eli, 'POST', `/api/collections/${id}/imports`, { fileIds: files })
    await h.tick()
    const found = await h.json<{ passages: { documentId: string; textHash: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts stop' })
    const passage = found.body.passages[0]!
    const fixed = await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Partner discounts stop at 15 percent.', outdated: [{ documentId: passage.documentId, textHash: passage.textHash }], notifyAuthors: true })
    expect(fixed.status).toBe(202)
    const told = h.gateway.mail.filter((mail) => mail.to === PEOPLE.eli.email && /corrected/.test(mail.subject))
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain(`https://knowledge.insulinapps.test/collections/${id}`)
    expect(told[0]!.text).not.toContain('15 percent')
  })

  it('mail links to the collection on the app\'s own host', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    const shared = h.gateway.mail.find((mail) => mail.to === PEOPLE.eli.email && /shared/.test(mail.subject))!
    expect(shared.text).toContain(`https://knowledge.insulinapps.test/collections/${id}`)
  })
})

describe('the tick', () => {
  it('watches organizations round-robin, from where the last tick stopped', async () => {
    await h.collection(PEOPLE.maya)
    await h.collection(PEOPLE.outsider, 'Elsewhere')
    const first = await watchLimits(h.env, h.clock.now, { batch: 1, deadline: Date.now() + 5_000 })
    const second = await watchLimits(h.env, h.clock.now, { batch: 1, deadline: Date.now() + 5_000 })
    expect([first.organizations, second.organizations].flat().sort()).toEqual([ORG, OTHER_ORG].sort())
  })

  it('sends the hour\'s usage report before the rest of its work', async () => {
    const order: string[] = []
    const real = h.env.GATEWAY_FETCH!
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push(new URL(String(input)).pathname)
      return real(input, init)
    }) as typeof fetch
    await h.tick()
    expect(order[0]).toBe('/__insulin/metrics')
  })

  it('prunes what it no longer needs: old outbox marks, finished reservations and idempotency answers', async () => {
    const old = h.clock.now - 60 * 24 * 60 * 60 * 1000
    await h.db.batch([
      h.db.prepare(`INSERT INTO engine_events (id, at) VALUES ('old-event', ?)`).bind(old),
      h.db.prepare(`INSERT INTO reservations (id, org_id, period, key, amount, consumed, state, ref, created_at, expires_at, settled_at) VALUES ('old-r', ?, '2026-09', 'questions_month', 1, 0, 'settled', 'q', ?, ?, ?)`).bind(ORG, old, old, old),
      h.db.prepare(`INSERT INTO idempotency (org_id, actor, key, route, request_hash, status, body, created_at) VALUES (?, 'u', 'old-key-0001', 'POST /x', 'h', 200, '{}', ?)`).bind(ORG, old),
    ])
    await h.tick()
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM engine_events WHERE id = 'old-event'`).first('n')).toBe(0)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE id = 'old-r'`).first('n')).toBe(0)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM idempotency WHERE key = 'old-key-0001'`).first('n')).toBe(0)
  })

  it('a request that died holding its idempotency key doesn\'t block the key for a day', async () => {
    // The first request with this key stopped mid-way ten minutes ago, its claim still "running".
    const hash = createHash('sha256').update(JSON.stringify(['POST', '/api/collections', { name: 'After a crash' }])).digest('hex')
    await h.db.prepare(`INSERT INTO idempotency (org_id, actor, key, route, request_hash, status, body, created_at) VALUES (?, ?, 'stuck-key-0001', 'POST /api/collections', ?, 0, NULL, ?)`).bind(ORG, PEOPLE.maya.id, hash, h.clock.now - 10 * 60_000).run()
    const created = await h.call(PEOPLE.maya, 'POST', '/api/collections', { name: 'After a crash' }, { 'idempotency-key': 'stuck-key-0001' })
    expect(created.status).toBe(201)
  })
})

describe('deleting', () => {
  it('a deleted organization leaves no names or text in Knowledge\'s database', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Where do partner discounts stop?' })
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Secret correction text about discounts.' })
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/reports`, { question: 'Is it right?', note: 'Report text.' })
    await h.tick()
    h.gateway.addEvent({ type: 'org_deleted', org: ORG })
    await h.tick()
    const tables = (await h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%org_id%'`).all<{ name: string }>()).results.map((row) => row.name)
    const left: Record<string, number> = {}
    for (const table of tables) {
      if (table === 'org_purges') continue
      const n = Number(await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`).bind(ORG).first('n'))
      if (n) left[table] = n
    }
    expect(left).toEqual({})
  })

  it('a deleted collection leaves no questions, corrections, reports or file names behind', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.', 'Discount rules')
    await h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Where do partner discounts stop?' })
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/reports`, { question: 'Is it right?' })
    await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })
    await h.tick()
    for (const table of ['questions', 'gaps', 'reports', 'corrections', 'imports', 'history', 'staged_files', 'collection_shares', 'exports', 'fact_checks']) {
      expect({ table, n: await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE collection_id = ?`).bind(id).first('n') }).toEqual({ table, n: 0 })
    }
    expect(await h.db.prepare(`SELECT name || purpose AS words FROM collections WHERE id = ?`).bind(id).first('words')).not.toMatch(/Partner/)
  })
})

describe('Needs attention', () => {
  it('reads hidden values from the documents list, one engine call per collection', async () => {
    const id = await h.collection(PEOPLE.maya)
    for (let index = 0; index < 5; index += 1) await h.note(PEOPLE.maya, id, `Write to person${index}@example.com about rule ${index}.`, `Note ${index}`)
    const engine = h.env.ENGINE!
    const calls: string[] = []
    h.env.ENGINE = { fetch: async (request) => { calls.push(`${request.method} ${new URL(request.url).pathname}`); return engine.fetch(request) } }
    const attention = await h.json<{ collections: { items: { kind: string; total?: number }[] }[] }>(PEOPLE.maya, 'GET', '/api/attention')
    expect(attention.body.collections[0]!.items.filter((item) => item.kind === 'hidden')).toHaveLength(5)
    expect(calls.filter((call) => /\/documents\//.test(call))).toEqual([])
  })

  it('shows a correction that asks to be checked after its file was read again', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Project Bluebird ships in March.', 'Plans')
    const found = await h.json<{ passages: { documentId: string; textHash: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'Bluebird ships March' })
    const passage = found.body.passages[0]!
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Project Bluebird ships in April.', outdated: [{ documentId: passage.documentId, textHash: passage.textHash }] })
    await h.tick()
    await h.call(PEOPLE.dana, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluebird'] } })
    await h.tick()
    const attention = await h.json<{ collections: { items: { kind: string }[] }[] }>(PEOPLE.maya, 'GET', '/api/attention')
    expect(attention.body.collections[0]!.items.map((item) => item.kind)).toContain('needs_check')
  })
})

describe('the in-memory engine', () => {
  it('purges only the organization its request names', async () => {
    const id = await h.collection(PEOPLE.maya)
    const answer = await h.engine.fetch(new Request(`https://engine.test/v1/orgs/${ORG}/purge`, { method: 'POST', headers: { 'x-knowledge-org': OTHER_ORG } }))
    expect(answer.status).toBe(404)
    const status = await (await h.engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { headers: { 'x-knowledge-org': ORG } }))).json() as { state: string }
    expect(status.state).not.toBe('deleted')
  })

  it('writes awake time to its ledger every minute while awake', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    h.clock.advance(2 * 60_000)
    await h.tick()
    expect(Number(await h.db.prepare(`SELECT COALESCE(SUM(used), 0) AS n FROM usage_counters WHERE key = 'awake_hours_month'`).first('n'))).toBeGreaterThanOrEqual(120)
  })
})
