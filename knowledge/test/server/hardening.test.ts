import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORG_HEADER, type CollectionStatus, type OutboxEvent } from '../../engine/src/contract.ts'
import { syncMembers } from '../../src/app/server/members.ts'
import { applyEngineEvent, syncOutbox } from '../../src/app/server/outbox.ts'
import { startWaitingImports } from '../../src/app/server/tick.ts'
import { createHarness, MIGRATIONS_FOLDER, ORG, OTHER_ORG, PEOPLE, type Harness } from '../support/harness.ts'

// The tick and requests under the conditions production brings: pages longer than the tick's time, calls that never
// answer, ticks that overlap, requests that race, retries after an answer was lost, and hidden values that must never
// be kept.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => {
  vi.restoreAllMocks()
  h.close()
})

const HOUR = 3600
const MINUTE_MS = 60_000

/** The engine's own view of a collection (its settings, its state). */
async function engineStatus(id: string, org = ORG): Promise<CollectionStatus> {
  const response = await h.engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { headers: { [ORG_HEADER]: org } }))
  return (await response.json()) as CollectionStatus
}

/** The D1 binding with `before(sql)` run before each statement (it may throw, or wait), batches included. */
function wrapDb(before: (sql: string) => void | Promise<void>) {
  const db = h.db as unknown as D1Database
  const targets = new WeakMap<object, D1PreparedStatement>()
  const sqlOf = (statement: D1PreparedStatement) => (statement as unknown as { sql: string }).sql
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, name, receiver) {
        if (name === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
        if (name === 'run' || name === 'all' || name === 'first' || name === 'raw') {
          return async (...args: unknown[]) => {
            await before(sqlOf(target))
            return (target as never as Record<string, (...a: unknown[]) => unknown>)[name]!.apply(target, args)
          }
        }
        return Reflect.get(target, name, receiver)
      },
    })
    targets.set(proxy, statement)
    return proxy
  }
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const real = statements.map((statement) => targets.get(statement) ?? statement)
      for (const statement of real) await before(sqlOf(statement))
      return db.batch(real)
    },
    exec: (sql: string) => db.exec(sql),
  } as unknown as D1Database
}

/** D1 as the tick meets it in production: every statement takes `ms` of the tick's time (Date.now moves on). */
function slowDb(ms: number): D1Database {
  const real = Date.now.bind(Date)
  let offset = 0
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
  return wrapDb(() => { offset += ms })
}

/** Statements whose SQL holds `fragment` fail once, as when D1 is briefly unavailable. */
function failOnce(fragment: string) {
  let armed = true
  h.env.DB = wrapDb((sql) => {
    if (armed && sql.includes(fragment)) {
      armed = false
      throw new Error('D1 is unavailable')
    }
  })
}

