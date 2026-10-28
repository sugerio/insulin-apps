import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appRequest,
  consoleHeaders,
  createLegacyTestDatabase,
  jsonRequest,
  type TestDatabase,
} from '../support/server-harness.ts'

let testDb: TestDatabase

async function setupCompany() {
  const response = await jsonRequest('/api/orgs', 'POST', {
    orgKey: 'acme',
    legalName: 'Acme Example, Inc.',
    displayName: 'Acme Example',
    timezone: 'UTC',
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ id: string }>
}

beforeEach(async () => {
  process.env.SUGER_ACCESS_MODE = 'console'
  testDb = await createLegacyTestDatabase()
})

afterEach(async () => {
  await testDb.close()
  delete process.env.SUGER_ACCESS_MODE
})

describe('console identity and one-company setup', () => {
  it('requires console identity on every API route except health', async () => {
    const health = await appRequest('/api/health', {}, {})
    expect(health.status).toBe(200)
    const denied = await appRequest('/api/me', {}, {})
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({ error: 'Open this app from the Insulin console' })
  })

  it('sets up one company and returns the new /api/me shape', async () => {
    const company = await setupCompany()
    const me = await appRequest('/api/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      user: { id: 'console-user-1', email: 'owner@example.test', displayName: 'Owner Example' },
      consoleRole: 'OWNER',
      preview: false,
      company: { id: company.id, displayName: 'Acme Example', legalName: 'Acme Example, Inc.' },
      access: 'admin_rw',
      pii: true,
      portal: { matches: [] },
    })
    expect(await testDb.db.prepare('SELECT email FROM users WHERE id = ?').bind('console-user-1').first('email'))
      .toBe('owner@example.test')

    const duplicate = await jsonRequest('/api/orgs', 'POST', {
      orgKey: 'other', legalName: 'Other, Inc.', displayName: 'Other', timezone: 'UTC',
    })
    expect(duplicate.status).toBe(409)
  })

  it('keeps the one-company invariant inside the setup batch', async () => {
    await testDb.db.exec('DROP INDEX orgs_one_active_per_console_organization')
    const create = (orgKey: string, userId: string) => jsonRequest('/api/orgs', 'POST', {
      orgKey, legalName: `${orgKey} Example, Inc.`, displayName: orgKey, timezone: 'UTC',
    }, consoleHeaders({ userId, email: `${userId}@example.test` }))
    const responses = await Promise.all([create('company-one', 'owner-one'), create('company-two', 'owner-two')])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    expect(await testDb.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status = 'active'").first<number>('n')).toBe(1)
  })

  it('stores a console user without an e-mail without rewriting it later', async () => {
    const withoutEmail = consoleHeaders({ userId: 'email-later', email: '', name: 'Email Later' })
    expect((await appRequest('/api/me', {}, withoutEmail)).status).toBe(200)
    expect(await testDb.db.prepare('SELECT email FROM users WHERE id = ?').bind('email-later').first('email')).toBeNull()

    const withEmail = consoleHeaders({ userId: 'email-later', email: 'later@example.test', name: 'Email Later' })
    expect((await appRequest('/api/me', {}, withEmail)).status).toBe(200)
    expect(await testDb.db.prepare('SELECT email FROM users WHERE id = ?').bind('email-later').first('email')).toBeNull()
  })

  it('plainly refuses administrator writes without a console e-mail', async () => {
    const identity = consoleHeaders({ userId: 'missing-email-admin', email: '' })
    const response = await jsonRequest('/api/orgs', 'POST', {
      orgKey: 'no-email', legalName: 'No E-mail, Inc.', displayName: 'No E-mail', timezone: 'UTC',
    }, identity)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'forbidden', message: 'Add an e-mail address to your console profile before making changes' },
    })
  })

  it('maps EDITOR to read-only and a matching VIEWER to holder access', async () => {
    const company = await setupCompany()
    const created = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Holder Example', relationship: 'investor',
      emails: [{ email: 'holder@example.test', kind: 'self' }],
    })
    expect(created.status).toBe(201)
    const stakeholder = await created.json() as { id: string }

    const editorIdentity = consoleHeaders({ role: 'EDITOR', userId: 'editor-1', email: 'editor@example.test' })
    const editor = await appRequest('/api/me', {}, editorIdentity)
    expect(await editor.json()).toMatchObject({ access: 'admin_ro', pii: true })
    const editorWrite = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Denied Write', relationship: 'investor', emails: [],
    }, editorIdentity)
    expect(editorWrite.status).toBe(403)

    const viewerIdentity = consoleHeaders({
      role: 'VIEWER', userId: 'viewer-1', email: 'HOLDER@example.test', name: 'Holder Example',
    })
    const viewer = await appRequest('/api/me', {}, viewerIdentity)
    expect(await viewer.json()).toMatchObject({
      access: 'holder',
      pii: false,
      portal: { matches: [{ orgId: company.id, stakeholderId: stakeholder.id, stakeholderName: 'Holder Example' }] },
    })
    expect((await appRequest('/api/portal/overview', {}, viewerIdentity)).status).toBe(200)
  })

  it('processes due work idempotently on demand', async () => {
    const company = await setupCompany()
    const first = await appRequest(`/api/orgs/${company.id}/process-due`, { method: 'POST' })
    expect(first.status).toBe(200)
    const result = await first.json()
    expect(result).toMatchObject({
      appliedTerminations: 0,
      expiredSecurities: 0,
      proposedExpirations: 0,
      remainingExpirations: 0,
      failures: 0,
    })
    const second = await appRequest(`/api/orgs/${company.id}/process-due`, { method: 'POST' })
    expect(await second.json()).toEqual(result)
  })

  it('previews, commits and reads a ledger command through the public router', async () => {
    const company = await setupCompany()
    expect(await (await jsonRequest(`/api/admin/orgs/${company.id}/verify-ledger`, 'POST', {})).json()).toMatchObject({
      ok: true, ledgerSeq: 0,
    })
    const created = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Departing Employee', relationship: 'employee', emails: [],
    })
    const stakeholder = await created.json() as { id: string }
    const intent = {
      stakeholderId: stakeholder.id,
      terminationDate: '2026-10-20',
      terminationType: 'voluntary',
    }
    const previewResponse = await jsonRequest(
      `/api/orgs/${company.id}/commands/terminate-stakeholder?dryRun=true`, 'POST', intent,
    )
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json() as {
      ledgerSeq: number
      diffSha256: string
      warnings: { code: string }[]
      transactions: { type: string }[]
    }
    expect(preview).toMatchObject({ ledgerSeq: 0, transactions: [{ type: 'X_STAKEHOLDER_TERMINATION' }] })

    const committed = await jsonRequest(`/api/orgs/${company.id}/commands/terminate-stakeholder`, 'POST', {
      ...intent,
      expectedLedgerSeq: preview.ledgerSeq,
      expectedDiffSha256: preview.diffSha256,
      acknowledge: preview.warnings.map(({ code }) => code),
    })
    expect(committed.status).toBe(200)
    expect(await committed.json()).toMatchObject({ dryRun: false, ledgerSeq: 1 })

    const detail = await appRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}`)
    expect(detail.status).toBe(200)
    const terminated = await detail.json() as { id: string; relationship: string; version: number }
    expect(terminated).toMatchObject({ id: stakeholder.id, relationship: 'ex_employee' })
    const relationshipRewrite = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}`, 'PATCH', {
      version: terminated.version, relationship: 'employee',
    })
    expect(relationshipRewrite.status).toBe(409)
    expect(await relationshipRewrite.json()).toMatchObject({ error: { reason: 'state_changed' } })
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE org_id = ?')
      .bind(company.id).first<number>('n')).toBe(1)
    expect(await (await jsonRequest(`/api/admin/orgs/${company.id}/verify-ledger`, 'POST', {})).json()).toMatchObject({
      ok: true, ledgerSeq: 1,
    })
  })

  it('moves document links when stakeholders are merged without legacy freeze state', async () => {
    const company = await setupCompany()
    const makeStakeholder = async (displayName: string) => {
      const response = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
        kind: 'individual', displayName, relationship: 'investor', emails: [],
      })
      return response.json() as Promise<{ id: string }>
    }
    const merged = await makeStakeholder('Duplicate Holder')
    const survivor = await makeStakeholder('Surviving Holder')
    const documentId = crypto.randomUUID()
    const linkId = crypto.randomUUID()
    const now = Date.now()
    await testDb.db.batch([
      testDb.db.prepare(
        `INSERT INTO documents
         (id, org_id, filename, content_type, byte_size, sha256, kind, source, uploaded_by, created_at, updated_at)
         VALUES (?, ?, 'merge-evidence.pdf', 'application/pdf', 1, ?, 'OTHER', 'upload', ?, ?, ?)`,
      ).bind(documentId, company.id, '0'.repeat(64), 'console-user-1', now, now),
      testDb.db.prepare(
        `INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_by, created_at)
         VALUES (?, ?, ?, 'EVIDENCE', ?, ?, ?)`,
      ).bind(linkId, company.id, documentId, merged.id, 'console-user-1', now),
    ])

    const intent = {
      mergedStakeholderId: merged.id,
      survivingStakeholderId: survivor.id,
      reason: 'Duplicate record',
    }
    const dry = await jsonRequest(`/api/orgs/${company.id}/commands/merge-stakeholders?dryRun=true`, 'POST', intent)
    expect(dry.status).toBe(200)
    const preview = await dry.json() as {
      ledgerSeq: number
      diffSha256: string
      warnings: { code: string }[]
      stakeholderMerge: { confirmation: string }
    }
    const done = await jsonRequest(`/api/orgs/${company.id}/commands/merge-stakeholders`, 'POST', {
      ...intent,
      confirmation: preview.stakeholderMerge.confirmation,
      expectedLedgerSeq: preview.ledgerSeq,
      expectedDiffSha256: preview.diffSha256,
      acknowledge: preview.warnings.map(({ code }) => code),
    })
    expect(done.status).toBe(200)
    expect(await testDb.db.prepare('SELECT stakeholder_id FROM document_links WHERE id = ?')
      .bind(linkId).first('stakeholder_id')).toBe(survivor.id)
  })
})

