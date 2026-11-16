import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/d1'
import { migrate } from 'drizzle-orm/d1/migrator'
import { createStubEngine, type StubEngine, type StubTiming } from '../../engine/src/stub/index.ts'
import { type LocalD1, openLocalD1 } from '../../src/local-d1.ts'
import { createApp } from '../../src/app/server/app.ts'
import type { Bindings } from '../../src/app/server/env.ts'

/** The app's Drizzle Kit migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../src/app/db/migrations', import.meta.url))

/** A fresh, empty, migrated database (in-memory SQLite behind the preview's D1 stand-in). */
export async function openMigratedDatabase(): Promise<LocalD1> {
  const database = await openLocalD1(':memory:')
  await migrate(drizzle(database), { migrationsFolder: MIGRATIONS_FOLDER })
  return database
}

export const ORG = 'org-acme'
export const OTHER_ORG = 'org-globex'
export const GATEWAY = 'https://insulinapps.test/__insulin'
export const SUPPORT = 'support@example.test'

export interface Person {
  id: string
  org?: string
  /** The role in Knowledge. */
  role: 'ADMIN' | 'EDITOR' | 'VIEWER'
  /** The organization role (x-suger-org-role). */
  orgRole?: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER' | 'APPS'
  via?: 'browser' | 'mcp' | 'api'
  /** x-suger-app-permissions, when the platform narrows the role (a custom role). */
  permissions?: string[]
  name?: string
  email?: string
}

/** The fictional people of design section 04, in the organization Acme Cloud, and one of another organization. */
export const PEOPLE = {
  dana: { id: 'u-dana', role: 'ADMIN', orgRole: 'OWNER', name: 'Dana Example', email: 'dana@example.test' },
  sam: { id: 'u-sam', role: 'ADMIN', orgRole: 'OWNER', name: 'Sam Example', email: 'sam@example.test' },
  ada: { id: 'u-ada', role: 'ADMIN', orgRole: 'ADMIN', name: 'Ada Example', email: 'ada@example.test' },
  apps: { id: 'u-apps', role: 'ADMIN', orgRole: 'APPS', name: 'Ari Apps', email: 'ari@example.test' },
  maya: { id: 'u-maya', role: 'EDITOR', orgRole: 'EDITOR', name: 'Maya Example', email: 'maya@example.test' },
  eli: { id: 'u-eli', role: 'EDITOR', orgRole: 'EDITOR', name: 'Eli Example', email: 'eli@example.test' },
  leo: { id: 'u-leo', role: 'VIEWER', orgRole: 'VIEWER', name: 'Leo Example', email: 'leo@example.test' },
  outsider: { id: 'u-olga', org: OTHER_ORG, role: 'ADMIN', orgRole: 'OWNER', name: 'Olga Elsewhere', email: 'olga@example.test' },
  client: { id: 'sa-crm', role: 'EDITOR', via: 'api', name: 'CRM sync' },
} satisfies Record<string, Person>

export interface Mail {
  org: string
  to: string
  subject: string
  text: string
}

/** The platform's side of the conversation: mail, usage reports, limits and members, as data a test can change. */
export class FakeGateway {
  mail: Mail[] = []
  reports: { body: Record<string, unknown> }[] = []
  metricsStatus = 202
  limits: { status: number; pages: { defaults: Record<string, number | null>; organizations: { id: string; limits: Record<string, { value: number | null; until: string | null }> }[] }[] } = { status: 503, pages: [] }
  limitCalls: (string | null)[] = []
  /** Who can use Knowledge, per organization (member status and the lookup). */
  members = new Map<string, Map<string, { type: 'person' | 'client'; member: boolean; gone?: boolean; appRole: string | null; orgRole: string | null; name?: string; email?: string }>>()
  owners = new Map<string, { user: string; since: string }[]>()
  deletedOrgs = new Set<string>()
  events: Record<string, unknown>[] = []
  eventsExpired = false
  eventCalls: (string | null)[] = []

  setMember(org: string, id: string, entry: { type?: 'person' | 'client'; member?: boolean; appRole?: string | null; orgRole?: string | null; name?: string; email?: string }) {
    if (!this.members.has(org)) this.members.set(org, new Map())
    this.members.get(org)!.set(id, { type: entry.type ?? 'person', member: entry.member ?? true, appRole: entry.appRole ?? null, orgRole: entry.orgRole ?? null, name: entry.name, email: entry.email })
  }

