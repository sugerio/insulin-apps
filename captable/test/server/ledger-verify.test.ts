import { describe, expect, it } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
import { verifyOrgLedger } from '../../src/app/server/lib/ledger/verify.ts'
import { loadLedger, stateAt } from '../../src/app/server/lib/read/ledger.ts'
import {
  ACME_NOW,
  OWNER,
  count,
  holderIdentity,
  ledgerHarness,
  openTestApp,
  addEmail,
  sendApi,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/**
 * `POST /api/admin/orgs/:orgId/verify-ledger` and the integrity verification it shares with
 * the server library (the engine's `verifyLedgerRows`): six checks, each reported with the ids it found, an audited run,
 * and a report stored with its receipt.
 */

async function verify(l: LedgerHarness, identity: Record<string, string> | null, orgId = l.orgId, key: string = crypto.randomUUID()) {
  const response = await l.api('POST', `/api/admin/orgs/${orgId}/verify-ledger`, identity, undefined, { 'Idempotency-Key': key })
  return { status: response.status, body: await response.json() as Record<string, unknown>, replay: response.headers.get('Idempotent-Replay') }
}

describe('verify-ledger', () => {
  it('verifies an org now: six checks passed, audited, the report stored with its receipt', async () => {
    const l = await ledgerHarness()
    const key = crypto.randomUUID()
    const result = await verify(l, l.sa, l.orgId, key)
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const report = api.ledgerVerificationSchema.parse(result.body)
    const head = await l.db.prepare('SELECT seq, head_hash FROM ledger_heads WHERE org_id = ?').bind(l.orgId).first<{ seq: number; head_hash: string }>()
    expect(report).toMatchObject({ orgId: l.orgId, checkedAt: ACME_NOW, ledgerSeq: head!.seq, ledgerHeadHash: head!.head_hash, ok: true })
    expect(report.checks).toEqual(engine.LEDGER_CHECKS.map((name) => ({ name, ok: true, problems: [] })))
    expect(await verify(l, l.sa, l.orgId, key)).toMatchObject({ status: 200, replay: 'true', body: result.body })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'ledger.verified' AND target_id = ? AND result = 'success'", l.orgId)).toBe(1)
  })

  it("reports what it finds without stopping: missing edges and a vesting schedule whose hash doesn't match", async () => {
    const l = await ledgerHarness({ edges: false })
    const head = await l.db.prepare('SELECT seq FROM ledger_heads WHERE org_id = ?').bind(l.orgId).first<number>('seq')
    // A vesting row stored with another definition's hash (rows are immutable, so the damage is a row of its own).
    const definition = { type: 'EXPLICIT', events: [{ date: '2027-01-01', quantity: '1000' }] }
    await l.db.prepare(
      `INSERT INTO vesting_terms (id, org_id, name, is_template, definition, definition_sha256, algorithm_version, created_at)
       VALUES (?, ?, 'Damaged schedule', 0, ?, ?, 1, ?)`,
    ).bind(crypto.randomUUID(), l.orgId, engine.canonicalJson(definition), 'e'.repeat(64), ACME_NOW).run()
    const report = api.ledgerVerificationSchema.parse((await verify(l, l.sa)).body)
    expect(report.ok).toBe(false)
    const failed = Object.fromEntries(report.checks.filter((check) => !check.ok).map((check) => [check.name, check.problems]))
    expect(Object.keys(failed).sort()).toEqual(['dependencies', 'replay'])
    expect(failed.replay).toEqual(['VESTING_TERMS_HASH_MISMATCH'])
    // Fifty problems at most per check, then how many more.
    expect(failed.dependencies!.slice(0, 50).every((problem) => /^DEPENDENCY_EDGE_MISSING [0-9a-f-]{36}$/.test(problem))).toBe(true)
    expect(failed.dependencies!.at(-1)).toMatch(/^\d+ more$/)
    expect(await l.db.prepare("SELECT details FROM audit_events WHERE action = 'ledger.verified' AND result = 'error'").first('details'))
      .toBe(JSON.stringify({ ok: false, ledgerSeq: head, failed: ['replay', 'dependencies'] }))
  })

  it('is for write administrators only, on an org that exists', async () => {
    const l = await ledgerHarness()
    await addEmail(l.db, l.orgId, l.id('S04'), 'holder.verify@example.test')
    expect((await verify(l, l.ro)).status).toBe(403)
    expect((await verify(l, holderIdentity('holder.verify@example.test'))).status).toBe(403)
    expect((await verify(l, null)).status).toBe(401)
    expect((await verify(l, l.sa, crypto.randomUUID())).status).toBe(404)
    expect((await verify(l, l.rw)).status).toBe(200)
  })

  it('verifies a company set up through the first-run setup, with its own commands', async () => {
    const { db } = await openTestApp()
    const created = await sendApi('POST', '/api/orgs', OWNER, {
      orgKey: 'verified-example', legalName: 'Verified Example, Inc.', displayName: 'Verified Example', timezone: 'UTC',
    })
    expect(created.status).toBe(201)
    const orgId = (await created.json() as { id: string }).id
    const stakeholder = await sendApi('POST', `/api/orgs/${orgId}/stakeholders`, OWNER, {
      kind: 'individual', displayName: 'Synthetic Leaver', relationship: 'employee', emails: [],
    })
    const stakeholderId = (await stakeholder.json() as { id: string }).id
    const intent = { stakeholderId, terminationDate: '2026-10-20', terminationType: 'voluntary' }
    const preview = await (await sendApi('POST', `/api/orgs/${orgId}/commands/terminate-stakeholder?dryRun=true`, OWNER, intent)).json() as api.CommandResult
    const committed = await sendApi('POST', `/api/orgs/${orgId}/commands/terminate-stakeholder`, OWNER, {
      ...intent, expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256, acknowledge: [],
    })
    expect(committed.status).toBe(200)
    const response = await sendApi('POST', `/api/admin/orgs/${orgId}/verify-ledger`, OWNER)
    const report = api.ledgerVerificationSchema.parse(await response.json())
    expect(report).toMatchObject({ orgId, ok: true, ledgerSeq: 1 })
    expect(await db.prepare('SELECT genesis_hash FROM ledger_heads WHERE org_id = ?').bind(orgId).first('genesis_hash')).toBe(engine.genesisHash(orgId))
  })
})

describe('one verification for every caller', () => {
  it('gives the route and the server library the same answer, verifying the replay the reads serve', async () => {
    const l = await ledgerHarness()
    const route = api.ledgerVerificationSchema.parse((await verify(l, l.sa)).body)
    const { report, state } = await verifyOrgLedger(l.db, l.orgId, ACME_NOW)
    expect(report).toEqual(route)
    const served = stateAt((await loadLedger(l.db, l.orgId))!, { asOf: '2026-10-21' })
    expect(engine.replayHash(state!)).toBe(engine.replayHash(served))
  })

  it('fails both of them on the same damage', async () => {
    const l = await ledgerHarness({ edges: false })
    const route = api.ledgerVerificationSchema.parse((await verify(l, l.sa)).body)
    expect(route.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(['dependencies'])
    const { report } = await verifyOrgLedger(l.db, l.orgId, ACME_NOW)
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(['dependencies'])
  })
})
