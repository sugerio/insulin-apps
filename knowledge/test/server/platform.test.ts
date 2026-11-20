import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app/server/app.ts'
import { engineOf } from '../../src/app/server/engine/index.ts'
import { devEngine } from '../../engine/src/stub/index.ts'
import { createHarness, headersOf, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// What the app takes from the platform and gives back: the engine's binding, changes from the app's own origin only,
// Idempotency-Key, awake time reserved in ten-minute blocks, and the 80% notice to admins.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

describe('the engine seam', () => {
  it('uses SUGER_ENGINE from the request\'s runtime env, and the in-memory engine only in a development build', async () => {
    const seen: string[] = []
    const binding = { fetch: async (request: Request) => { seen.push(new URL(request.url).pathname); return Response.json({ engine: 'bound', collections: 0 }) } }
    const request = Object.assign(new Request('https://knowledge.insulinapps.test/api/health'), { runtime: { cloudflare: { env: { SUGER_ENGINE: binding } } } })
    const engine = await engineOf(request)
    await engine!.fetch(new Request('https://engine.test/v1/health'))
    expect(seen).toEqual(['/v1/health'])
    // Tests run as a development build: without the binding, the shared in-memory engine.
    expect(await engineOf(new Request('https://knowledge.insulinapps.test/api/health'))).toBe(devEngine())
  })

  it('without an engine, routes that need one answer 503 engine_unavailable in plain words', async () => {
    h.env.ENGINE = undefined
    const created = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'POST', '/api/collections', { name: 'No engine' })
    expect(created.status).toBe(503)
    expect(created.body.error).toBe('engine_unavailable')
    expect(created.body.message).toMatch(/engine isn't available/)
    expect((await h.json<{ engine: boolean }>(PEOPLE.maya, 'GET', '/api/me')).body.engine).toBe(false)
  })

  it('an engine failure reaches people as plain words, never the engine\'s raw text', async () => {
    const id = await h.collection(PEOPLE.maya)
    h.env.ENGINE = { fetch: async () => new Response('TypeError: boom at Object.<anonymous> (index.ts:1:1)', { status: 500 }) }
    const failed = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)
    expect(failed.status).toBe(503)
    expect(failed.body.message).toBe("Knowledge's engine isn't answering right now. Try again in a minute.")
  })
})

describe('changes', () => {
  it('come only from the app\'s own origin outside development (the gateway sets it for assistants and API clients)', async () => {
    const app = createApp({ enforceSameOrigin: true })
    const post = (headers: Record<string, string>) => app.fetch(new Request('https://knowledge.insulinapps.test/api/collections', {
      method: 'POST', headers: { ...headersOf(PEOPLE.maya), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), ...headers }, body: JSON.stringify({ name: 'Origin test' }),
    }), h.env)
    expect((await post({})).status).toBe(403)
    expect((await post({ origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ origin: 'https://knowledge.insulinapps.test', 'sec-fetch-site': 'same-origin' })).status).toBe(201)
  })

  it('replay with the same Idempotency-Key, and refuse it for a different request', async () => {
    const key = { 'idempotency-key': 'collection-create-0001' }
    const first = await h.call(PEOPLE.maya, 'POST', '/api/collections', { name: 'Once' }, key)
    const again = await h.call(PEOPLE.maya, 'POST', '/api/collections', { name: 'Once' }, key)
    expect(first.status).toBe(201)
    expect(again.status).toBe(201)
    expect(again.headers.get('idempotent-replay')).toBe('true')
    expect(await again.json()).toEqual(await first.json())
    expect((await h.json<{ collections: unknown[] }>(PEOPLE.maya, 'GET', '/api/collections')).body.collections).toHaveLength(1)
    expect((await h.json<{ error: string }>(PEOPLE.maya, 'POST', '/api/collections', { name: 'Twice' }, key)).body.error).toBe('idempotency_key_reused')
    const missing = await h.call(PEOPLE.maya, 'POST', '/api/collections', { name: 'No key' }, { 'idempotency-key': '' })
    expect(((await missing.json()) as { error: string }).error).toBe('idempotency_key_required')
  })
})

describe('awake time and notices', () => {
  it('reserves ten minutes of awake time per wake, and refuses a wake that wouldn\'t fit under the limit', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts' })
    await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts' })
    const held = await h.db.prepare(`SELECT amount, state FROM reservations WHERE org_id = ? AND key = 'awake_hours_month'`).bind(ORG).all()
    expect(held.results).toEqual([{ amount: 600, state: 'held' }])
    // The engine's ledger reports the ten minutes: the block is used up.
    h.clock.advance(11 * 60_000)
    await h.tick()
    expect((await h.db.prepare(`SELECT consumed, state FROM reservations WHERE org_id = ? AND key = 'awake_hours_month'`).bind(ORG).first())).toEqual({ consumed: 600, state: 'settled' })
    h.engine.control.addUsage(ORG, id, 'awake', 100 * 3600 - 600 - 300)
    await h.tick()
    const refused = await h.json<{ error: string; limit: string }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts' })
    expect(refused.status).toBe(429)
    expect(refused.body.limit).toBe('awake_hours_month')
  })

  it('e-mails the organization\'s admins at 80% of a limit, once per month and limit', async () => {
    h.gateway.limits = { status: 200, pages: [{ defaults: { questions_month: 5 }, organizations: [] }] }
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    for (let index = 0; index < 4; index += 1) await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts' })
    await h.tick()
    await h.tick()
    const notices = h.gateway.mail.filter((mail) => /80% of questions a month/.test(mail.subject))
    expect(notices.map((mail) => mail.to).sort()).toEqual([PEOPLE.ada.email, PEOPLE.apps.email, PEOPLE.dana.email, PEOPLE.sam.email].sort())
    expect(notices[0]!.text).toMatch(/used 4 of its 5 questions a month/)
  })
})