  /** Every person of PEOPLE in their organization, as members who can use Knowledge. */
  seedPeople() {
    for (const person of Object.values(PEOPLE) as Person[]) {
      this.setMember(person.org ?? ORG, person.id, { type: person.via === 'api' ? 'client' : 'person', appRole: person.role, orgRole: person.orgRole ?? null, name: person.name, email: person.email })
    }
    this.owners.set(ORG, [{ user: PEOPLE.dana.id, since: '2024-01-01T00:00:00Z' }, { user: PEOPLE.sam.id, since: '2025-06-01T00:00:00Z' }])
  }

  addEvent(event: Record<string, unknown>) {
    this.events.push({ id: `ev${this.events.length + 1}`, at: new Date().toISOString(), ...event })
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== 'Bearer app-token') return Response.json({ error: 'unauthorized' }, { status: 401 })
    switch (url.pathname) {
      case '/__insulin/mail':
        this.mail.push({ org: headers.get('x-suger-organization-id') ?? '', to: String(body?.to), subject: String(body?.subject), text: String(body?.text) })
        return Response.json({ status: 'sent' }, { status: 202 })
      case '/__insulin/metrics':
        this.reports.push({ body: body ?? {} })
        return Response.json({ status: 'accepted' }, { status: this.metricsStatus })
      case '/__insulin/limits': {
        const since = url.searchParams.get('since')
        this.limitCalls.push(since)
        if (this.limits.status !== 200) return Response.json({ error: 'not_configured' }, { status: this.limits.status })
        const index = since ? Number(since) : 0
        const page = this.limits.pages[index] ?? { defaults: {}, organizations: [] }
        return Response.json({ ...page, cursor: String(Math.min(index + 1, this.limits.pages.length)), more: index + 1 < this.limits.pages.length })
      }
      case '/__insulin/members': {
        const lookup = headers.get('x-suger-member-lookup')
        if (!lookup) return Response.json({ error: 'unauthorized' }, { status: 401 })
        const org = lookup.split('.')[0] ?? ''
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        const found = [...(this.members.get(org)?.entries() ?? [])]
          .filter(([, entry]) => entry.member && entry.appRole && `${entry.name ?? ''} ${entry.email ?? ''}`.toLowerCase().includes(q))
          .slice(0, 20)
          .map(([id, entry]) => ({ id, type: entry.type, name: entry.name, email: entry.email, appRole: entry.appRole }))
        return Response.json({ members: found })
      }
      case '/__insulin/members/status': {
        const org = String(body?.org)
        if (this.deletedOrgs.has(org)) return Response.json({ error: 'org_deleted' }, { status: 404 })
        const ids = (body?.ids as string[]) ?? []
        const known = this.members.get(org) ?? new Map()
        // The gateway's shapes (src/members/endpoints.ts).
        return Response.json({
          org,
          owners: this.owners.get(org) ?? [],
          members: ids.map((id) => {
            const entry = known.get(id)
            if (!entry) return { id, type: null, status: 'gone' }
            if (!entry.member) return { id, type: entry.type, status: entry.type === 'client' ? 'revoked' : 'left' }
            return { id, type: entry.type, status: 'member', appRole: entry.appRole, ...(entry.type === 'person' ? { orgRole: entry.orgRole } : {}) }
          }),
        })
      }
      case '/__insulin/member-events': {
        const since = url.searchParams.get('since')
        this.eventCalls.push(since)
        if (since === null) return Response.json({ events: [], cursor: String(this.events.length), more: false })
        if (this.eventsExpired) return Response.json({ error: 'cursor_expired' }, { status: 410 })
        const from = Number(since)
        const page = this.events.slice(from, from + 1000)
        return Response.json({ events: page, cursor: String(from + page.length), more: from + page.length < this.events.length })
      }
      default:
        return Response.json({ error: 'not_found' }, { status: 404 })
    }
  }
}