const cursorOf = async (name: string) => (await h.db.prepare(`SELECT cursor FROM sync_state WHERE name = ?`).bind(name).first<{ cursor: string | null }>())?.cursor ?? null
const heldFor = async (org: string, like: string) => (await h.db.prepare(`SELECT key, amount, ref FROM reservations WHERE org_id = ? AND state = 'held' AND ref LIKE ?`).bind(org, like).all()).results
const used = async (org: string, key: string) => Number(await h.db.prepare(`SELECT COALESCE(SUM(used), 0) AS n FROM usage_counters WHERE org_id = ? AND key = ?`).bind(org, key).first('n'))
const setLimit = (org: string, key: string, value: number | null, until: number | null = null) =>
  h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, ?, ?, ?, 0) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value, until = excluded.until`).bind(org, key, value, until).run()
const clearLimits = (org: string) => h.db.prepare(`DELETE FROM org_limits WHERE org_id = ?`).bind(org).run()

describe('the tick within its time', () => {
  it('member events: a page that outlasts the tick still moves the cursor, event by event', async () => {
    await h.tick()
    const start = Number(await cursorOf('member_events'))
    for (let index = 0; index < 30; index += 1) {
      h.gateway.addEvent({ type: 'returned', org: ORG, user: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, appRole: 'VIEWER', orgRole: 'VIEWER' })
    }
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.leo.id })
    const env = { ...h.env, DB: slowDb(100) }
    const first = await syncMembers(env, h.clock.now, Date.now() + 1_000)
    const after = Number(await cursorOf('member_events'))
    expect(first.applied).toBeGreaterThan(0)
    expect(after).toBe(start + first.applied)
    for (let run = 0; run < 30 && Number(await cursorOf('member_events')) < start + 31; run += 1) await syncMembers(env, h.clock.now, Date.now() + 1_000)
    expect(await h.db.prepare(`SELECT away FROM members WHERE org_id = ? AND principal_id = ?`).bind(ORG, PEOPLE.leo.id).first('away')).toBe(1)
  })

  it('the outbox: a page that outlasts the tick still moves the cursor, event by event', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.tick()
    for (let index = 0; index < 30; index += 1) h.engine.control.addUsage(ORG, id, 'awake', 60)
    const before = await used(ORG, 'awake_hours_month')
    const env = { ...h.env, DB: slowDb(100) }
    const first = await syncOutbox(env, h.clock.now, Date.now() + 1_000)
    expect(first.applied).toBeGreaterThan(0)
    expect(first.applied).toBeLessThan(30)
    expect(await used(ORG, 'awake_hours_month')).toBe(before + first.applied * 60)
    for (let run = 0; run < 40; run += 1) await syncOutbox(env, h.clock.now, Date.now() + 1_000)
    expect(await used(ORG, 'awake_hours_month')).toBe(before + 30 * 60)
  })

  it('an outbox event applied before is skipped before anything else is read', async () => {
    const id = await h.collection(PEOPLE.maya)
    const event = { id: '000000000777', at: new Date(h.clock.now).toISOString(), org: ORG, collectionId: id, type: 'usage', kind: 'awake', seconds: 60 } as OutboxEvent
    expect(await applyEngineEvent(h.env, event, h.clock.now)).toBe(true)
    const read: string[] = []
    const env = { ...h.env, DB: wrapDb((sql) => { read.push(sql) }) }
    expect(await applyEngineEvent(env, event, h.clock.now)).toBe(false)
    expect(read).toHaveLength(1)
    expect(read[0]).toContain('engine_events')
  })

  it('gives up on an engine call at the deadline, its body included', async () => {
    const real = h.env.ENGINE!
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/v1/outbox') {
          // Headers at once; a body that never ends.
          return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return real.fetch(request)
      },
    }
    const started = Date.now()
    await syncOutbox(h.env, h.clock.now, Date.now() + 300).catch(() => null)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 10_000)

  it('gives up on a platform call at the deadline', async () => {
    await h.tick()
    const real = h.env.GATEWAY_FETCH!
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/member-events')) return new Promise<Response>(() => {})
      return real(input, init)
    }) as typeof fetch
    const started = Date.now()
    await syncMembers(h.env, h.clock.now, Date.now() + 300).catch(() => null)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 15_000)
})

describe('settings the engine keeps', () => {
  it('days of backups outside 1 to 3650 are sent as the nearest the engine takes', async () => {
    await setLimit(ORG, 'backup_days', 0)
    const low = await h.collection(PEOPLE.maya, 'Low')
    expect((await engineStatus(low)).settings.backupDays).toBe(1)
    await setLimit(ORG, 'backup_days', 99_999)
    const high = await h.collection(PEOPLE.maya, 'High')
    expect((await engineStatus(high)).settings.backupDays).toBe(3650)
  })

  it('an override of the days of backups that ends is sent to the engine', async () => {
    await setLimit(ORG, 'backup_days', 7, h.clock.now + HOUR * 1000)
    const id = await h.collection(PEOPLE.maya)
    expect((await engineStatus(id)).settings.backupDays).toBe(7)
    h.clock.advance(2 * HOUR * 1000)
    await h.tick()
    expect((await engineStatus(id)).settings.backupDays).toBe(30)
  })

  it('a collection whose push keeps failing doesn\'t keep the others from theirs', async () => {
    const theirs = await h.collection(PEOPLE.outsider, 'Elsewhere')
    for (let index = 0; index < 30; index += 1) {
      await h.db.prepare(`INSERT INTO collections (id, org_id, owner_id, owner_since, name, purpose, created_at, created_by, updated_at, settings_version) VALUES (?, ?, ?, 0, ?, '', 0, ?, 0, -1)`)
        .bind(`stuck-${index}`, ORG, PEOPLE.maya.id, `Stuck ${index}`, PEOPLE.maya.id).run()
    }
    const real = h.env.ENGINE!
    let failTheirs = true
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        if (request.method === 'PUT' && (path.includes('/stuck-') || (failTheirs && path.endsWith(`/${theirs}`)))) {
          if (!path.includes('/stuck-')) failTheirs = false
          return Response.json({ error: 'internal', message: 'boom' }, { status: 500 })
        }
        return real.fetch(request)
      },
    }
    // Globex's new rule doesn't reach the engine at first; Acme's thirty collections fail every time they are sent.
    await h.json(PEOPLE.outsider, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Globex'] } })
    expect((await engineStatus(theirs, OTHER_ORG)).settings.hiding.words).toEqual([])
    for (let tick = 0; tick < 2; tick += 1) {
      h.clock.advance(5 * MINUTE_MS)
      await h.tick()
    }
    expect((await engineStatus(theirs, OTHER_ORG)).settings.hiding.words).toEqual(['Globex'])
  })

  it('an older settings push arriving late doesn\'t undo a newer one', async () => {
    const id = await h.collection(PEOPLE.maya)
    const real = h.env.ENGINE!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = false
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        if (request.method === 'PUT' && !held) {
          const body = (await request.clone().json()) as { settings: { keepReady: unknown } }
          if (body.settings.keepReady) {
            held = true
            await gate
          }
        }
        return real.fetch(request)
      },
    }
    const enable = h.json(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { keepReady: { days: [1, 2, 3], start: '09:00', hours: 1 } })
    for (let wait = 0; wait < 50 && !held; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(held).toBe(true)
    expect((await h.json(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { keepReady: null })).status).toBe(200)
    release()
    expect((await enable).status).toBe(200)
    expect((await engineStatus(id)).settings.keepReady).toBeNull()
    await h.tick()
    expect((await engineStatus(id)).settings.keepReady).toBeNull()
    expect(await h.db.prepare(`SELECT keep_ready FROM collections WHERE id = ?`).bind(id).first('keep_ready')).toBeNull()
  })
})

describe('waiting imports', () => {
  /** A note that waits for the 1st: the organization's month is full. */
  async function waitingNote(org = ORG, person = PEOPLE.maya, id?: string) {
    const collection = id ?? (await h.collection(person))
    await setLimit(org, 'learned_month', 0)
    const answer = await h.json<{ import: { importId: string; state: string } }>(person, 'POST', `/api/collections/${collection}/notes`, { title: 'Rule', text: 'Partner discounts stop at 20 percent.' })
    expect(answer.body.import.state).toBe('waiting')
    return { collection, importId: answer.body.import.importId }
  }
  const stateOf = async (importId: string) => h.db.prepare(`SELECT state, request IS NOT NULL AS kept FROM imports WHERE id = ?`).bind(importId).first<{ state: string; kept: number }>()

  it('one whose start the engine never got waits again and is sent again, never cancelled', async () => {
    const { collection, importId } = await waitingNote()
    h.clock.advance(2 * HOUR * 1000)
    await clearLimits(ORG)
    const real = h.env.ENGINE!
    let fail = true
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        if (fail && request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports')) {
          fail = false
          return Response.json({ error: 'internal', message: 'boom' }, { status: 500 })
        }
        return real.fetch(request)
      },
    }
    await h.tick()
    expect(await stateOf(importId)).toEqual({ state: 'waiting', kept: 1 })
    h.clock.advance(5 * MINUTE_MS)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await stateOf(importId))!.state).toBe('committed')
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${collection}/sources`)).body.sources).toHaveLength(1)
    expect(await used(ORG, 'learned_month')).toBe(1)
  })

  it('one the engine took but whose answer was lost is sent again with the same id and learned once', async () => {
    const { importId } = await waitingNote()
    await clearLimits(ORG)
    const real = h.env.ENGINE!
    let lose = true
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        const response = await real.fetch(request)
        if (lose && request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports')) {
          lose = false
          return Response.json({ error: 'internal', message: 'The answer was lost.' }, { status: 502 })
        }
        return response
      },
    }
    await h.tick()
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await stateOf(importId))!.state).toBe('committed')
    expect(await used(ORG, 'learned_month')).toBe(1)
  })

  it('one the engine refuses when it is sent fails, and whoever added it is told', async () => {
    const { importId } = await waitingNote()
    await clearLimits(ORG)
    const real = h.env.ENGINE!
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports')) return Response.json({ error: 'bad_request', message: 'No.' }, { status: 400 })
        return real.fetch(request)
      },
    }
    const before = h.gateway.mail.length
    await h.tick()
    expect((await stateOf(importId))!.state).toBe('failed')
    expect(h.gateway.mail.slice(before).map((mail) => mail.to)).toContain(PEOPLE.maya.email)
  })

  it('two ticks at once reserve a waiting import\'s learning once', async () => {
    const { importId } = await waitingNote()
    await clearLimits(ORG)
    const deadline = Date.now() + 5_000
    await Promise.all([startWaitingImports(h.env, h.clock.now, deadline), startWaitingImports(h.env, h.clock.now, deadline)])
    expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE ref = ? AND key = 'learned_month'`).bind(`import:${importId}`).first('n'))).toBe(1)
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await used(ORG, 'learned_month')).toBe(1)
  })

  it('are started organization by organization, from where the last tick stopped, and hold no awake time while they wait', async () => {
    const theirs = await h.collection(PEOPLE.outsider, 'Elsewhere')
    await setLimit(OTHER_ORG, 'learned_month', 0)
    for (let index = 0; index < 25; index += 1) {
      await h.db.prepare(`INSERT INTO imports (id, org_id, collection_id, kind, created_by, created_at, state, files, detail, request) VALUES (?, ?, ?, 'note', ?, ?, 'waiting', 0, '{}', ?)`)
        .bind(`old-${index}`, OTHER_ORG, theirs, PEOPLE.outsider.id, index, JSON.stringify({ files: [], notes: [{ noteId: `n${index}`, title: 'Old', text: 'Waiting.', outdated: [] }] })).run()
    }
    const { importId } = await waitingNote()
    await clearLimits(ORG)
    await h.tick()
    await h.tick()
    expect((await stateOf(importId))!.state).not.toBe('waiting')
    expect(await heldFor(OTHER_ORG, 'awake:%')).toEqual([])
  })
})

describe('hidden values', () => {
  it('a correction is kept with its hidden values hidden, and Needs attention shows that copy', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent. Ask the alliance lead.')
    const facts = await h.json<{ facts: { factId: string; documentId: string; passageTextHash: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const fix = await h.json<{ correction: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, {
      text: 'Discounts stop at 15 percent; ask sam.private@example.test or call +1 555 010 4477.', factId: facts.body.facts[0]!.factId, question: 'Ask sam.private@example.test?',
    })
    const row = await h.db.prepare(`SELECT text, question FROM corrections WHERE id = ?`).bind(fix.body.correction.id).first<{ text: string; question: string }>()
    expect(JSON.stringify(row)).not.toContain('sam.private@example.test')
    expect(row!.text).toContain('[hidden]')
    await h.db.prepare(`INSERT INTO correction_checks (collection_id, note_id, document_id, text_hash, org_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, fix.body.correction.id.replace(/-/g, ''), facts.body.facts[0]!.documentId, facts.body.facts[0]!.passageTextHash, ORG, h.clock.now).run()
    const attention = await h.json<{ collections: { items: { kind: string; text?: string }[] }[] }>(PEOPLE.maya, 'GET', `/api/attention?collection=${id}`)
    const item = attention.body.collections[0]!.items.find((entry) => entry.kind === 'needs_check')!
    expect(item.text).toContain('[hidden]')
    expect(item.text).not.toContain('sam.private')
  })

  it('a note waiting for the 1st is kept with its hidden values hidden', async () => {
    const id = await h.collection(PEOPLE.maya)
    await setLimit(ORG, 'learned_month', 0)
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Keys', text: 'The staging password: hunter2-secret-value' })
    const request = await h.db.prepare(`SELECT request FROM imports WHERE org_id = ? AND state = 'waiting'`).bind(ORG).first<{ request: string }>()
    expect(request!.request).not.toContain('hunter2')
    expect(request!.request).toContain('[hidden]')
  })

  it('stricter rules hide what corrections and waiting notes kept', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Project Bluebird discounts stop at 15 percent.' })
    await setLimit(ORG, 'learned_month', 0)
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'Project Bluebird ships in March.' })
    await h.json(PEOPLE.dana, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluebird'] } })
    const kept = await h.db.prepare(`SELECT (SELECT group_concat(text) FROM corrections WHERE org_id = ?1) AS corrections, (SELECT group_concat(request) FROM imports WHERE org_id = ?1 AND state = 'waiting') AS waiting`).bind(ORG).first<{ corrections: string; waiting: string }>()
    expect(kept!.corrections).not.toContain('Bluebird')
    expect(kept!.waiting).not.toContain('Bluebird')
  })

  it('the migration that stopped keeping them scrubs what was kept before', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.db.prepare(`INSERT INTO corrections (id, org_id, collection_id, created_by, created_at, question, text, outdated, import_id) VALUES ('raw', ?, ?, ?, 0, 'Raw question', 'Call +1 555 010 4477', '[]', 'raw')`)
      .bind(ORG, id, PEOPLE.maya.id).run()
    const file = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql')).sort().find((name) => readFileSync(`${MIGRATIONS_FOLDER}/${name}`, 'utf8').includes('UPDATE `corrections`'))
    expect(file).toBeDefined()
    const scrub = readFileSync(`${MIGRATIONS_FOLDER}/${file}`, 'utf8').split('--> statement-breakpoint').filter((statement) => statement.includes('UPDATE `corrections`'))
    for (const statement of scrub) await h.db.prepare(statement).run()
    expect(JSON.stringify(await h.db.prepare(`SELECT text, question FROM corrections WHERE id = 'raw'`).first())).not.toContain('555')
  })
})

