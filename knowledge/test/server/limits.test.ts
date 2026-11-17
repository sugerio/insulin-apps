import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { waitingMessage, type CollectionResult } from '../../src/app/server/ask.ts'
import { effectiveLimit, LIMITS, reserve } from '../../src/app/server/limits.ts'
import { ORGANIZATION_METRICS } from '../../src/app/server/usage-metrics.ts'
import { createHarness, ORG, PEOPLE, SUPPORT, type Harness, type Person } from '../support/harness.ts'
import packageJson from '../../package.json' with { type: 'json' }

// Free limits (design section 12; DESIGN.md §8.8): LIM-01, LIM-02, LIM-03, LIM-07, LIM-08, LIM-10, the limits pulled
// from the operator console, reservations under concurrency and the hourly usage report.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const mcp = (person: Person): Person => ({ ...person, via: 'mcp' })
const HOUR = 3600

/** Overrides for Acme Cloud, as the operator console would set them, applied by a tick. */
async function override(limits: Record<string, number | null>, until: string | null = null) {
  h.gateway.limits.status = 200
  h.gateway.limits.pages.push({ defaults: {}, organizations: [{ id: ORG, limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, { value, until }])) }] })
  await h.tick()
}

describe('limits', () => {
  it('LIM-01 awake hours: keep-ready pauses at 90, the hard stop at 100 names support, and the 1st starts again', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { keepReady: { days: [1, 2, 3, 4, 5], start: '09:00', hours: 2 } })).status).toBe(200)
    h.engine.control.addUsage(ORG, id, 'awake', 90 * HOUR)
    await h.tick()
    const paused = await h.json<{ settings: { keepReady: { paused: boolean } } }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)
    expect((paused.body as unknown as { engine: { settings: { keepReady: { paused: boolean } } } }).engine.settings.keepReady.paused).toBe(true)
    expect(h.gateway.mail.find((mail) => mail.to === PEOPLE.maya.email && /Keep-ready .* is paused/.test(mail.subject))?.text).toContain(`contact Insulin Apps support at ${SUPPORT}`)
    h.engine.control.addUsage(ORG, id, 'awake', 10 * HOUR)
    await h.tick()
    for (const [person, path, body] of [
      [PEOPLE.maya, '/api/ask', { collections: [id], question: 'What are partner discounts?' }],
      [mcp(PEOPLE.maya), '/api/search', { collections: [id], query: 'partner discounts' }],
    ] as const) {
      const stopped = await h.json<Record<string, unknown>>(person, 'POST', path, body)
      // Must catch: no answer at 100 hours.
      expect(stopped.status).toBe(429)
      expect(stopped.body).toMatchObject({ error: 'quota_exceeded', limit: 'awake_hours_month', resets_at: '2026-12-01T00:00:00Z' })
      expect(stopped.body.message).toContain(SUPPORT)
    }
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    expect((await h.json<{ status: string }>(mcp(PEOPLE.maya), 'POST', '/api/search', { collections: [id], query: 'partner discounts' })).status).toBe(200)
    const resumed = await h.json<{ engine: { settings: { keepReady: { paused: boolean } } } }>(PEOPLE.maya, 'GET', `/api/collections/${id}`)
    expect(resumed.body.engine.settings.keepReady.paused).toBe(false)
  })

  it('LIM-01 without a support address, the message says to contact Insulin Apps support', async () => {
    h.env.SUPPORT_EMAIL = undefined
    const id = await h.collection(PEOPLE.maya)
    h.engine.control.addUsage(ORG, id, 'awake', 100 * HOUR)
    await h.tick()
    const stopped = await h.json<{ message: string }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'anything' })
    expect(stopped.status).toBe(429)
    expect(stopped.body.message).toMatch(/contact Insulin Apps support\.$/)
    expect(stopped.body.message).not.toMatch(/@/)
  })

  it('LIM-02 the 21st collection is refused, with resets_at null and the support address', async () => {
    for (let index = 0; index < 20; index += 1) await h.collection(PEOPLE.maya, `Collection ${index}`)
    const refused = await h.json<Record<string, unknown>>(PEOPLE.maya, 'POST', '/api/collections', { name: 'One too many' })
    // Must catch: the 21st collection's refusal.
    expect(refused.status).toBe(429)
    expect(refused.body).toMatchObject({ error: 'quota_exceeded', limit: 'collections', resets_at: null })
    expect(refused.body.message).toContain(SUPPORT)
  })

  it('LIM-02 every other limit refuses with its own message', async () => {
    const id = await h.collection(PEOPLE.maya)
    const expectQuota = (response: { status: number; body: Record<string, unknown> }, limit: string, monthly: boolean) => {
      expect(response.status).toBe(429)
      expect(response.body).toMatchObject({ error: 'quota_exceeded', limit, resets_at: monthly ? '2026-12-01T00:00:00Z' : null })
      expect(response.body.message).toContain(SUPPORT)
    }
    await override({ documents: 1 })
    await h.note(PEOPLE.maya, id, 'The first note fits.')
    expectQuota(await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'The second does not.' }), 'documents', false)
    await override({ storage_bytes: 100 })
    expectQuota(await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'x'.repeat(200) }), 'storage_bytes', false)
    await override({ learned_month: 1 })
    // At documents learned a month, new documents wait for the 1st instead of being refused (design section 12).
    const waits = await h.json<{ import: { state: string }; waiting: { until: string; message: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { text: 'A second document this month.' })
    expect(waits.status).toBe(202)
    expect(waits.body).toMatchObject({ import: { state: 'waiting' }, waiting: { until: '2026-12-01T00:00:00Z' } })
    expect(waits.body.waiting.message).toContain(SUPPORT)
    await override({ file_bytes: 1000 })
    const preflight = await h.json<{ files: { accepted: boolean; reason?: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'Big.pdf', bytes: 5000 }] })
    expect(preflight.body.files[0]).toMatchObject({ accepted: false })
    expect(preflight.body.files[0]!.reason).toMatch(/largest file your organization can add is 1000 bytes/)
    // Must catch: the largest-file reason, the only limit message without support (BUG-4); an export's too.
    expect(preflight.body.files[0]!.reason).toContain(`contact Insulin Apps support at ${SUPPORT}`)
    const empty = await h.collection(PEOPLE.maya, 'Restored')
    const exported = await h.json<{ files: { accepted: boolean; reason?: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${empty}/preflight`, { files: [{ name: 'Export.zip', bytes: 5000 }], export: true })
    expect(exported.body.files[0]).toMatchObject({ accepted: false, reason: expect.stringContaining(`contact Insulin Apps support at ${SUPPORT}`) })
    await override({ questions_month: 1 })
    expect((await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'first note' })).status).toBe(200)
    expectQuota(await h.json(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'first note' }), 'questions_month', true)
    await override({ answers_month: 0 })
    const sources = await h.json<Record<string, unknown>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Which note fits?' })
    expect(sources.status).toBe(200)
    expect(sources.body).toMatchObject({ outcome: 'sources_only', text: null })
    expect(sources.body.message).toMatch(/written answers are used up/)
    // Must catch: "written answers are used up" without support (BUG-4).
    expect(sources.body.message).toContain(`contact Insulin Apps support at ${SUPPORT}`)
  })

  it('LIM-01 the awake-hours stop the engine answers names support too, or Insulin Apps support without an address', () => {
    const held = [{ collectionId: 'c1', name: 'Partner Programs', status: 'held', retryAfterSeconds: null, covered: false, passages: [], facts: [] }] as CollectionResult[]
    expect(waitingMessage({ SUPPORT_EMAIL: SUPPORT }, held)).toMatch(new RegExp(`stopped until the 1st.*contact Insulin Apps support at ${SUPPORT.replace('.', '\\.')}\\.$`))
    expect(waitingMessage({}, held)).toMatch(/contact Insulin Apps support\.$/)
  })

  it('LIM-03 two imports at the same moment never pass the same last unit', async () => {
    const first = await h.collection(PEOPLE.maya, 'First')
    const second = await h.collection(PEOPLE.eli, 'Second')
    await override({ documents: 1 })
    const [a, b] = await Promise.all([
      h.call(PEOPLE.maya, 'POST', `/api/collections/${first}/notes`, { text: 'One note.' }),
      h.call(PEOPLE.eli, 'POST', `/api/collections/${second}/notes`, { text: 'Another note.' }),
    ])
    // Must catch: the total never exceeds the limit.
    expect([a.status, b.status].sort()).toEqual([202, 429])
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await h.db.prepare(`SELECT SUM(documents) AS n FROM collections WHERE org_id = ?`).bind(ORG).first('n')).toBe(1)
  })

  it('LIM-03 concurrent reservations stop exactly at the limit', async () => {
    await override({ questions_month: 5 })
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => reserve(h.env, ORG, [{ key: 'questions_month', amount: 1 }], `q${index}`, h.clock.now)))
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE org_id = ? AND state = 'held'`).bind(ORG).first('n')).toBe(5)
  })

  it('LIM-07 "Ask for more" mails the support address from configuration, with the organization\'s usage', async () => {
    const sent = await h.call(PEOPLE.dana, 'POST', '/api/rules/ask-for-more', { limit: 'questions_month', note: 'Our sales team asks a lot.' })
    expect(sent.status).toBe(202)
    const mail = h.gateway.mail.find((message) => /higher limits/.test(message.subject))!
    // Must catch: the address comes from configuration.
    expect(mail.to).toBe(SUPPORT)
    expect(mail.text).toMatch(/Questions a month \(asked for\): 0 of 5000/)
    h.env.SUPPORT_EMAIL = undefined
    expect((await h.json<{ error: string }>(PEOPLE.dana, 'POST', '/api/rules/ask-for-more', {})).body.error).toBe('not_configured')
    expect((await h.call(PEOPLE.maya, 'POST', '/api/rules/ask-for-more', {})).status).toBe(403)
  })

  it('LIM-08 without the console the catalog\'s defaults apply, and stored limits stay on any non-200', async () => {
    h.gateway.limits = { status: 503, pages: [] }
    await h.tick()
    // Must catch: the defaults apply.
    for (const limit of LIMITS) expect(await effectiveLimit(h.db as unknown as D1Database, ORG, limit.key, h.clock.now)).toBe(limit.default)
    await override({ collections: 3, questions_month: null })
    expect(await effectiveLimit(h.db as unknown as D1Database, ORG, 'collections', h.clock.now)).toBe(3)
    expect(await effectiveLimit(h.db as unknown as D1Database, ORG, 'questions_month', h.clock.now)).toBeNull()
    h.gateway.limits.status = 404
    await h.tick()
    expect(await effectiveLimit(h.db as unknown as D1Database, ORG, 'collections', h.clock.now)).toBe(3)
  })

  it('LIM-10 keep-ready follows the organization\'s time zone; a second collection and a 4-hour window are refused; an organization owner turns it off', async () => {
    expect((await h.call(PEOPLE.dana, 'PUT', '/api/rules', { timeZone: 'Europe/Berlin' })).status).toBe(200)
    const first = await h.collection(PEOPLE.maya, 'First')
    const second = await h.collection(PEOPLE.maya, 'Second')
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${first}`, { keepReady: { days: [1, 2, 3, 4, 5], start: '09:00', hours: 4 } })).status).toBe(400)
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${first}`, { keepReady: { days: [1, 2, 3, 4, 5], start: '09:00', hours: 2 } })).status).toBe(200)
    const status = await h.json<{ engine: { settings: { keepReady: Record<string, unknown> } } }>(PEOPLE.maya, 'GET', `/api/collections/${first}`)
    expect(status.body.engine.settings.keepReady).toEqual({ timeZone: 'Europe/Berlin', days: [1, 2, 3, 4, 5], start: '09:00', hours: 2, paused: false })
    const refused = await h.json<Record<string, unknown>>(PEOPLE.maya, 'PATCH', `/api/collections/${second}`, { keepReady: { days: [1], start: '10:00', hours: 1 } })
    // Must catch: the second collection's refusal.
    expect(refused.status).toBe(429)
    expect(refused.body).toMatchObject({ error: 'quota_exceeded', limit: 'ready_collections' })
    // The organization owner has no role in it, and turns keep-ready off all the same; nothing else.
    expect((await h.call(PEOPLE.dana, 'GET', `/api/collections/${first}`)).status).toBe(403)
    expect((await h.call(PEOPLE.dana, 'PATCH', `/api/collections/${first}`, { keepReady: null, name: 'Renamed' })).status).toBe(403)
    expect((await h.call(PEOPLE.dana, 'PATCH', `/api/collections/${first}`, { keepReady: null })).status).toBe(200)
    expect((await h.call(PEOPLE.maya, 'PATCH', `/api/collections/${second}`, { keepReady: { days: [1], start: '10:00', hours: 1 } })).status).toBe(200)
  })
})

