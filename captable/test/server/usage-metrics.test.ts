import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { createApp } from '../../src/app/server/app.ts'
import { gatewayFetchOf } from '../../src/app/server/gateway-fetch.ts'
import {
  hourOf, measureUsage, ORGANIZATION_METRICS, reportBodies, reportUsage, type MetricsEnv,
} from '../../src/app/server/lib/usage-metrics.ts'
import type { LocalD1 } from '../../src/local-d1.ts'
import { appendCommand, documentStatement, issuance, seedCompany, sha } from '../db/fixtures.ts'
import { openMigratedDatabase } from '../db/helpers.ts'
import { appRequest, consoleHeaders, createTestDatabase, jsonRequest } from '../support/server-harness.ts'

// The hourly usage report (src/app/server/lib/usage-metrics.ts) and the platform's tick that sends it
// (POST /api/scheduled): aggregate counts per organization from the database, split for the platform, claimed once per
// hour, released on a failure, and nothing at all without the platform's address and token.

const METRICS_URL = 'https://insulinapps.example.test/__insulin/metrics'
const TOKEN = 'synthetic-app-token'
/** 2026-11-13 10:07:30.123 UTC: the report is for 10:00. */
const NOW = Date.UTC(2026, 10, 13, 10, 7, 30, 123)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

interface Sent { url: string; init: RequestInit; body: { hour: string; app?: Record<string, number>; organizations: { id: string; metrics: Record<string, number> }[] } }

/** The platform's metrics endpoint: answers each request with the next status (202 once they run out). */
function platform(statuses: number[] = []) {
  const sent: Sent[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init: init!, body: JSON.parse(String(init!.body)) })
    const status = statuses.shift() ?? 202
    return new Response(JSON.stringify(status === 202 ? { status: 'accepted' } : { error: 'rate_limited' }), { status })
  }) as typeof globalThis.fetch
  const env: MetricsEnv = { SUGER_METRICS_URL: METRICS_URL, SUGER_APP_TOKEN: TOKEN, METRICS_FETCH: fetch }
  return { sent, env }
}

const company = (db: LocalD1, id: string, organization: string | null, key: string, status: string) =>
  db.prepare(
    `INSERT INTO orgs (id, console_organization_id, org_key, slug, status, legal_name, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Bluefin Labs, Inc.', 'Bluefin Labs', ?, ?)`,
  ).bind(id, organization, key, key, status, NOW, NOW)
const stakeholder = (db: LocalD1, id: string, orgId: string) =>
  db.prepare(
    `INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, created_at, updated_at)
     VALUES (?, ?, 'individual', 'Robin Example', 'employee', ?, ?)`,
  ).bind(id, orgId, NOW, NOW)
const documentRow = (db: LocalD1, id: string, orgId: string, bytes: number) =>
  db.prepare(
    `INSERT INTO documents (id, org_id, filename, content_type, byte_size, sha256, kind, source, created_at, updated_at)
     VALUES (?, ?, 'board-consent.pdf', 'application/pdf', ?, ?, 'BOARD_CONSENT', 'upload', ?, ?)`,
  ).bind(id, orgId, bytes, sha(id), NOW, NOW)

/**
 * Acme Robotics (console-org-1): a common class, Freya with one issued lot, and a 1,024-byte board consent. Bluefin Labs
 * (console-org-2): its active company and the archived one an import replaced, three stakeholders and two documents
 * between them. And a company from before organizations, which belongs to nobody.
 */
async function seedOrganizations(db: LocalD1): Promise<void> {
  await seedCompany(db)
  await appendCommand(db, issuance(1))
  await db.batch([
    documentStatement(db),
    company(db, 'org_bluefin', 'console-org-2', 'bluefin', 'active'),
    company(db, 'org_bluefin_old', 'console-org-2', 'bluefin-old', 'archived'),
    company(db, 'org_legacy', null, 'legacy', 'active'),
    stakeholder(db, 'sh_bluefin_1', 'org_bluefin'),
    stakeholder(db, 'sh_bluefin_2', 'org_bluefin'),
    stakeholder(db, 'sh_bluefin_old', 'org_bluefin_old'),
    stakeholder(db, 'sh_legacy', 'org_legacy'),
    documentRow(db, 'doc_bluefin', 'org_bluefin', 2048),
    documentRow(db, 'doc_bluefin_old', 'org_bluefin_old', 4096),
    documentRow(db, 'doc_legacy', 'org_legacy', 999),
  ])
}

