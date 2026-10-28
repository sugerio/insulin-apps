import { afterEach, describe, expect, it } from 'vitest'
import { engine } from '../../src/app/shared/index.ts'
import { addDocument, readHarness, type ReadHarness } from '../support/read-helpers.ts'
import {
  appRequest,
  consoleHeaders,
  createTestDatabase,
  type TestDatabase,
} from '../support/server-harness.ts'

const SECOND_ORGANIZATION = 'console-org-2'

let harness: ReadHarness | undefined
let testDb: TestDatabase | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
  await testDb?.close()
  testDb = undefined
  delete process.env.SUGER_ACCESS_MODE
})

function identity(organizationId: string, overrides: Parameters<typeof consoleHeaders>[0] = {}) {
  return consoleHeaders({ organizationId, ...overrides })
}

function companyBody(orgKey: string) {
  return {
    orgKey,
    legalName: 'Tenant Example, Inc.',
    displayName: 'Tenant Example',
    timezone: 'UTC',
  }
}

async function createCompany(
  organizationId: string,
  orgKey: string,
  options: { key?: string; userId?: string } = {},
): Promise<Response> {
  return appRequest('/api/orgs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    body: JSON.stringify(companyBody(orgKey)),
  }, identity(organizationId, {
    userId: options.userId ?? `owner-${organizationId}`,
    email: `${organizationId}@example.test`,
    name: 'Tenant Owner',
  }))
}

