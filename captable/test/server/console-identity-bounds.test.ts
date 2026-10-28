import { afterEach, describe, expect, it } from 'vitest'
import { appRequest, consoleHeaders, createTestDatabase, type TestDatabase } from '../support/server-harness.ts'

let testDb: TestDatabase | undefined
afterEach(async () => { await testDb?.close(); testDb = undefined; delete process.env.SUGER_ACCESS_MODE })

async function setup(organizationId: string, orgKey: string) {
  return appRequest('/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgKey, legalName: 'Identity Example, Inc.', displayName: 'Identity Example', timezone: 'UTC',
    }),
  }, consoleHeaders({ organizationId, userId: `owner-${orgKey}`, email: `${orgKey}@example.test` }))
}

describe('console organization id handling', () => {
  it('accepts 128 characters, refuses 129, and treats odd ids as opaque keys', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    expect((await appRequest('/api/me', {}, consoleHeaders({ organizationId: 'o'.repeat(128) }))).status).toBe(200)
    expect((await appRequest('/api/me', {}, consoleHeaders({ organizationId: 'o'.repeat(129) }))).status).toBe(401)
    const odd = ["org'; DROP TABLE orgs;--", 'org%2Fwith%2Fescapes', 'org with spaces', 'ORG-CASE', 'org-case', '_', '%']
    for (const [index, organizationId] of odd.entries()) {
      expect((await setup(organizationId, `odd-${index}`)).status, organizationId).toBe(201)
    }
    const rows = (await testDb.db.prepare(
      'SELECT console_organization_id AS id FROM orgs ORDER BY created_at',
    ).all<{ id: string }>()).results.map((row) => row.id)
    expect(rows).toEqual(odd)
    const companyOf = async (organizationId: string) =>
      (await (await appRequest('/api/me', {}, consoleHeaders({ organizationId }))).json() as {
        company: { id: string } | null;
      }).company?.id
    for (const organizationId of odd) expect(await companyOf(organizationId), organizationId).toBeDefined()
    expect(await companyOf('org-case')).not.toBe(await companyOf('ORG-CASE'))
    const headers = consoleHeaders()
    delete headers['x-suger-organization-id']
    expect((await appRequest('/api/me', {}, headers)).status).toBe(401)
  })

  it('accepts opaque user ids from 3 through 80 characters and refuses ids outside that bound', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    expect((await appRequest('/api/me', {}, consoleHeaders({ userId: 'u' }))).status).toBe(401)
    expect((await appRequest('/api/me', {}, consoleHeaders({ userId: 'uv' }))).status).toBe(401)
    expect((await appRequest('/api/me', {}, consoleHeaders({ userId: 'uvw' }))).status).toBe(200)
    expect((await appRequest('/api/me', {}, consoleHeaders({ userId: "user:opaque/% '" }))).status).toBe(200)
    expect((await appRequest('/api/me', {}, consoleHeaders({ userId: 'u'.repeat(80) }))).status).toBe(200)
    expect((await appRequest('/api/me', {}, consoleHeaders({ userId: 'u'.repeat(81) }))).status).toBe(401)
  })
})