const metrics = (values: Partial<Record<string, number>>) =>
  Object.fromEntries(ORGANIZATION_METRICS.map((metric) => [metric, values[metric] ?? 0]))

const claims = (db: LocalD1) =>
  db.prepare('SELECT hour, started_at, sent_at FROM metrics_reports ORDER BY hour').all<{ hour: number; started_at: number; sent_at: number | null }>()
    .then((result) => result.results)

let db: LocalD1
beforeEach(async () => { db = await openMigratedDatabase() })
afterEach(() => { db.close(); vi.restoreAllMocks() })

describe('the usage report', () => {
  it('counts each organization\'s records and document bytes, and nothing else', async () => {
    await seedOrganizations(db)
    const { sent, env } = platform()
    expect(await reportUsage(db, env, NOW)).toBe('sent')
    expect(sent).toHaveLength(1)
    const [request] = sent
    expect(request!.url).toBe(METRICS_URL)
    expect(request!.init).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      redirect: 'manual',
    })
    const { app, ...rest } = request!.body
    expect(rest).toEqual({
      hour: '2026-11-13T10:00:00Z',
      organizations: [
        { id: 'console-org-1', metrics: metrics({ companies: 1, stakeholders: 1, share_classes: 1, securities: 1, transactions: 1, documents: 1, storage_bytes: 1024 }) },
        // The archived company's records are stored too; the company from before organizations counts nowhere.
        { id: 'console-org-2', metrics: metrics({ companies: 1, stakeholders: 3, documents: 2, storage_bytes: 6144 }) },
      ],
    })
    expect(app).toEqual({ organizations: 2, database_bytes: expect.any(Number) })
    expect(app!.database_bytes).toBeGreaterThan(0)
    // Counts and byte sizes only: no name, address or amount from the database reaches the platform.
    expect(JSON.stringify(request!.body)).not.toMatch(/Acme|Bluefin|Freya|Robin|example\.test|board-consent/)
    for (const organization of request!.body.organizations) {
      expect(Object.keys(organization.metrics).length).toBeLessThanOrEqual(20)
      for (const [name, value] of Object.entries(organization.metrics)) {
        expect(name).toMatch(/^[a-z][a-z0-9_]{0,39}$/)
        expect(Number.isFinite(value) && value >= 0).toBe(true)
      }
    }
    expect(await claims(db)).toEqual([{ hour: hourOf(NOW), started_at: NOW, sent_at: NOW }])
  })

  it('sends one request with no organizations before any company exists', async () => {
    const { sent, env } = platform()
    expect(await reportUsage(db, env, NOW)).toBe('sent')
    expect(sent.map((request) => request.body)).toEqual([
      { hour: '2026-11-13T10:00:00Z', app: { organizations: 0, database_bytes: expect.any(Number) }, organizations: [] },
    ])
  })

  it('splits more than 500 organizations into requests for the same hour, with the app\'s numbers in the first', async () => {
    const companies = Array.from({ length: 1001 }, (_, index) => {
      const n = String(index + 1).padStart(4, '0')
      return company(db, `org_${n}`, `console-org-${n}`, `co-${n}`, 'active')
    })
    await db.batch(companies)
    const { sent, env } = platform()
    expect(await reportUsage(db, env, NOW)).toBe('sent')
    expect(sent.map((request) => request.body.organizations.length)).toEqual([500, 500, 1])
    expect(sent.map((request) => request.body.hour)).toEqual(Array(3).fill('2026-11-13T10:00:00Z'))
    expect(sent.map((request) => request.body.app?.organizations)).toEqual([1001, undefined, undefined])
    const ids = sent.flatMap((request) => request.body.organizations.map((organization) => organization.id))
    expect(new Set(ids).size).toBe(1001)
    for (const request of sent) expect(new TextEncoder().encode(String(request.init.body)).length).toBeLessThan(512 * 1024)
  })

  it('leaves the database size out when D1 gives none', () => {
    const [body] = reportBodies({ hour: hourOf(NOW), databaseBytes: null, organizations: [] })
    expect(body).toEqual({ hour: '2026-11-13T10:00:00Z', app: { organizations: 0 }, organizations: [] })
  })

  it('measures with one query per table, whatever the number of organizations', async () => {
    await seedOrganizations(db)
    const batch = vi.spyOn(db, 'batch')
    const report = await measureUsage(db, hourOf(NOW), null)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toHaveLength(9)
    expect(report.organizations.map((organization) => organization.id)).toEqual(['console-org-1', 'console-org-2'])
  })
})

