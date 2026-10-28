import { afterEach, describe, expect, it } from 'vitest'
import { consoleHeaders } from '../support/server-harness.ts'
import {
  getJson, holderIdentity, readHarness, type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

describe('console authorization guards', () => {
  it('maps OWNER and ADMIN to read/write, and EDITOR to read-only', async () => {
    harness = await readHarness()
    for (const identity of [harness.owner, harness.admin]) {
      const me = await getJson<{ access: string; pii: boolean }>(harness, identity, '/api/me')
      expect(me).toMatchObject({ access: 'admin_rw', pii: true })
      const response = await harness.api('POST', harness.path('/stakeholders'), identity, {
        kind: 'individual', displayName: 'New Synthetic Holder', relationship: 'investor', emails: [],
      })
      expect(response.status).toBe(201)
    }
    expect(await getJson(harness, harness.editor, '/api/me')).toMatchObject({ access: 'admin_ro', pii: true })
    expect((await harness.api('GET', harness.path('/dashboard'), harness.editor)).status).toBe(200)
    expect((await harness.api('POST', harness.path('/stakeholders'), harness.editor, {
      kind: 'individual', displayName: 'Denied Synthetic Holder', relationship: 'investor', emails: [],
    })).status).toBe(403)
  })

  it('gives USER and VIEWER only their matched holder portal', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    for (const role of ['USER', 'VIEWER'] as const) {
      const identity = holderIdentity('HOLDER@example.test', { role, userId: 'holder-console-user' })
      expect(await getJson(harness, identity, '/api/me')).toMatchObject({
        access: 'holder', pii: false, portal: { matches: [{ orgId: harness.orgId, stakeholderId: harness.id('S04') }] },
      })
      expect((await harness.api('GET', '/api/portal/overview', identity)).status).toBe(200)
      expect((await harness.api('GET', harness.path('/dashboard'), identity)).status).toBe(404)
      expect((await harness.api('POST', harness.path('/stakeholders'), identity, {})).status).toBe(404)
    }
  })

  it('refuses unmatched holders, missing console identity, and non-write admin verification', async () => {
    harness = await readHarness()
    const unmatched = holderIdentity('nobody@example.test')
    expect(await getJson(harness, unmatched, '/api/me')).toMatchObject({ access: 'none', portal: { matches: [] } })
    expect((await harness.api('GET', '/api/portal/overview', unmatched)).status).toBe(404)
    expect((await harness.api('GET', '/api/me', {})).status).toBe(401)
    expect((await harness.api('POST', `/api/admin/orgs/${harness.orgId}/verify-ledger`, harness.editor, {})).status).toBe(403)
    expect((await harness.api('POST', `/api/admin/orgs/${harness.orgId}/verify-ledger`, harness.owner, {})).status).toBe(200)
  })

  it('updates only a safe changed display name and never rewrites the stored e-mail', async () => {
    harness = await readHarness()
    const first = consoleHeaders({ userId: 'stable-id', role: 'ADMIN', email: 'first@example.test', name: 'First Name' })
    const longName = 'N'.repeat(240)
    const second = consoleHeaders({ userId: 'stable-id', role: 'ADMIN', email: 'changed@example.test', name: longName })
    expect((await harness.api('GET', '/api/me', first)).status).toBe(200)
    expect((await harness.api('GET', '/api/me', second)).status).toBe(200)
    expect((await harness.api('GET', '/api/me', second)).status).toBe(200)
    expect(await harness.db.prepare('SELECT email, display_name, version FROM users WHERE id = ?').bind('stable-id').first())
      .toMatchObject({ email: 'first@example.test', display_name: longName.slice(0, 200), version: 2 })

    const reused = consoleHeaders({ userId: 'replacement-id', role: 'ADMIN', email: 'first@example.test', name: 'Replacement' })
    const invalid = consoleHeaders({ userId: 'invalid-email-id', role: 'ADMIN', email: 'user@localhost', name: 'Invalid E-mail' })
    expect((await harness.api('GET', '/api/me', reused)).status).toBe(200)
    expect((await harness.api('GET', '/api/me', invalid)).status).toBe(200)
    expect(await harness.db.prepare('SELECT email FROM users WHERE id = ?').bind('invalid-email-id').first('email')).toBeNull()
  })
})
