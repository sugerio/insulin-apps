import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { holderIdentity, readHarness, type ReadHarness } from '../support/read-helpers.ts'
import { consoleHeaders } from '../support/server-harness.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

function pathFor(route: api.AnyRoute, orgId: string): string {
  const values: Record<string, string> = {
    orgId,
    id: '00000000-0000-4000-8000-000000000002',
    emailId: '00000000-0000-4000-8000-000000000003',
    eventId: '00000000-0000-4000-8000-000000000004',
    reportKey: 'cap-table',
  }
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => values[name] ?? `synthetic-${name}`)
}

describe('authorization matrix over the pruned route table', () => {
  it('requires a console identity for every contract route', async () => {
    harness = await readHarness()
    for (const route of api.ROUTE_TABLE) {
      const response = await harness.api(route.method, pathFor(route, harness.orgId), {}, route.method === 'GET' ? undefined : {})
      expect.soft(response.status, route.id).toBe(401)
    }
  }, 30_000)

  it('refuses every administrator write to EDITOR before parsing its body', async () => {
    harness = await readHarness()
    const writes = api.ROUTE_TABLE.filter((route) => route.auth === 'admin' && !route.access.includes('admin_ro') && route.method !== 'GET')
    expect(writes.length).toBeGreaterThan(0)
    for (const route of writes) {
      const response = await harness.api(route.method, pathFor(route, harness.orgId), harness.editor, {})
      expect.soft(response.status, route.id).toBe(403)
      expect.soft(await response.json(), route.id).toMatchObject({ error: { code: 'forbidden' } })
    }
  }, 30_000)

  it('keeps holder and administrator route families disjoint', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const holder = holderIdentity('holder@example.test')
    const adminRoute = api.routes.getDashboard
    const holderRoute = api.routes.getPortalOverview
    expect((await harness.api('GET', pathFor(adminRoute, harness.orgId), holder)).status).toBe(404)
    expect((await harness.api('GET', holderRoute.path, harness.owner)).status).toBe(404)
    expect((await harness.api('GET', holderRoute.path, holder)).status).toBe(200)
  })

  it('hides every company-id contract route from another console organization', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const foreign = consoleHeaders({
      organizationId: 'console-org-2', userId: 'foreign-owner', role: 'OWNER',
      email: 'foreign.owner@example.test', name: 'Foreign Owner',
    })
    const routes = api.ROUTE_TABLE.filter((route) => route.path.includes(':orgId'))
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      const response = await harness.api(
        route.method,
        pathFor(route, harness.orgId),
        foreign,
        route.method === 'GET' ? undefined : {},
      )
      expect.soft(response.status, route.id).toBe(404)
    }
  }, 30_000)
})