describe('once an hour', () => {
  it('claims the hour once: later ticks of the same hour send nothing, and the next hour sends again', async () => {
    await seedOrganizations(db)
    const { sent, env } = platform()
    expect(await reportUsage(db, env, NOW)).toBe('sent')
    expect(await reportUsage(db, env, NOW + 5 * MINUTE)).toBe('already_claimed')
    expect(await reportUsage(db, env, NOW + 45 * MINUTE)).toBe('already_claimed')
    expect(sent).toHaveLength(1)
    expect(await reportUsage(db, env, NOW + HOUR)).toBe('sent')
    expect(sent.map((request) => request.body.hour)).toEqual(['2026-11-13T10:00:00Z', '2026-11-13T11:00:00Z'])
  })

  it('lets only one of two overlapping ticks send', async () => {
    const { sent, env } = platform()
    let answer!: () => void
    const slow = env.METRICS_FETCH!
    env.METRICS_FETCH = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((resolve) => { answer = resolve })
      return slow(input, init)
    }) as typeof fetch
    const first = reportUsage(db, env, NOW)
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    expect(await reportUsage(db, env, NOW + 2_000)).toBe('already_claimed')
    answer()
    expect(await first).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('releases the claim when the platform refuses, and the next tick retries', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedOrganizations(db)
    const { sent, env } = platform([503])
    expect(await reportUsage(db, env, NOW)).toBe('failed')
    expect(await claims(db)).toEqual([])
    expect(errors).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toMatchObject({ event: 'usage_report_failed', hour: '2026-11-13T10:00:00.000Z', status: 503 })
    expect(String(errors.mock.calls[0]![0])).not.toContain(TOKEN)
    expect(await reportUsage(db, env, NOW + 5 * MINUTE)).toBe('sent')
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body).toEqual(sent[0]!.body)
    expect(await claims(db)).toEqual([{ hour: hourOf(NOW), started_at: NOW + 5 * MINUTE, sent_at: NOW + 5 * MINUTE }])
  })

  it('counts the hour sent only when every request was accepted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.batch(Array.from({ length: 501 }, (_, index) => company(db, `org_${index}`, `console-org-${index}`, `co-${index}`, 'active')))
    const { sent, env } = platform([202, 429])
    expect(await reportUsage(db, env, NOW)).toBe('failed')
    expect(sent).toHaveLength(2)
    expect(await claims(db)).toEqual([])
    expect(await reportUsage(db, env, NOW + 5 * MINUTE)).toBe('sent')
    expect(sent).toHaveLength(4)
  })

  it('releases the claim when the platform can\'t be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env: MetricsEnv = { ...platform().env, METRICS_FETCH: (async () => { throw new TypeError('network down') }) as typeof fetch }
    expect(await reportUsage(db, env, NOW)).toBe('failed')
    expect(await claims(db)).toEqual([])
  })

  it('gives the platform fifteen seconds for the whole report, then releases the claim for the next tick', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedOrganizations(db)
    // A gateway that never answers: only the report's own deadline ends the wait, well inside the tick's 25 seconds.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('The report took too long', 'TimeoutError')))
    const signals: (AbortSignal | null | undefined)[] = []
    const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason)
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }) as typeof fetch
    expect(await reportUsage(db, { ...platform().env, METRICS_FETCH: stalled }, NOW)).toBe('failed')
    expect(timeout).toHaveBeenCalledWith(15_000)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(await claims(db)).toEqual([])
  })

  it('retakes an unsent claim only once its tick must have died, and never a sent hour', async () => {
    const { sent, env } = platform()
    const hour = hourOf(NOW)
    await db.prepare('INSERT INTO metrics_reports (hour, started_at) VALUES (?, ?)').bind(hour, NOW - 5 * MINUTE).run()
    expect(await reportUsage(db, env, NOW)).toBe('already_claimed')
    expect(await reportUsage(db, env, NOW + 6 * MINUTE)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(await claims(db)).toEqual([{ hour, started_at: NOW + 6 * MINUTE, sent_at: NOW + 6 * MINUTE }])
    expect(await reportUsage(db, env, NOW + 40 * MINUTE)).toBe('already_claimed')
    expect(sent).toHaveLength(1)
  })

  it('keeps a few days of hours', async () => {
    const { env } = platform()
    const hour = hourOf(NOW)
    await db.batch([
      db.prepare('INSERT INTO metrics_reports (hour, started_at, sent_at) VALUES (?, ?, ?)').bind(hour - 96 * HOUR, 1, 1),
      db.prepare('INSERT INTO metrics_reports (hour, started_at) VALUES (?, ?)').bind(hour - 80 * HOUR, 1),
      db.prepare('INSERT INTO metrics_reports (hour, started_at, sent_at) VALUES (?, ?, ?)').bind(hour - 48 * HOUR, 1, 1),
    ])
    expect(await reportUsage(db, env, NOW)).toBe('sent')
    expect((await claims(db)).map((row) => row.hour)).toEqual([hour - 48 * HOUR, hour])
  })

  it('reports nothing without the platform\'s address and token, or with an address that isn\'t https', async () => {
    await seedOrganizations(db)
    const { sent, env } = platform()
    for (const missing of [
      { ...env, SUGER_METRICS_URL: undefined },
      { ...env, SUGER_APP_TOKEN: undefined },
      { ...env, SUGER_APP_TOKEN: '  ' },
      { ...env, SUGER_METRICS_URL: 'http://insulinapps.example.test/__insulin/metrics' },
      { ...env, SUGER_METRICS_URL: 'not a url' },
    ]) {
      expect(await reportUsage(db, missing, NOW)).toBe('not_configured')
    }
    expect(sent).toHaveLength(0)
    expect(await claims(db)).toEqual([])
    // The local stack's gateway is plain http on loopback.
    expect(await reportUsage(db, { ...env, SUGER_METRICS_URL: 'http://insulinapps.localhost/__insulin/metrics' }, NOW)).toBe('sent')
  })
})

