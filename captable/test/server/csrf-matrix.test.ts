import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { createApp } from '../../src/app/server/app.ts'
import {
  consoleHeaders, createLegacyTestDatabase, handleTestAppRequest, jsonRequest, type TestDatabase,
} from '../support/server-harness.ts'

let testDb: TestDatabase

function pathFor(route: api.AnyRoute): string {
  const values: Record<string, string> = {
    orgId: '00000000-0000-4000-8000-000000000001',
    id: '00000000-0000-4000-8000-000000000002',
    emailId: '00000000-0000-4000-8000-000000000003',
    eventId: '00000000-0000-4000-8000-000000000004',
    reportKey: 'cap-table',
  }
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => values[name] ?? `synthetic-${name}`)
}

function raw(path: string, method: string, headers: HeadersInit): Promise<Response> {
  const merged = new Headers(headers)
  for (const [name, value] of Object.entries(consoleHeaders())) merged.set(name, value)
  return handleTestAppRequest(new Request(`http://app.test${path}`, { method, headers: merged }))
}

beforeEach(async () => {
  process.env.SUGER_ACCESS_MODE = 'console'
  testDb = await createLegacyTestDatabase()
})

afterEach(async () => {
  await testDb.close()
  delete process.env.SUGER_ACCESS_MODE
})

describe('same-origin matrix', () => {
  it('does not apply the production origin policy on the Vite development server', async () => {
    expect(import.meta.env.DEV).toBe(true)
    const app = createApp()
    const request = (origin?: string) => {
      const headers = new Headers({
        ...consoleHeaders(),
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        'Sec-Fetch-Site': origin?.includes('preview') ? 'cross-site' : 'same-origin',
      })
      if (origin) headers.set('Origin', origin)
      return app.fetch(new Request('http://localhost:3000/api/orgs', {
        method: 'POST', headers, body: '{}',
      }), { DB: testDb.db })
    }

    for (const origin of ['https://runtime--3000.preview.example.test', undefined, 'http://localhost:3000']) {
      expect((await request(origin)).status, origin ?? 'no Origin').not.toBe(403)
    }
  })

  it('blocks every retained write route before authentication or body parsing', async () => {
    const routes = api.ROUTE_TABLE.filter((route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method))
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      for (const [label, headers] of [
        ['cross-site', { Origin: 'https://cross-site.test', 'Sec-Fetch-Site': 'cross-site' }],
        ['missing Origin', { 'Sec-Fetch-Site': 'same-origin' }],
        ['lying metadata', { Origin: 'http://app.test', 'Sec-Fetch-Site': 'cross-site' }],
      ] as const) {
        const response = await raw(pathFor(route), route.method, headers)
        expect.soft(response.status, `${route.id}: ${label}`).toBe(403)
        expect.soft(await response.json(), `${route.id}: ${label}`)
          .toMatchObject({ error: { code: 'forbidden', message: 'Cross-site request blocked' } })
      }
    }
  }, 30_000)

  it('accepts the app Origin without Fetch Metadata and applies no Origin check to safe methods', async () => {
    const setup = await jsonRequest('/api/orgs', 'POST', {
      orgKey: 'csrf', legalName: 'CSRF Example, Inc.', displayName: 'CSRF Example', timezone: 'UTC',
    })
    expect(setup.status).toBe(201)
    expect((await raw('/api/me', 'GET', { Origin: 'https://cross-site.test', 'Sec-Fetch-Site': 'cross-site' })).status)
      .toBe(200)
    const accepted = await raw('/api/orgs', 'POST', {
      Origin: 'http://app.test', 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(),
    })
    expect(accepted.status).not.toBe(403)
  })
})
