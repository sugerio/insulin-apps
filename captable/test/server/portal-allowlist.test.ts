import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { getJson, holderIdentity, readHarness, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

describe('portal allowlist release gate', () => {
  it('keeps every holder JSON schema strict and free of aggregate ownership keys', () => {
    const routes = api.ROUTE_TABLE.filter((route) => route.auth === 'holder')
    expect(routes.map((route) => route.id).sort()).toEqual([
      'downloadPortalDocument', 'getHowToExercise', 'getPortalOverview', 'getPortalSecurity', 'listPortalDocuments',
    ])
    for (const route of routes) {
      if (route.response.kind !== 'json') continue
      expect(api.findNonStrictObjects(route.response.schema), route.id).toEqual([])
      expect(api.findForbiddenSchemaKeys(route.response.schema), route.id).toEqual([])
    }
  })

  it('walks live overview, security, documents and how-to responses for forbidden keys', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const holder = holderIdentity('holder@example.test')
    const values = [
      await getJson(harness, holder, '/api/portal/overview'),
      await getJson(harness, holder, `/api/portal/orgs/${harness.orgId}/securities/${harness.id('OPT-1')}`),
      await getJson(harness, holder, `/api/portal/orgs/${harness.orgId}/documents`),
      await getJson(harness, holder, `/api/portal/orgs/${harness.orgId}/how-to-exercise`),
    ]
    for (const value of values) expect(api.findForbiddenKeys(value)).toEqual([])
  })

  it('returns 404 uniformly for unmatched identities and foreign resources', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const unmatched = holderIdentity('unmatched@example.test')
    for (const path of [
      '/api/portal/overview',
      `/api/portal/orgs/${harness.orgId}/documents`,
      `/api/portal/orgs/${harness.orgId}/how-to-exercise`,
      `/api/portal/orgs/${harness.orgId}/securities/${harness.id('OPT-1')}`,
      `/api/portal/documents/${crypto.randomUUID()}/download`,
    ]) expect((await harness.api('GET', path, unmatched)).status, path).toBe(404)
    const holder = holderIdentity('holder@example.test')
    expect((await harness.api(
      'GET', `/api/portal/orgs/${harness.orgId}/securities/${harness.id('OPT-2')}`, holder,
    )).status).toBe(404)
  })
})
