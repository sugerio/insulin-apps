import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { addDocument, getJson, readHarness, SEED_USER_ID, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

describe('retained administrator API', () => {
  it('verifies the ledger on demand and replays the receipt', async () => {
    harness = await readHarness()
    const key = crypto.randomUUID()
    const path = `/api/admin/orgs/${harness.orgId}/verify-ledger`
    const first = await harness.api('POST', path, harness.owner, {}, { 'Idempotency-Key': key })
    expect(first.status).toBe(200)
    expect(api.ledgerVerificationSchema.parse(await first.clone().json())).toMatchObject({
      orgId: harness.orgId, ledgerSeq: harness.acme.b.headSeq, ok: true,
    })
    const replay = await harness.api('POST', path, harness.owner, {}, { 'Idempotency-Key': key })
    expect(replay.status).toBe(200)
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
    expect(await replay.json()).toEqual(await first.json())
    expect(await harness.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'ledger.verified'").first<number>('n')).toBe(1)
    expect((await harness.api('POST', path, harness.editor, {})).status).toBe(403)
  })

  it('updates the company profile idempotently and enforces versions and frozen share units', async () => {
    harness = await readHarness()
    const current = await getJson<api.Org>(harness, harness.owner, '')
    const body = {
      version: current.version,
      legalName: 'Acme Robotics Holdings, Inc.',
      displayName: 'Acme Robotics Holdings',
      ein: '12-3456789',
      address: { line1: '1 Main Street', city: 'Exampleville', region: 'CA', postalCode: '90000', country: 'US' },
    }
    const key = crypto.randomUUID()
    const updated = await harness.api('PATCH', `/api/orgs/${harness.orgId}`, harness.admin, body, { 'Idempotency-Key': key })
    expect(updated.status).toBe(200)
    expect(await updated.clone().json()).toMatchObject({
      legalName: 'Acme Robotics Holdings, Inc.', displayName: 'Acme Robotics Holdings', ein: '12-3456789',
      version: current.version + 1,
    })
    const replay = await harness.api('PATCH', `/api/orgs/${harness.orgId}`, harness.admin, body, { 'Idempotency-Key': key })
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
    const stale = await harness.api('PATCH', `/api/orgs/${harness.orgId}`, harness.owner, {
      version: current.version, displayName: 'Stale',
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { reason: 'stale_version' } })
    const frozen = await harness.api('PATCH', `/api/orgs/${harness.orgId}`, harness.owner, {
      version: current.version + 1, shareUnit: '0.001',
    })
    expect(frozen.status).toBe(422)
    expect(await frozen.json()).toMatchObject({ error: { code: 'invariant_violation' } })
  })

  it('accepts only published company resources in portal settings', async () => {
    harness = await readHarness()
    const current = await getJson<api.Org>(harness, harness.owner, '')
    const unpublished = await addDocument(harness.db, harness.orgId, 'OTHER')
    const portal = (noticeFormDocumentId: string) => ({
      howToExerciseText: null, noticeFormDocumentId, privacyNoticeDocumentId: null,
    })
    const rejected = await harness.api('PATCH', `/api/orgs/${harness.orgId}`, harness.owner, {
      version: current.version, settings: { portal: portal(unpublished) },
    })
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toMatchObject({ error: { code: 'invariant_violation' } })

    const published = await addDocument(harness.db, harness.orgId, 'OTHER', { holderVisible: true })
    await harness.db.prepare(
      'UPDATE documents SET holder_published_at = ?, holder_published_by = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    ).bind(Date.now(), SEED_USER_ID, Date.now(), published).run()
    const accepted = await harness.api('PATCH', `/api/orgs/${harness.orgId}`, harness.owner, {
      version: current.version, settings: { portal: portal(published) },
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ settings: { portal: { noticeFormDocumentId: published } } })
  }, 20_000)

  it('lists, details and confirms an empty report-only expiry run', async () => {
    harness = await readHarness()
    const inserted = await harness.db.prepare(
      'INSERT INTO expiry_runs (org_id, org_seq, local_date, candidates, created_at) VALUES (?, 1, ?, ?, ?) RETURNING org_seq',
    ).bind(harness.orgId, '2026-10-21', '[]', Date.now()).first<{ org_seq: number }>()
    const runId = inserted!.org_seq
    expect(await getJson<api.ExpiryRunList>(harness, harness.editor, '/expiry-runs')).toEqual({
      items: [{ runId, localDate: '2026-10-21', startedAt: Date.now(), state: 'pending', proposalCount: 0 }],
    })
    expect(await getJson<api.ExpiryRunDetail>(harness, harness.editor, `/expiry-runs/${runId}`)).toMatchObject({
      runId, state: 'pending', confirmedAt: null, confirmationStartedAt: null, proposals: [],
    })
    const dry = await harness.api('POST', harness.path(`/expiry-runs/${runId}/confirm?dryRun=true`), harness.admin, {
      securityIds: [], switchToAutomatic: false,
    })
    expect(dry.status).toBe(200)
    expect(await dry.json()).toEqual({ runId, commands: [], expiryMode: 'report_only' })
    const confirmed = await harness.api('POST', harness.path(`/expiry-runs/${runId}/confirm`), harness.admin, {
      expectedLedgerSeq: harness.acme.b.headSeq, securityIds: [], expectedEffectSha256s: {}, switchToAutomatic: true,
    })
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toEqual({ runId, commands: [], expiryMode: 'automatic' })
    expect(await getJson<api.ExpiryRunList>(harness, harness.editor, '/expiry-runs')).toEqual({ items: [] })
    expect(await getJson<api.ExpiryRunDetail>(harness, harness.owner, `/expiry-runs/${runId}`)).toMatchObject({
      state: 'confirmed', confirmedAt: Date.now(), confirmedBy: 'Admin Example',
    })
  })

  it('runs due processing explicitly without job or scheduler state', async () => {
    harness = await readHarness()
    const first = await harness.api('POST', harness.path('/process-due'), harness.owner)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      localDate: '2026-10-21', appliedTerminations: 0, expiredSecurities: 0, proposedExpirations: 0, remainingExpirations: 0, failures: 0,
    })
    const second = await harness.api('POST', harness.path('/process-due'), harness.owner)
    expect(await second.json()).toEqual(await (await harness.api('POST', harness.path('/process-due'), harness.owner)).json())
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM expiry_runs').first<number>('n')).toBe(0)
    expect(await harness.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('job_runs', 'job_cursors')",
    ).first<number>('n')).toBe(0)
  })
})