describe('limits from the operator console', () => {
  it('pages through overrides with the cursor, keeps defaults, and falls back when an override ends', async () => {
    h.gateway.limits = {
      status: 200,
      pages: [
        { defaults: { questions_month: 4000, collections: 20 }, organizations: [{ id: ORG, limits: { questions_month: { value: 10, until: '2026-11-20T00:00:00Z' } } }] },
        { defaults: { questions_month: 4000 }, organizations: [{ id: 'org-other', limits: { documents: { value: null, until: null } } }] },
      ],
    }
    await h.tick()
    expect(h.gateway.limitCalls).toEqual([null, '1'])
    const db = h.db as unknown as D1Database
    expect(await effectiveLimit(db, ORG, 'questions_month', h.clock.now)).toBe(10)
    expect(await effectiveLimit(db, 'org-other', 'documents', h.clock.now)).toBeNull()
    expect(await effectiveLimit(db, 'org-other', 'questions_month', h.clock.now)).toBe(4000)
    h.clock.now = Date.UTC(2026, 10, 21)
    expect(await effectiveLimit(db, ORG, 'questions_month', h.clock.now)).toBe(4000)
    // An organization listed with {} has its overrides cleared.
    h.gateway.limits.pages.push({ defaults: {}, organizations: [{ id: 'org-other', limits: {} }] })
    await h.tick()
    expect(h.gateway.limitCalls.at(-1)).toBe('2')
    expect(await effectiveLimit(db, 'org-other', 'documents', h.clock.now)).toBe(500)
  })

  it('the catalog in package.json is the one the app enforces', () => {
    expect(packageJson.insulin.limits).toEqual(LIMITS)
  })
})

