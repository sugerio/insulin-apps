import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { appRequest, consoleHeaders, createTestDatabase } from '../support/server-harness.ts'
import { getJson, holderIdentity, readHarness, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

const ALL = ['captable.manage', 'captable.view', 'portfolio.view']
const NEW_HOLDER = { kind: 'individual', displayName: 'Synthetic Holder', relationship: 'investor', emails: [] }

function custom(permissions: string, overrides: Parameters<typeof consoleHeaders>[0] = {}) {
  return consoleHeaders({ userId: 'custom-user', role: 'EDITOR', email: 'custom@example.test', name: 'Custom Example', permissions, ...overrides })
}

describe('permissions from the role, narrowed by a custom role', () => {
  it('gives OWNER, ADMIN and EDITOR every permission, and USER and VIEWER their own holdings, without the header', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    for (const identity of [harness.owner, harness.admin, harness.editor]) {
      expect(await getJson(harness, identity, '/api/me')).toMatchObject({ access: 'admin_rw', permissions: ALL, accessVia: 'browser' })
    }
    for (const role of ['USER', 'VIEWER'] as const) {
      const identity = holderIdentity('holder@example.test', { role })
      expect(await getJson(harness, identity, '/api/me')).toMatchObject({ access: 'holder', permissions: ['portfolio.view'] })
    }
  })

  it('lets EDITOR record changes as ADMIN does', async () => {
    harness = await readHarness()
    const response = await harness.api('POST', harness.path('/stakeholders'), harness.editor, NEW_HOLDER)
    expect(response.status, await response.clone().text()).toBe(201)
    expect((await harness.api('POST', `/api/admin/orgs/${harness.orgId}/verify-ledger`, harness.editor, {})).status).toBe(200)
    expect((await harness.api('GET', '/api/import/template', harness.editor)).status).toBe(200)
  })

  it('makes "View the cap table" alone read-only: no writes, masked bank details, no import or verification', async () => {
    harness = await readHarness()
    const reader = custom('captable.view')
    expect(await getJson(harness, reader, '/api/me')).toMatchObject({ access: 'admin_ro', pii: true, permissions: ['captable.view'] })
    expect((await harness.api('GET', harness.path('/dashboard'), reader)).status).toBe(200)
    expect((await harness.api('POST', harness.path('/stakeholders'), reader, NEW_HOLDER)).status).toBe(403)
    expect((await harness.api('POST', `/api/admin/orgs/${harness.orgId}/verify-ledger`, reader, {})).status).toBe(403)
    expect((await harness.api('GET', '/api/import/template', reader)).status).toBe(403)
    const org = await getJson<api.Org>(harness, reader, '')
    const full = await getJson<api.Org>(harness, harness.editor, '')
    if (full.ein !== null) expect(org.ein).not.toBe(full.ein)
  })

  it('never adds a permission the role lacks: a VIEWER who lists them all is still a holder', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const forged = holderIdentity('holder@example.test', { permissions: ALL.join(' ') })
    expect(await getJson(harness, forged, '/api/me')).toMatchObject({ access: 'holder', permissions: ['portfolio.view'] })
    expect((await harness.api('GET', harness.path('/dashboard'), forged)).status).toBe(404)
    expect((await harness.api('POST', harness.path('/stakeholders'), forged, NEW_HOLDER)).status).toBe(404)
  })

  it('narrows an ADMIN to the holder view, ignores unknown keys, and accepts commas', async () => {
    harness = await readHarness({ emails: { S04: 'custom@example.test' } })
    const holderOnly = custom('portfolio.view captable.delete', { role: 'ADMIN' })
    expect(await getJson(harness, holderOnly, '/api/me')).toMatchObject({
      access: 'holder', permissions: ['portfolio.view'], portal: { matches: [{ stakeholderId: harness.id('S04') }] },
    })
    expect((await harness.api('POST', harness.path('/stakeholders'), holderOnly, NEW_HOLDER)).status).toBe(404)
    expect(await getJson(harness, custom('captable.view,portfolio.view'), '/api/me')).toMatchObject({
      access: 'admin_ro', permissions: ['captable.view', 'portfolio.view'],
    })
  })

  it('treats an empty permission list as no access', async () => {
    harness = await readHarness()
    const nothing = custom('')
    expect(await getJson(harness, nothing, '/api/me')).toMatchObject({ access: 'none', permissions: [] })
    expect((await harness.api('GET', harness.path('/dashboard'), nothing)).status).toBe(404)
  })

  it('still refuses changes from someone who records changes without an e-mail address', async () => {
    harness = await readHarness()
    const response = await harness.api('POST', harness.path('/stakeholders'), consoleHeaders({ userId: 'no-mail-editor', role: 'EDITOR', email: '' }), NEW_HOLDER)
    expect(response.status).toBe(403)
  })

  it('reports how the request arrived: browser by default, or an AI agent or API client', async () => {
    harness = await readHarness()
    expect(await getJson(harness, consoleHeaders({ via: 'mcp' }), '/api/me')).toMatchObject({ accessVia: 'mcp' })
    expect(await getJson(harness, consoleHeaders({ via: 'API' }), '/api/me')).toMatchObject({ accessVia: 'api' })
    expect(await getJson(harness, consoleHeaders({ via: 'telnet' }), '/api/me'), 'an unknown channel never passes for the browser').toMatchObject({ accessVia: 'api' })
    expect(await getJson(harness, consoleHeaders(), '/api/me'), 'no header: the Insulin console').toMatchObject({ accessVia: 'browser' })
  })
})