describe('console organization tenancy', () => {
  it('keeps two organizations side by side across every route family', async () => {
    harness = await readHarness({ emails: { S04: 'shared.holder@example.test' } })
    const first = harness.owner
    const second = identity(SECOND_ORGANIZATION, {
      userId: 'second-owner', email: 'second.owner@example.test', name: 'Second Owner',
    })
    const created = await harness.api('POST', '/api/orgs', second, companyBody('acme-robotics'))
    expect(created.status, await created.clone().text()).toBe(201)
    const secondOrgId = (await created.json() as { id: string }).id
    const firstDocumentId = await addDocument(harness.db, harness.orgId, 'OTHER')

    expect(await (await harness.api('GET', '/api/me', first)).json()).toMatchObject({
      company: { id: harness.orgId }, access: 'admin_rw',
    })
    expect(await (await harness.api('GET', '/api/me', second)).json()).toMatchObject({
      company: { id: secondOrgId }, access: 'admin_rw',
    })
    expect(await (await harness.api('GET', '/api/orgs', first)).json()).toMatchObject({
      items: [{ id: harness.orgId }],
    })
    expect(await (await harness.api('GET', '/api/orgs', second)).json()).toMatchObject({
      items: [{ id: secondOrgId }],
    })

    // Reads and direct company paths.
    expect((await harness.api('GET', harness.path('/dashboard'), second)).status).toBe(404)
    expect((await harness.api('GET', `/api/orgs/${secondOrgId}/dashboard`, second)).status).toBe(200)
    expect((await harness.api('GET', `/api/orgs/${secondOrgId}`, first)).status).toBe(404)

    // Commands, stakeholders and payment instructions.
    expect((await harness.api('POST', harness.path('/process-due'), second)).status).toBe(404)
    expect((await harness.api('POST', `/api/orgs/${secondOrgId}/process-due`, second)).status).toBe(200)
    expect((await harness.api('GET', harness.path('/stakeholders'), second)).status).toBe(404)
    expect((await harness.api('GET', `/api/orgs/${secondOrgId}/stakeholders`, second)).status).toBe(200)
    expect((await harness.api('GET', harness.path('/payment-instructions'), second)).status).toBe(404)
    expect((await harness.api('GET', `/api/orgs/${secondOrgId}/payment-instructions`, second)).status).toBe(200)

    // Documents and direct document ids.
    expect((await harness.api('GET', harness.path('/documents'), second)).status).toBe(404)
    expect((await harness.api('GET', `/api/orgs/${secondOrgId}/documents`, second)).status).toBe(200)
    expect((await harness.api(
      'GET', `/api/orgs/${secondOrgId}/documents/${firstDocumentId}`, second,
    )).status).toBe(404)
    expect((await harness.api(
      'GET', `/api/orgs/${secondOrgId}/documents/${firstDocumentId}/download`, second,
    )).status).toBe(404)

    // Generated reports/exports and ledger administration.
    expect((await harness.api('GET', `${harness.path('/reports/cap-table')}?format=json`, second)).status).toBe(404)
    expect((await harness.api(
      'GET', `/api/orgs/${secondOrgId}/reports/cap-table?format=json`, second,
    )).status).toBe(200)
    expect((await harness.api(
      'POST', `/api/admin/orgs/${harness.orgId}/verify-ledger`, second, {},
    )).status).toBe(404)
    expect((await harness.api(
      'POST', `/api/admin/orgs/${secondOrgId}/verify-ledger`, second, {},
    )).status).toBe(200)

    // The same holder e-mail matches only inside the active console organization.
    const firstHolder = identity('console-org-1', {
      role: 'USER', userId: 'first-holder', email: 'shared.holder@example.test', name: 'Shared Holder',
    })
    const secondHolder = identity(SECOND_ORGANIZATION, {
      role: 'USER', userId: 'second-holder', email: 'shared.holder@example.test', name: 'Shared Holder',
    })
    expect((await harness.api('GET', '/api/portal/overview', firstHolder)).status).toBe(200)
    expect((await harness.api('GET', '/api/portal/overview', secondHolder)).status).toBe(404)
    expect(await (await harness.api('GET', '/api/me', secondHolder)).json()).toMatchObject({
      company: null, access: 'none', portal: { matches: [] },
    })

    expect(await harness.db.prepare(
      'SELECT COUNT(*) AS n FROM orgs WHERE status = \'active\'',
    ).first<number>('n')).toBe(2)
  }, 30_000)

  it('scopes setup idempotency and allows the same slug in different console organizations', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    const key = 'shared-setup-idempotency-key'
    const userId = 'shared-console-user'
    const first = await createCompany('console-org-a', 'same-company', { key, userId })
    const second = await createCompany('console-org-b', 'same-company', { key, userId })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const firstId = (await first.json() as { id: string }).id
    const secondId = (await second.json() as { id: string }).id
    expect(secondId).not.toBe(firstId)

    const firstReplay = await createCompany('console-org-a', 'same-company', { key, userId })
    const secondReplay = await createCompany('console-org-b', 'same-company', { key, userId })
    expect(firstReplay.headers.get('Idempotent-Replay')).toBe('true')
    expect(secondReplay.headers.get('Idempotent-Replay')).toBe('true')
    expect(await firstReplay.json()).toMatchObject({ id: firstId })
    expect(await secondReplay.json()).toMatchObject({ id: secondId })
  })

  it('refuses a second company and enforces the database constraint during double creates', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    const first = await createCompany('console-org-race', 'race-one')
    expect(first.status).toBe(201)
    const refused = await createCompany('console-org-race', 'race-two')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: { message: 'This app already has a company', reason: 'state_changed' },
    })

    const concurrent = await Promise.all([
      createCompany('console-org-app-race', 'app-race-one', { key: 'app-race-key-one' }),
      createCompany('console-org-app-race', 'app-race-two', { key: 'app-race-key-two' }),
    ])
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409])
    expect(await testDb.db.prepare(
      "SELECT COUNT(*) AS n FROM orgs WHERE console_organization_id = 'console-org-app-race' AND status <> 'archived'",
    ).first<number>('n')).toBe(1)

    const insert = (id: string, key: string) => testDb!.db.prepare(
      `INSERT INTO orgs
       (id, console_organization_id, org_key, slug, status, legal_name, display_name, created_at, updated_at)
       VALUES (?, 'console-org-db-race', ?, ?, 'active', 'Race Example, Inc.', 'Race Example', 1, 1)`,
    ).bind(id, key, key).run()
    const outcomes = await Promise.allSettled([
      insert(crypto.randomUUID(), 'db-race-one'),
      insert(crypto.randomUUID(), 'db-race-two'),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await testDb.db.prepare(
      "SELECT COUNT(*) AS n FROM orgs WHERE console_organization_id = 'console-org-db-race' AND status <> 'archived'",
    ).first<number>('n')).toBe(1)
  })

  it('keeps a legacy ownerless company and its holder records invisible', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    const orgId = crypto.randomUUID()
    const stakeholderId = crypto.randomUUID()
    await testDb.db.batch([
      testDb.db.prepare(
        `INSERT INTO orgs
         (id, org_key, slug, status, legal_name, display_name, created_at, updated_at)
         VALUES (?, 'legacy-company', 'legacy-company', 'active', 'Legacy Example, Inc.', 'Legacy Example', 1, 1)`,
      ).bind(orgId),
      testDb.db.prepare(
        'INSERT INTO ledger_heads (org_id, seq, genesis_hash, head_hash, updated_at) VALUES (?, 0, ?, NULL, 1)',
      ).bind(orgId, engine.genesisHash(orgId)),
      testDb.db.prepare(
        `INSERT INTO stakeholders
         (id, org_id, kind, display_name, relationship, portal_access, created_at, updated_at)
         VALUES (?, ?, 'individual', 'Legacy Holder', 'investor', 'open', 1, 1)`,
      ).bind(stakeholderId, orgId),
      testDb.db.prepare(
        `INSERT INTO stakeholder_emails (id, org_id, stakeholder_id, email, kind, created_at)
         VALUES (?, ?, ?, 'legacy.holder@example.test', 'self', 1)`,
      ).bind(crypto.randomUUID(), orgId, stakeholderId),
    ])
    const owner = identity('console-org-legacy', {
      userId: 'legacy-owner', email: 'legacy.owner@example.test', name: 'Legacy Owner',
    })
    const holder = identity('console-org-legacy', {
      role: 'VIEWER', userId: 'legacy-holder', email: 'legacy.holder@example.test', name: 'Legacy Holder',
    })
    expect(await (await appRequest('/api/me', {}, owner)).json()).toMatchObject({ company: null, access: 'none' })
    expect((await appRequest(`/api/orgs/${orgId}`, {}, owner)).status).toBe(404)
    expect(await (await appRequest('/api/me', {}, holder)).json()).toMatchObject({
      company: null, access: 'none', portal: { matches: [] },
    })
    expect((await appRequest('/api/portal/overview', {}, holder)).status).toBe(404)
  })
})