describe('simplified stakeholder and payment administration', () => {
  it('honors closed portal access during holder identity matching', async () => {
    const company = await setupCompany()
    const created = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Closed Holder', relationship: 'investor',
      emails: [{ email: 'closed-holder@example.test', kind: 'self' }],
    })
    const stakeholder = await created.json() as { id: string; version: number }
    expect((await jsonRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}`, 'PATCH', {
      version: stakeholder.version, portalAccess: 'closed',
    })).status).toBe(200)

    const viewer = consoleHeaders({
      role: 'VIEWER', userId: 'closed-holder', email: 'closed-holder@example.test', name: 'Closed Holder',
    })
    expect(await (await appRequest('/api/me', {}, viewer)).json()).toMatchObject({ access: 'none', portal: { matches: [] } })
    expect((await appRequest('/api/portal/overview', {}, viewer)).status).toBe(404)
  })

  it('maps duplicate issuer ids and a batch-time stale stakeholder version to conflicts', async () => {
    const company = await setupCompany()
    const first = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'First External ID', relationship: 'investor', issuerAssignedId: 'EXT-1', emails: [],
    })
    expect(first.status).toBe(201)
    const second = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Second External ID', relationship: 'investor', emails: [],
    })
    const stakeholder = await second.json() as { id: string; version: number }
    const duplicate = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}`, 'PATCH', {
      version: stakeholder.version, issuerAssignedId: 'EXT-1',
    })
    expect(duplicate.status).toBe(409)

    await testDb.db.exec(`CREATE TRIGGER simulate_stakeholder_race
      BEFORE UPDATE ON stakeholders WHEN OLD.id = '${stakeholder.id}'
      BEGIN SELECT RAISE(ABORT, 'stale version'); END`)
    const stale = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}`, 'PATCH', {
      version: stakeholder.version, displayName: 'Concurrent update',
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { reason: 'stale_version' } })
  })

  it('adds/removes plain e-mails and enforces the case-insensitive self-dealing guard', async () => {
    const company = await setupCompany()
    const created = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Owner Stakeholder', relationship: 'employee', emails: [],
    })
    expect(created.status).toBe(201)
    const stakeholder = await created.json() as { id: string }

    const added = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}/emails`, 'POST', {
      email: 'OWNER@EXAMPLE.TEST', kind: 'self',
    })
    expect(added.status).toBe(201)
    expect(await added.json()).toMatchObject({ email: 'owner@example.test', kind: 'self', removedAt: null })

    const blocked = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${stakeholder.id}/emails`, 'POST', {
      email: 'second@example.test', kind: 'contact',
    })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ error: { code: 'self_dealing' } })

    const otherCreated = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Other Stakeholder', relationship: 'investor', emails: [],
    })
    const other = await otherCreated.json() as { id: string }
    const otherEmailResponse = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${other.id}/emails`, 'POST', {
      email: 'contact@example.test', kind: 'contact',
    })
    const otherEmail = await otherEmailResponse.json() as { id: string }
    const removed = await jsonRequest(
      `/api/orgs/${company.id}/stakeholders/${other.id}/emails/${otherEmail.id}/remove`,
      'POST',
      { reason: 'No longer current' },
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ id: otherEmail.id, removedAt: expect.any(Number) })
  })

  it('requires acknowledgement when a stakeholder e-mail is already in use', async () => {
    const company = await setupCompany()
    expect((await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'First Shared E-mail', relationship: 'investor',
      emails: [{ email: 'shared@example.test', kind: 'self' }],
    })).status).toBe(201)

    const duplicateCreate = {
      kind: 'individual', displayName: 'Second Shared E-mail', relationship: 'investor',
      emails: [{ email: 'SHARED@example.test', kind: 'self' }],
    }
    const warnedCreate = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', duplicateCreate)
    expect(warnedCreate.status).toBe(422)
    expect(await warnedCreate.json()).toMatchObject({
      error: { code: 'warnings_unacknowledged', warnings: [{ code: 'DUPLICATE_EMAIL' }] },
    })
    expect((await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      ...duplicateCreate, acknowledge: ['DUPLICATE_EMAIL'],
    })).status).toBe(201)

    const blank = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Third Shared E-mail', relationship: 'investor', emails: [],
    })
    const third = await blank.json() as { id: string }
    const emailBody = { email: 'shared@example.test', kind: 'contact' }
    const warnedAdd = await jsonRequest(`/api/orgs/${company.id}/stakeholders/${third.id}/emails`, 'POST', emailBody)
    expect(warnedAdd.status).toBe(422)
    expect((await jsonRequest(`/api/orgs/${company.id}/stakeholders/${third.id}/emails`, 'POST', {
      ...emailBody, acknowledge: ['DUPLICATE_EMAIL'],
    })).status).toBe(201)
  })

  it('sets and gets payment instructions with an audit event', async () => {
    const company = await setupCompany()
    const details = {
      bankName: 'Example Bank', beneficiaryName: 'Acme Example, Inc.', beneficiaryAddress: '1 Main St',
      accountNumber: '123456789', routingNumber: '021000021', referenceFormat: 'EX-<grant>',
    }
    const set = await jsonRequest(`/api/orgs/${company.id}/payment-instructions`, 'POST', { details, updatedAt: null })
    expect(set.status).toBe(200)
    const first = await set.json() as { details: typeof details; updatedBy: string; updatedAt: number }
    expect(first).toMatchObject({ details, updatedBy: 'Owner Example' })
    const get = await appRequest(`/api/orgs/${company.id}/payment-instructions`)
    expect(await get.json()).toMatchObject({ details })
    const replacement = { ...details, accountNumber: '987654321' }
    expect((await jsonRequest(`/api/orgs/${company.id}/payment-instructions`, 'POST', {
      details: replacement, updatedAt: first.updatedAt,
    })).status).toBe(200)
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM payment_instructions WHERE org_id = ?').bind(company.id).first<number>('n')).toBe(1)
    expect(await testDb.db.prepare('SELECT version FROM payment_instructions WHERE org_id = ?').bind(company.id).first<number>('version')).toBe(2)
    expect(await testDb.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment_instructions.set'").first<number>('n')).toBe(2)
  })
})