describe('the platform\'s tick, POST /api/scheduled', () => {
  const app = createApp({ now: () => NOW, enforceSameOrigin: true })
  const TICK = { 'x-suger-app-id': 'captable', 'x-suger-access-via': 'schedule' }
  const tick = (headers: Record<string, string>, env: MetricsEnv) =>
    app.fetch(new Request('https://captable.example.test/api/scheduled', { method: 'POST', headers }), { DB: db, ...env })

  it('sends the hour\'s report for the tick alone, with no Origin and no identity', async () => {
    await seedOrganizations(db)
    const { sent, env } = platform()
    const response = await tick(TICK, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ metrics: 'sent' })
    expect(sent).toHaveLength(1)
    const again = await tick(TICK, env)
    expect(await again.json()).toEqual({ metrics: 'already_claimed' })
    expect(sent).toHaveLength(1)
  })

  it('answers without reporting where the platform takes no reports', async () => {
    const response = await tick(TICK, {})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ metrics: 'not_configured' })
  })

  it('refuses a request without x-suger-access-via: schedule, or with any identity', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    try {
      const { sent, env } = platform()
      const refused: [string, Record<string, string>][] = [
        ['no access-via', { 'x-suger-app-id': 'captable' }],
        ['the browser', { ...TICK, 'x-suger-access-via': 'browser' }],
        ['an API client', { ...TICK, 'x-suger-access-via': 'api' }],
        ['another spelling', { ...TICK, 'x-suger-access-via': 'Schedule' }],
        ['a member marked schedule', { ...consoleHeaders(), 'x-suger-access-via': 'schedule' }],
        ...['x-suger-user-id', 'x-suger-organization-id', 'x-suger-app-role', 'x-suger-app-permissions', 'x-suger-user-email', 'x-suger-user-name']
          .map((name): [string, Record<string, string>] => [name, { ...TICK, [name]: name === 'x-suger-app-role' ? 'ADMIN' : 'synthetic' }]),
      ]
      for (const [label, headers] of refused) {
        const response = await tick(headers, env)
        expect(response.status, label).toBe(403)
        expect(await response.json(), label).toMatchObject({ error: { code: 'forbidden' } })
      }
      expect(sent).toHaveLength(0)
      expect(await claims(db)).toEqual([])
    } finally {
      delete process.env.SUGER_ACCESS_MODE
    }
  })
})

