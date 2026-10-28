import { afterEach, describe, expect, it } from 'vitest'
import { engine } from '../../src/app/shared/index.ts'
import {
  appRequest,
  consoleHeaders,
  createTestDatabase,
  type TestDatabase,
} from '../support/server-harness.ts'

let testDb: TestDatabase | undefined
afterEach(async () => {
  await testDb?.close()
  testDb = undefined
  delete process.env.SUGER_ACCESS_MODE
})

async function seedHiddenCompany(status: 'importing' | 'archived') {
  process.env.SUGER_ACCESS_MODE = 'console'
  testDb = await createTestDatabase()
  const orgId = crypto.randomUUID()
  const stakeholderId = crypto.randomUUID()
  const now = Date.UTC(2026, 9, 27)
  await testDb.db.batch([
    testDb.db.prepare(
      `INSERT INTO orgs
       (id, org_key, slug, status, legal_name, display_name, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Hidden Example, Inc.', 'Hidden Example', '{}', ?, ?)`,
    ).bind(orgId, `hidden-${status}`, `hidden-${status}`, status, now, now),
    testDb.db.prepare(
      'INSERT INTO ledger_heads (org_id, seq, genesis_hash, head_hash, updated_at) VALUES (?, 0, ?, NULL, ?)',
    ).bind(orgId, engine.genesisHash(orgId), now),
    testDb.db.prepare(
      `INSERT INTO stakeholders
       (id, org_id, kind, display_name, relationship, country_of_residence, tax_status, portal_access, created_at, updated_at)
       VALUES (?, ?, 'individual', 'Hidden Holder', 'employee', 'US', 'us', 'open', ?, ?)`,
    ).bind(stakeholderId, orgId, now, now),
    testDb.db.prepare(
      `INSERT INTO stakeholder_emails (id, org_id, stakeholder_id, email, kind, created_at)
       VALUES (?, ?, ?, 'hidden.holder@example.test', 'self', ?)`,
    ).bind(crypto.randomUUID(), orgId, stakeholderId, now),
  ])
  return { orgId }
}

describe.each(['importing', 'archived'] as const)('%s companies stay invisible', (status) => {
  it('is absent from identity resolution, lists, direct reads, admin reads, and holder access', async () => {
    const { orgId } = await seedHiddenCompany(status)
    const owner = consoleHeaders()

    const me = await appRequest('/api/me', {}, owner)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ company: null, access: 'none', portal: { matches: [] } })

    const list = await appRequest('/api/orgs', {}, owner)
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ items: [] })

    expect((await appRequest(`/api/orgs/${orgId}`, {}, owner)).status).toBe(404)
    expect((await appRequest(`/api/orgs/${orgId}/stakeholders`, {}, owner)).status).toBe(404)
    expect((await appRequest(`/api/admin/orgs/${orgId}/verify-ledger`, { method: 'POST' }, owner)).status).toBe(404)

    const holder = consoleHeaders({
      role: 'USER',
      userId: `holder-${status}`,
      email: 'hidden.holder@example.test',
      name: 'Hidden Holder',
    })
    const holderMe = await appRequest('/api/me', {}, holder)
    expect(holderMe.status).toBe(200)
    expect(await holderMe.json()).toMatchObject({ company: null, access: 'none', portal: { matches: [] } })
    expect((await appRequest('/api/portal/overview', {}, holder)).status).toBe(404)
  })
})