describe('the API catalog for AI agents and API clients', () => {
  async function catalog(identity: Record<string, string>) {
    return api.apiCatalogSchema.parse(await getJson(harness!, identity, '/api/catalog'))
  }
  const has = (list: api.ApiCatalogEndpoint[], method: string, path: string) => list.some((endpoint) => endpoint.method === method && endpoint.path === path)

  it('lists every endpoint for those who record changes, with placeholders, schemas and idempotency', async () => {
    harness = await readHarness()
    const { endpoints } = await catalog(harness.editor)
    expect(endpoints.length).toBe(api.ROUTE_TABLE.filter((route) => route.auth !== 'holder').length - 1)
    expect(has(endpoints, 'POST', '/api/orgs'), 'the company exists, so setting one up is no longer offered').toBe(false)
    expect(endpoints.every((endpoint) => endpoint.path.startsWith('/api/') && !endpoint.path.includes(':'))).toBe(true)
    const create = endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/orgs/{orgId}/stakeholders')!
    expect(create).toMatchObject({ idempotencyKey: true, query: null })
    expect(create.body).toMatchObject({ type: 'object', properties: { displayName: expect.any(Object) } })
    expect(has(endpoints, 'GET', '/api/catalog')).toBe(true)
    expect(has(endpoints, 'GET', '/api/portal/overview')).toBe(false)
    expect(endpoints.find((endpoint) => endpoint.path === '/api/me')).toMatchObject({ idempotencyKey: false, body: null })
  })

  it('lists reads only for a read-only custom role, the portal for holders, and only identity routes without access', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const read = (await catalog(custom('captable.view'))).endpoints
    expect(read.length).toBeGreaterThan(10)
    expect(read.every((endpoint) => endpoint.method === 'GET' || endpoint.path.endsWith('/vesting-terms/preview'))).toBe(true)
    expect(has(read, 'POST', '/api/orgs/{orgId}/stakeholders')).toBe(false)

    const holder = (await catalog(holderIdentity('holder@example.test'))).endpoints
    expect(holder.length).toBeGreaterThan(2)
    expect(holder.every((endpoint) => endpoint.path.startsWith('/api/portal/') || ['/api/me', '/api/catalog'].includes(endpoint.path))).toBe(true)

    const none = (await catalog(custom(''))).endpoints
    expect(none.map((endpoint) => endpoint.path).sort()).toEqual(['/api/catalog', '/api/me'])
    const unmatched = (await catalog(holderIdentity('nobody@example.test'))).endpoints
    expect(unmatched.map((endpoint) => endpoint.path).sort(), 'a holder without a match has no portal').toEqual(['/api/catalog', '/api/me'])
  })

  it('offers setup and the import before the company exists, and sends someone without access to an existing one away', async () => {
    const empty = await createTestDatabase()
    try {
      const response = await appRequest('/api/catalog', {}, consoleHeaders({ role: 'EDITOR' }))
      const { endpoints } = api.apiCatalogSchema.parse(await response.json())
      expect(has(endpoints, 'POST', '/api/orgs')).toBe(true)
      expect(has(endpoints, 'POST', '/api/import/preview')).toBe(true)
      expect(endpoints.some((endpoint) => endpoint.path.startsWith('/api/orgs/{orgId}')), 'no company id to use yet').toBe(false)
      const me = await (await appRequest('/api/me', {}, consoleHeaders({ role: 'VIEWER' }))).json()
      expect(me).toMatchObject({ company: null, companyExists: false })
    } finally {
      await empty.close()
    }
    harness = await readHarness()
    const outsider = await getJson(harness, custom(''), '/api/me')
    expect(outsider).toMatchObject({ company: null, companyExists: true, access: 'none' })
  })
})