describe('the hourly usage report', () => {
  it('reports exactly the limit keys that measure use plus database_bytes, once an hour, again after a refusal', async () => {
    h.gateway.metricsStatus = 500
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent.')
    await h.call(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts' })
    h.engine.control.addUsage(ORG, id, 'awake', 1800)
    // The question kept it awake for ten minutes; it sleeps, and the engine's ledger reports those too.
    h.clock.advance(11 * 60_000)
    expect((await h.tick()).usageReport).toBe('failed')
    h.gateway.metricsStatus = 202
    h.gateway.reports = []
    expect((await h.tick()).usageReport).toBe('sent')
    expect((await h.tick()).usageReport).toBe('not_due')
    const [report] = h.gateway.reports
    const body = report!.body as { hour: string; app: Record<string, number>; organizations: { id: string; metrics: Record<string, number> }[] }
    expect(body.hour).toBe('2026-11-16T09:00:00Z')
    expect(Object.keys(body.app).every((key) => key === 'database_bytes')).toBe(true)
    expect(body.organizations).toEqual([{ id: ORG, metrics: expect.any(Object) }])
    const metrics = body.organizations[0]!.metrics
    // Exactly the limit keys that measure use: no names, no text.
    expect(Object.keys(metrics)).toEqual([...ORGANIZATION_METRICS])
    expect(ORGANIZATION_METRICS.every((key) => packageJson.insulin.limits.some((limit) => limit.key === key))).toBe(true)
    expect(metrics).toMatchObject({ collections: 1, documents: 1, learned_month: 1, questions_month: 1, awake_hours_month: 0.67, ready_collections: 0 })
    expect(JSON.stringify(body)).not.toMatch(/Partner|Maya|discount/)
    // The month counters drop to 0 on the 1st.
    h.clock.now = Date.UTC(2026, 11, 1, 0, 1)
    h.gateway.reports = []
    await h.tick()
    expect((h.gateway.reports[0]!.body as typeof body).organizations[0]!.metrics).toMatchObject({ learned_month: 0, questions_month: 0, awake_hours_month: 0, documents: 1 })
  })
})
