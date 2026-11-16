import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyEngineEvent } from '../../src/app/server/outbox.ts'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// The platform's five-minute tick: who may call it, member events and the resync after 410, the engine's outbox
// applied once, deletions retried, and the organization deleted on insulinapps.com purged.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const tick = (headers: Record<string, string>) => h.call(PEOPLE.maya, 'POST', '/api/scheduled', undefined, headers)

describe('the tick', () => {
  it('only the platform\'s tick passes: an identity or another access-via is refused', async () => {
    const bare = new Request('https://knowledge.insulinapps.test/api/scheduled', { method: 'POST', headers: { 'x-suger-access-via': 'schedule', 'x-suger-app-id': 'insulin-apps-knowledge' } })
    const { createApp } = await import('../../src/app/server/app.ts')
    expect((await createApp({ enforceSameOrigin: true }).fetch(bare, h.env)).status).toBe(200)
    expect((await tick({ 'x-suger-access-via': 'schedule' })).status).toBe(403)
    expect((await h.call(PEOPLE.maya, 'POST', '/api/scheduled')).status).toBe(403)
    // A request marked schedule is nobody everywhere else.
    const nobody = new Request('https://knowledge.insulinapps.test/api/collections', { headers: { 'x-suger-access-via': 'schedule' } })
    expect((await createApp().fetch(nobody, h.env)).status).toBe(401)
  })

  it('member events: the first tick only takes the cursor; each page saves it', async () => {
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.eli.id })
    await h.tick()
    expect(h.gateway.eventCalls).toEqual([null])
    expect(await h.db.prepare(`SELECT away FROM members WHERE principal_id = ?`).bind(PEOPLE.eli.id).first('away')).toBe(0)
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.eli.id })
    await h.tick()
    expect(h.gateway.eventCalls).toEqual([null, '1'])
    expect(await h.db.prepare(`SELECT away FROM members WHERE principal_id = ?`).bind(PEOPLE.eli.id).first('away')).toBe(1)
    expect(await h.db.prepare(`SELECT cursor FROM sync_state WHERE name = 'member_events'`).first('cursor')).toBe('2')
  })

  it('an API client revoked loses its shares, and an organization deleted on insulinapps.com is purged in the engine', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.share(PEOPLE.maya, id, PEOPLE.client, 'VIEWER')
    await h.tick()
    h.gateway.addEvent({ type: 'client_revoked', org: ORG, client: PEOPLE.client.id })
    await h.tick()
    expect(await h.db.prepare(`SELECT status FROM collection_shares WHERE principal_id = ?`).bind(PEOPLE.client.id).first('status')).toBe('on_hold')
    h.gateway.addEvent({ type: 'org_deleted', org: ORG })
    await h.tick()
    expect(h.engine.control.snapshot().collections).toEqual([expect.objectContaining({ collectionId: id, state: 'deleted' })])
    expect(await h.db.prepare(`SELECT state FROM collections WHERE id = ?`).bind(id).first('state')).toBe('deleted')
    expect(await h.db.prepare(`SELECT done_at IS NOT NULL AS done FROM org_purges WHERE org_id = ?`).bind(ORG).first('done')).toBe(1)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM collection_shares WHERE org_id = ?`).bind(ORG).first('n')).toBe(0)
  })

  it('after 410 cursor_expired: a fresh cursor, everyone unchecked, then checked with member status; nothing lost', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    await h.tick()
    // While events were lost: Eli left, Maya became a Viewer.
    h.gateway.setMember(ORG, PEOPLE.eli.id, { member: false })
    h.gateway.setMember(ORG, PEOPLE.maya.id, { appRole: 'VIEWER', orgRole: 'VIEWER', name: PEOPLE.maya.name, email: PEOPLE.maya.email })
    h.gateway.eventsExpired = true
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.leo.id })
    await h.tick()
    expect(h.gateway.eventCalls.slice(-2)).toEqual(['0', null])
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE unchecked = 1`).first('n')).toBe(0)
    expect(await h.db.prepare(`SELECT resync_started_at FROM sync_state WHERE name = 'member_events'`).first('resync_started_at')).toBeNull()
    expect(await h.db.prepare(`SELECT status FROM collection_shares WHERE principal_id = ?`).bind(PEOPLE.eli.id).first('status')).toBe('on_hold')
    expect(await h.db.prepare(`SELECT owner_id FROM collections WHERE id = ?`).bind(id).first('owner_id')).toBe(PEOPLE.dana.id)
    // Events after the fresh cursor are read as usual.
    h.gateway.eventsExpired = false
    h.gateway.addEvent({ type: 'left', org: ORG, user: PEOPLE.leo.id })
    await h.tick()
    expect(await h.db.prepare(`SELECT status FROM collection_shares WHERE principal_id = ?`).bind(PEOPLE.leo.id).first('status')).toBe('on_hold')
  })

  it('a resync cut short resumes where it stopped', async () => {
    await h.tick()
    h.gateway.eventsExpired = true
    const realFetch = h.gateway.fetch
    let statusCalls = 0
    h.env.GATEWAY_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/members/status') && (statusCalls += 1) === 1) return Response.json({ error: 'unavailable' }, { status: 503 })
      return realFetch(input, init)
    }) as typeof fetch
    await h.tick()
    expect(await h.db.prepare(`SELECT resync_started_at IS NOT NULL AS running FROM sync_state WHERE name = 'member_events'`).first('running')).toBe(1)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE unchecked = 1`).first('n')).toBeGreaterThan(0)
    await h.tick()
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE unchecked = 1`).first('n')).toBe(0)
    expect(await h.db.prepare(`SELECT resync_started_at FROM sync_state WHERE name = 'member_events'`).first('resync_started_at')).toBeNull()
  })

  it('the engine\'s outbox is applied once per event: history, counts and usage', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    expect(await h.db.prepare(`SELECT version, documents, engine_state FROM collections WHERE id = ?`).bind(id).first()).toEqual({ version: 1, documents: 1, engine_state: 'asleep' })
    expect(await h.db.prepare(`SELECT summary FROM history WHERE collection_id = ?`).bind(id).all()).toMatchObject({ results: [{ summary: 'Added a note' }] })
    const event = { id: 'e-usage-1', at: new Date(h.clock.now).toISOString(), org: ORG, collectionId: id, type: 'usage' as const, kind: 'awake' as const, seconds: 600 }
    expect(await applyEngineEvent(h.env, event, h.clock.now)).toBe(true)
    expect(await applyEngineEvent(h.env, event, h.clock.now)).toBe(false)
    expect(await h.db.prepare(`SELECT used FROM usage_counters WHERE key = 'awake_hours_month'`).first('used')).toBe(600)
    // A tick that overlaps with another sees the same page: nothing doubles.
    await h.db.prepare(`UPDATE sync_state SET cursor = NULL WHERE name = 'outbox'`).run()
    await h.tick()
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM history WHERE collection_id = ?`).bind(id).first('n')).toBe(1)
    expect(await h.db.prepare(`SELECT used FROM usage_counters WHERE key = 'learned_month'`).first('used')).toBe(1)
  })

  it('a deletion the engine didn\'t finish is retried by the tick', async () => {
    const id = await h.collection(PEOPLE.maya)
    const engine = h.env.ENGINE
    h.env.ENGINE = { fetch: async (request) => (request.method === 'DELETE' ? Response.json({ error: 'internal', message: 'down' }, { status: 503 }) : engine!.fetch(request)) }
    expect((await h.json<{ state: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })).body.state).toBe('deleting')
    expect((await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'anything' })).status).toBe(409)
    h.env.ENGINE = engine
    await h.tick()
    expect(await h.db.prepare(`SELECT state FROM collections WHERE id = ?`).bind(id).first('state')).toBe('deleted')
  })

  it('a stricter hiding rule reaches every collection\'s engine, now or on the next tick', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Project Bluebird ships in March.')
    expect((await h.call(PEOPLE.dana, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluebird'] } })).status).toBe(200)
    const status = await h.json<{ engine: { settings: { hiding: { words: string[] } } } }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)
    expect(status.body.engine.settings.hiding.words).toEqual(['Bluebird'])
    const sources = await h.json<{ sources: { documentId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)
    const text = await h.json<{ source: { text: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources/${sources.body.sources[0]!.documentId}`)
    expect(text.body.source.text).toContain('Project [hidden] ships')
    const history = await h.json<{ restorePoints: { version: number; restorable: boolean; reason: string | null }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/history`)
    expect(history.body.restorePoints.find((point) => point.version === 1)).toMatchObject({ restorable: false, reason: 'newly_hidden' })
  })
})