describe('deleting, removing and access', () => {
  it('deleting a collection releases what its imports held, learning or waiting', async () => {
    const id = await h.collection(PEOPLE.maya)
    h.engine.control.hold(true)
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'N', text: 'Partner discounts stop at 20 percent.' })
    const other = await h.collection(PEOPLE.maya, 'Second')
    await setLimit(ORG, 'learned_month', 0)
    await h.json(PEOPLE.maya, 'POST', `/api/collections/${other}/notes`, { title: 'N', text: 'Partner discounts stop at 20 percent.' })
    expect((await heldFor(ORG, 'import:%')).length).toBeGreaterThan(0)
    expect((await h.json(PEOPLE.maya, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })).status).toBe(202)
    expect((await h.json(PEOPLE.maya, 'DELETE', `/api/collections/${other}`, { confirmName: 'Second' })).status).toBe(202)
    h.engine.control.hold(false)
    await h.tick()
    expect(await heldFor(ORG, 'import:%')).toEqual([])
  })

  it('removing a file for good works at the awake-hours stop', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    const [source] = (await h.json<{ sources: { documentId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources
    await h.db.prepare(`INSERT INTO usage_counters (org_id, period, key, used, updated_at) VALUES (?, '2026-11', 'awake_hours_month', ?, 0)`).bind(ORG, 100 * HOUR).run()
    const removed = await h.json(PEOPLE.maya, 'DELETE', `/api/collections/${id}/sources/${source!.documentId}`)
    expect(removed.status).toBe(200)
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources).toEqual([])
  })

  it('someone signed in during a resync counts as checked; someone who doesn\'t call stays away until checked', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.tick()
    const real = h.env.GATEWAY_FETCH!
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/members/status')) return Response.json({ error: 'rate_limited' }, { status: 429 })
      return real(input, init)
    }) as typeof fetch
    h.gateway.eventsExpired = true
    await h.tick()
    expect((await h.json(PEOPLE.maya, 'GET', `/api/collections/${id}`)).status).toBe(200)
    expect((await h.json<{ collections: unknown[] }>(PEOPLE.maya, 'GET', '/api/collections')).body.collections).toHaveLength(1)
    expect(await h.db.prepare(`SELECT unchecked FROM members WHERE org_id = ? AND principal_id = ?`).bind(ORG, PEOPLE.leo.id).first('unchecked')).toBe(1)
  })

  it('every resync moves a collection from an owner who acts as a Viewer, even when nothing about them changed', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.tick()
    const narrowed = ['knowledge.use', 'knowledge.collections.create']
    h.gateway.setMember(ORG, PEOPLE.maya.id, { appRole: 'EDITOR', orgRole: 'EDITOR', permissions: narrowed, name: PEOPLE.maya.name, email: PEOPLE.maya.email })
    await h.call({ ...PEOPLE.maya, permissions: narrowed }, 'GET', '/api/me')
    h.gateway.eventsExpired = true
    await h.tick()
    expect(await h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(id).first('owner_id')).toBe(PEOPLE.dana.id)
  })

  it('a share request that ends after the sharer lost Admin changes nothing', async () => {
    const id = await h.collection(PEOPLE.maya)
    expect(await h.share(PEOPLE.maya, id, PEOPLE.ada, 'ADMIN')).toBe(200)
    const real = h.env.GATEWAY_FETCH!
    let revoked = false
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/members/status') && !revoked) {
        revoked = true
        expect((await h.call(PEOPLE.maya, 'DELETE', `/api/collections/${id}/sharing/person/${PEOPLE.ada.id}`)).status).toBe(200)
      }
      return real(input, init)
    }) as typeof fetch
    const answer = await h.call(PEOPLE.ada, 'PUT', `/api/collections/${id}/sharing/person/${PEOPLE.ada.id}`, { role: 'ADMIN' })
    expect(answer.status).toBe(403)
    expect(await h.db.prepare(`SELECT role FROM collection_shares WHERE collection_id = ? AND principal_id = ?`).bind(id, PEOPLE.ada.id).first()).toBeNull()
    expect((await h.call(PEOPLE.ada, 'GET', `/api/collections/${id}`)).status).toBe(403)
  })

  it('a transfer sent again over MCP with the same key is refused as browser-only', async () => {
    const id = await h.collection(PEOPLE.maya)
    const key = { 'idempotency-key': 'transfer-once-1234' }
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id }, key)).status).toBe(200)
    const again = await h.json<{ error: string }>({ ...PEOPLE.maya, via: 'mcp' }, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id }, key)
    expect(again.status).toBe(403)
    expect(again.body.error).toBe('browser_only')
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/transfer`, { to: PEOPLE.eli.id }, key)).status).toBe(200)
  })
})

describe('retries after an answer was lost', () => {
  /** The answer to a change is lost after it was done (saving it failed), and the same request comes back later. */
  async function lostThenAgain(path: string, body: unknown) {
    const key = { 'idempotency-key': `lost-answer-${path.length}-key` }
    failOnce('UPDATE idempotency SET status')
    const first = await h.call(PEOPLE.maya, 'POST', path, body, key)
    expect(first.status).toBe(500)
    h.clock.advance(3 * MINUTE_MS)
    return h.call(PEOPLE.maya, 'POST', path, body, key)
  }

  it('creating a collection again makes no second one', async () => {
    const again = await lostThenAgain('/api/collections', { name: 'Only once' })
    expect(again.status).toBe(201)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM collections WHERE org_id = ? AND name = 'Only once'`).bind(ORG).first('n')).toBe(1)
  })

  it('reporting an answer again makes no second report', async () => {
    const id = await h.collection(PEOPLE.maya)
    const again = await lostThenAgain(`/api/collections/${id}/reports`, { question: 'Who signs off?', note: 'Wrong person.' })
    expect(again.status).toBe(201)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE collection_id = ?`).bind(id).first('n')).toBe(1)
  })

  it('exporting again starts no second export', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    const again = await lostThenAgain(`/api/collections/${id}/exports`, undefined)
    expect(again.status).toBe(202)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM exports WHERE collection_id = ?`).bind(id).first('n')).toBe(1)
  })

  it('deleting a collection erases the saved answer that created it', async () => {
    const created = await h.json<{ collection: { id: string } }>(PEOPLE.maya, 'POST', '/api/collections', { name: 'Project Bluebird' }, { 'idempotency-key': 'create-bluebird-1' })
    await h.json(PEOPLE.maya, 'DELETE', `/api/collections/${created.body.collection.id}`, { confirmName: 'Project Bluebird' })
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM idempotency WHERE body LIKE '%Bluebird%'`).first('n')).toBe(0)
  })

  it('stored text held for a file covers what the organization\'s own words can make of it', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.json(PEOPLE.dana, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['xy'] } })
    await setLimit(ORG, 'storage_bytes', 16)
    const preflight = await h.json<{ error?: string; limit?: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'words.txt', bytes: 8 }] })
    expect(preflight.status).toBe(429)
    expect(preflight.body.limit).toBe('storage_bytes')
  })
})

describe('the awake-hours stop, held in the engine', () => {
  const atTheStop = () => h.db.prepare(`INSERT INTO usage_counters (org_id, period, key, used, updated_at) VALUES (?, '2026-11', 'awake_hours_month', ?, 0)
    ON CONFLICT (org_id, period, key) DO UPDATE SET used = excluded.used`).bind(ORG, 100 * HOUR).run()

  it('at 100% the tick holds the organization in the engine until the 1st, and lets go when the limit is raised', async () => {
    const id = await h.collection(PEOPLE.maya)
    await atTheStop()
    await h.tick()
    expect((await engineStatus(id)).state).toBe('held')
    expect((await h.json<{ engine: { state: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)).body.engine.state).toBe('held')
    await setLimit(ORG, 'awake_hours_month', 200)
    await h.tick()
    expect((await engineStatus(id)).state).not.toBe('held')
  })

  it('the request that meets the stop holds the organization at once', async () => {
    const id = await h.collection(PEOPLE.maya)
    await atTheStop()
    const asked = await h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off?' })
    expect(asked.status).toBe(429)
    expect((await engineStatus(id)).state).toBe('held')
  })

  it('a new month lets go', async () => {
    const id = await h.collection(PEOPLE.maya)
    await atTheStop()
    await h.tick()
    expect((await engineStatus(id)).state).toBe('held')
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    expect((await engineStatus(id)).state).not.toBe('held')
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM org_holds WHERE org_id = ? AND until != 0`).bind(ORG).first('n')).toBe(0)
  })
})