export interface Harness {
  db: LocalD1
  engine: StubEngine
  gateway: FakeGateway
  env: Bindings
  /** The test clock (epoch ms); `advance` moves the app's and the engine's together. */
  clock: { now: number; advance(ms: number): void }
  call(person: Person, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  json<T = Record<string, unknown>>(person: Person, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>
  tick(): Promise<Record<string, unknown>>
  /** Creates a collection as `person` and returns its id. */
  collection(person: Person, name?: string, purpose?: string): Promise<string>
  /** Adds a note and lets the engine learn it. */
  note(person: Person, collectionId: string, text: string, title?: string): Promise<Record<string, unknown>>
  share(by: Person, collectionId: string, to: Person, role: 'VIEWER' | 'EDITOR' | 'ADMIN'): Promise<number>
  close(): void
}

let keys = 0
const key = () => `test-key-${Date.now()}-${(keys += 1)}`

export function headersOf(person: Person): Record<string, string> {
  const headers: Record<string, string> = {
    'x-suger-user-id': person.id,
    'x-suger-organization-id': person.org ?? ORG,
    'x-suger-app-id': 'insulin-apps-knowledge',
    'x-suger-app-role': person.role,
    'x-suger-access-via': person.via ?? 'browser',
  }
  if (person.name) headers['x-suger-user-name'] = encodeURIComponent(person.name)
  if (person.email) headers['x-suger-user-email'] = encodeURIComponent(person.email)
  if (person.permissions) headers['x-suger-app-permissions'] = person.permissions.join(' ')
  if (person.orgRole && person.via !== 'api') headers['x-suger-org-role'] = person.orgRole
  if ((person.via ?? 'browser') === 'browser') headers['x-suger-member-lookup'] = `${person.org ?? ORG}.${person.id}.signed`
  return headers
}

export async function createHarness(options: { timing?: Partial<StubTiming>; env?: Partial<Bindings>; gateway?: boolean } = {}): Promise<Harness> {
  const db = await openMigratedDatabase()
  const clock = { now: Date.UTC(2026, 10, 16, 9, 0, 0), advance(ms: number) { this.now += ms } }
  const engine = createStubEngine({ now: () => clock.now, timing: options.timing })
  const gateway = new FakeGateway()
  gateway.seedPeople()
  const withGateway = options.gateway ?? true
  const env: Bindings = {
    DB: db as unknown as D1Database,
    ENGINE: engine,
    GATEWAY_FETCH: gateway.fetch,
    TRUST_ORG_ROLE: true,
    SUPPORT_EMAIL: SUPPORT,
    NOW: () => clock.now,
    ...(withGateway ? {
      SUGER_APP_TOKEN: 'app-token',
      SUGER_MAIL_URL: `${GATEWAY}/mail`,
      SUGER_METRICS_URL: `${GATEWAY}/metrics`,
      SUGER_LIMITS_URL: `${GATEWAY}/limits`,
      SUGER_MEMBERS_URL: `${GATEWAY}/members`,
      SUGER_MEMBER_STATUS_URL: `${GATEWAY}/members/status`,
      SUGER_MEMBER_EVENTS_URL: `${GATEWAY}/member-events`,
    } : {}),
    ...options.env,
  }
  const app = createApp({ enforceSameOrigin: false })
  const call = async (person: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const all: Record<string, string> = { ...headersOf(person), ...headers }
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array) payload = body as Uint8Array<ArrayBuffer>
    else if (body !== undefined) {
      payload = JSON.stringify(body)
      all['content-type'] = 'application/json'
    }
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE' && method !== 'PATCH' && !('idempotency-key' in all) && !('Idempotency-Key' in all)) all['idempotency-key'] = key()
    return app.fetch(new Request(`https://knowledge.insulinapps.test${path}`, { method, headers: all, body: payload }), env)
  }
  const harness: Harness = {
    db,
    engine,
    gateway,
    env,
    clock,
    call,
    async json<T>(person: Person, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
      const response = await call(person, method, path, body, headers)
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as T }
    },
    async tick() {
      const response = await app.fetch(new Request('https://knowledge.insulinapps.test/api/scheduled', { method: 'POST', headers: { 'x-suger-app-id': 'insulin-apps-knowledge', 'x-suger-access-via': 'schedule' } }), env)
      if (response.status !== 200) throw new Error(`tick answered ${response.status}`)
      return (await response.json()) as Record<string, unknown>
    },
    async collection(person, name = 'Partner Programs', purpose = 'What the partner team knows') {
      const { status, body } = await harness.json<{ collection: { id: string } }>(person, 'POST', '/api/collections', { name, purpose })
      if (status !== 201) throw new Error(`creating a collection answered ${status}: ${JSON.stringify(body)}`)
      return body.collection.id
    },
    async note(person, collectionId, text, title = 'Note') {
      const { status, body } = await harness.json(person, 'POST', `/api/collections/${collectionId}/notes`, { title, text })
      if (status !== 202) throw new Error(`adding a note answered ${status}: ${JSON.stringify(body)}`)
      engine.control.runUntilIdle()
      await harness.tick()
      return body
    },
    async share(by, collectionId, to, role) {
      const type = to.via === 'api' ? 'client' : 'person'
      return (await call(by, 'PUT', `/api/collections/${collectionId}/sharing/${type}/${to.id}`, { role })).status
    },
    close() {
      db.close()
    },
  }
  // Everyone has been seen once, so Knowledge knows their names and addresses (as it does after their first visit).
  for (const person of Object.values(PEOPLE) as Person[]) await call(person, 'GET', '/api/me')
  return harness
}