describe('a request marked schedule elsewhere', () => {
  it('is nobody on every other route, a member\'s identity or the preview\'s stand-in notwithstanding', async () => {
    const test = await createTestDatabase()
    try {
      // The preview (no console identity): the stand-in owner, unless the request is marked schedule.
      expect((await appRequest('/api/me', {}, {})).status).toBe(200)
      expect((await appRequest('/api/me', {}, { 'x-suger-access-via': 'schedule' })).status).toBe(401)
      process.env.SUGER_ACCESS_MODE = 'console'
      expect((await appRequest('/api/me', {}, consoleHeaders())).status).toBe(200)
      expect((await appRequest('/api/me', {}, consoleHeaders({ via: 'schedule' }))).status).toBe(401)
      expect((await appRequest('/api/catalog', {}, consoleHeaders({ via: 'schedule' }))).status).toBe(401)
    } finally {
      delete process.env.SUGER_ACCESS_MODE
      await test.close()
    }
  })

  it('never lists the tick in the API catalog', async () => {
    const test = await createTestDatabase()
    process.env.SUGER_ACCESS_MODE = 'console'
    try {
      const listed = async () => api.apiCatalogSchema.parse(await (await appRequest('/api/catalog')).json()).endpoints.map((endpoint) => endpoint.path)
      expect(await listed()).not.toContain('/api/scheduled')
      const setup = await jsonRequest('/api/orgs', 'POST', { orgKey: 'acme', legalName: 'Acme Example, Inc.', displayName: 'Acme Example', timezone: 'UTC' })
      expect(setup.status).toBe(201)
      const endpoints = await listed()
      expect(endpoints.length).toBeGreaterThan(10)
      expect(endpoints).not.toContain('/api/scheduled')
      expect(endpoints).toContain('/api/orgs/{orgId}/process-due')
    } finally {
      delete process.env.SUGER_ACCESS_MODE
      await test.close()
    }
  })
})

describe('the gateway binding', () => {
  it('sends through the SUGER_GATEWAY service binding Nitro puts on the request, bound to it, and is absent without one', async () => {
    const binding = {
      seen: [] as string[],
      async fetch(this: { seen: string[] }, input: RequestInfo | URL) { this.seen.push(String(input)); return new Response(null, { status: 202 }) },
    }
    const request = Object.assign(new Request('https://captable.example.test/api/scheduled', { method: 'POST' }), {
      runtime: { cloudflare: { env: { SUGER_GATEWAY: binding } } },
    })
    const send = gatewayFetchOf(request)!
    expect((await send(METRICS_URL, { method: 'POST' })).status).toBe(202)
    expect(binding.seen).toEqual([METRICS_URL])
    expect(gatewayFetchOf(new Request('https://captable.example.test/api/scheduled'))).toBeUndefined()
    expect(gatewayFetchOf(Object.assign(new Request('https://captable.example.test/'), { runtime: { cloudflare: { env: {} } } }))).toBeUndefined()
  })
})
