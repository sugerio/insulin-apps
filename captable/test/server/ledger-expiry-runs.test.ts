import { describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { expiryKey } from '../../src/app/server/lib/ledger/workflow.ts'
import type { Acme } from '../shared/engine/fixtures/acme.ts'
import {
  OWNER_USER_ID,
  CONSOLE_ORGANIZATION_ID,
  addDocument,
  commit,
  getJson,
  holderIdentity,
  ledgerHarness,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/**
 * Report-only expiry run reads: the run pending confirmation, one run with its
 * proposals and state, and the dashboard's Needs-attention line. Every administrator reads them; a write administrator
 * confirms.
 */

/** S29 left on 2026-09-01 and S27 earlier: on 2027-01-02 due processing proposes OPT-9 (S29) and OPT-26 (S27). */
const extend = (acme: Acme) => {
  acme.b.command('terminate:S29', (c) => {
    c.tx('X_STAKEHOLDER_TERMINATION', '2026-09-01', {
      stakeholder_id: acme.id('S29'), termination_date: '2026-09-01', termination_type: 'voluntary', vesting_stop_date: '2026-09-01',
      relationship_before: 'advisor', relationship_after: 'advisor',
    })
    c.tx('TX_EQUITY_COMPENSATION_CANCELLATION', '2026-09-01', { security_id: acme.id('OPT-47'), quantity: '30000', reason_text: 'Termination', x_reason: 'TERMINATION' })
  }, { type: 'terminate-stakeholder' })
}

async function harness(): Promise<LedgerHarness> {
  return ledgerHarness({
    now: Date.UTC(2027, 0, 2, 17), extend,
    emails: { S27: 's27.holder@example.test', S29: 's29.holder@example.test' },
  })
}

/** A console VIEWER whose e-mail matches S27: a holder, not an administrator. */
const holder = holderIdentity('s27.holder@example.test')

/** Runs due processing now and returns the newest run's id. */
async function runDaily(l: LedgerHarness): Promise<number> {
  const response = await l.api('POST', l.path('/process-due'), l.sa)
  expect(response.status).toBe(200)
  return (await l.db.prepare('SELECT org_seq FROM expiry_runs WHERE org_id = ? ORDER BY org_seq DESC LIMIT 1').bind(l.orgId).first<number>('org_seq'))!
}

function attention(dashboard: api.DashboardResponse) {
  return dashboard.needsAttention.find((item) => item.kind === 'EXPIRY_RUN_TO_CONFIRM')
}

async function dryRun(l: LedgerHarness, runId: number, securityIds: string[]): Promise<api.ConfirmExpiryRunResponse> {
  const response = await l.api('POST', l.path(`/expiry-runs/${runId}/confirm?dryRun=true`), l.sa, { securityIds })
  const body = await response.json() as api.ConfirmExpiryRunResponse
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body
}

describe('expiry runs', () => {
  it("lists a pending run and shows its proposals to every administrator; holders and other companies can't read them", async () => {
    const l = await harness()
    expect((await getJson<api.ExpiryRunList>(l, l.sa, '/expiry-runs')).items).toEqual([])
    const runId = await runDaily(l)
    for (const identity of [l.sa, l.rw, l.ro]) {
      expect(api.expiryRunListSchema.parse(await getJson(l, identity, '/expiry-runs')).items).toEqual([
        { runId, localDate: '2027-01-02', startedAt: l.clock.time, state: 'pending', proposalCount: 2 },
      ])
      expect(api.expiryRunDetailSchema.parse(await getJson(l, identity, `/expiry-runs/${runId}`)).proposals.map((p) => p.displayId).sort()).toEqual(['OPT-26', 'OPT-9'])
    }
    // The company's admin API is concealed from a holder, and another company id is unknown to everyone.
    const otherCompany = `/api/orgs/${crypto.randomUUID()}`
    for (const suffix of ['/expiry-runs', `/expiry-runs/${runId}`]) {
      expect((await l.api('GET', l.path(suffix), holder)).status).toBe(404)
      expect((await l.api('GET', `${otherCompany}${suffix}`, l.sa)).status).toBe(404)
      expect((await l.api('GET', l.path(suffix), null)).status).toBe(401)
    }
    expect((await l.api('GET', l.path('/expiry-runs/999999'), l.sa)).status).toBe(404)
    expect((await l.api('GET', l.path('/expiry-runs/seventy'), l.sa)).status).toBe(404)
  })

  it('refuses a holder and a read-only EDITOR before it looks at the run id, and answers an administrator 404 for a missing run', async () => {
    const l = await harness()
    const runId = await runDaily(l)
    // Whatever the id (the run's, a missing one, a UUID, not a number), a holder gets the concealed company.
    for (const id of [String(runId), '999999', '00000000-0000-4000-8000-000000000001', 'seventy']) {
      const response = await l.api('GET', l.path(`/expiry-runs/${id}`), holder)
      expect(response.status, id).toBe(404)
      expect((await response.json() as { error: { code: string } }).error.code, id).toBe('not_found')
      expect((await l.api('POST', l.path(`/expiry-runs/${id}/confirm?dryRun=true`), holder, { securityIds: [] })).status, id).toBe(404)
    }
    // A read-only EDITOR on the confirmation: refused before the run is looked up, whatever its id.
    for (const id of [String(runId), '999999', '00000000-0000-4000-8000-000000000001']) {
      const response = await l.api('POST', l.path(`/expiry-runs/${id}/confirm?dryRun=true`), l.ro, { securityIds: [] })
      expect(response.status, id).toBe(403)
      expect((await response.json() as { error: { code: string } }).error.code, id).toBe('forbidden')
    }
    // An administrator who may use the route: a missing or malformed run id is 404.
    for (const id of ['999999', '00000000-0000-4000-8000-000000000001', 'seventy']) {
      expect((await l.api('GET', l.path(`/expiry-runs/${id}`), l.ro)).status, id).toBe(404)
      expect((await l.api('POST', l.path(`/expiry-runs/${id}/confirm?dryRun=true`), l.sa, { securityIds: [] })).status, id).toBe(404)
    }
  })

  it('applies every check to a percent-encoded path as decoded: 401, then the role, and 404 only for a caller who may use the route', async () => {
    const l = await harness()
    await runDaily(l)
    const status = async (method: string, path: string, identity: Record<string, string> | null, body?: unknown) => (await l.api(method, path, identity, body)).status
    // An org route whose run id is encoded (%6e is "n": "not-a-number" once decoded).
    const orgRoute = l.path('/expiry-runs/%6eot-a-number')
    expect(await status('GET', orgRoute, null)).toBe(401)
    expect(await status('GET', orgRoute, holder)).toBe(404) // the company is concealed from a holder
    expect(await status('GET', orgRoute, l.ro)).toBe(404)
    expect(await status('POST', l.path('/expiry-runs/%39%39/confirm?dryRun=true'), l.ro, { securityIds: [] })).toBe(403) // writes only
    expect(await status('POST', l.path('/expiry-runs/%39%39/confirm?dryRun=true'), l.sa, { securityIds: [] })).toBe(404) // "99", encoded
    // An administrator route: every caller without write access is refused before the encoded segment answers 404.
    const adminRoute = '/api/admin/orgs/%6eot-a-uuid/verify-ledger'
    expect(await status('POST', adminRoute, null)).toBe(401)
    expect(await status('POST', adminRoute, holder)).toBe(403)
    expect(await status('POST', adminRoute, l.ro)).toBe(403)
    expect(await status('POST', adminRoute, l.rw)).toBe(404)
    expect(await status('POST', adminRoute, l.sa)).toBe(404)
    // An encoded literal segment is the decoded route, with all of its checks: it never reaches anything else.
    const encoded = `/api/orgs/${l.orgId}/%65xpiry-runs`
    expect(await status('GET', encoded, null)).toBe(401)
    expect(await status('GET', encoded, holder)).toBe(404)
    expect(await getJson(l, l.ro, encoded)).toEqual(await getJson(l, l.ro, '/expiry-runs'))
  })

  it("proposes what the confirmation's dry run would cancel, and says so again after the ledger moves", async () => {
    const l = await harness()
    const runId = await runDaily(l)
    const detail = api.expiryRunDetailSchema.parse(await getJson(l, l.sa, `/expiry-runs/${runId}`))
    const byId = new Map(detail.proposals.map((proposal) => [proposal.displayId, proposal]))
    expect(byId.get('OPT-26')).toMatchObject({
      securityId: l.id('OPT-26'), family: 'EQUITY_COMPENSATION', holder: { stakeholderId: l.id('S27') }, quantity: '21250',
      reason: 'contractual_deadline', lastExerciseDate: '2027-01-01', effectiveDate: '2027-01-02',
      confirmable: { quantity: '21250', effectiveDate: '2027-01-02' },
    })
    const ids = detail.proposals.map((proposal) => proposal.securityId)
    const preview = await dryRun(l, runId, ids)
    detail.proposals.forEach((proposal, index) => {
      expect(preview.commands[index]!.transactions).toEqual([expect.objectContaining({
        securityId: proposal.securityId, quantity: proposal.confirmable!.quantity, effectiveDate: proposal.confirmable!.effectiveDate,
      })])
      expect(proposal.quantity).toBe(proposal.confirmable!.quantity)
    })
    // A waiver of 1,000 OPT-26 shares since the run: the proposal keeps what was proposed, `confirmable` follows the dry run.
    await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-26'), effectiveDate: '2027-01-02', quantity: '1000', reason: 'HOLDER_WAIVER', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-26',
    })
    const moved = api.expiryRunDetailSchema.parse(await getJson(l, l.sa, `/expiry-runs/${runId}`)).proposals.find((p) => p.displayId === 'OPT-26')!
    expect(moved).toMatchObject({ quantity: '21250', confirmable: { quantity: '20250', effectiveDate: '2027-01-02' } })
    const again = await dryRun(l, runId, [l.id('OPT-26')])
    expect(again.commands[0]!.transactions[0]).toMatchObject({ quantity: '20250', effectiveDate: '2027-01-02' })
    // Cancelled outright, nothing is left to expire: confirming it would be refused.
    await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-26'), effectiveDate: '2027-01-02', reason: 'HOLDER_WAIVER', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-26',
    })
    expect(api.expiryRunDetailSchema.parse(await getJson(l, l.sa, `/expiry-runs/${runId}`)).proposals.find((p) => p.displayId === 'OPT-26')!.confirmable).toBeNull()
  })

  it("shows the holder's name and e-mail to every administrator, the read-only EDITOR included", async () => {
    const l = await harness()
    const runId = await runDaily(l)
    const holderOf = async (identity: Record<string, string>) => api.expiryRunDetailSchema.parse(await getJson(l, identity, `/expiry-runs/${runId}`)).proposals.find((p) => p.displayId === 'OPT-26')!.holder
    const full = await holderOf(l.sa)
    expect(full).toEqual({ stakeholderId: l.id('S27'), name: expect.stringMatching(/\S/), email: 's27.holder@example.test' })
    expect(await holderOf(l.rw)).toEqual(full)
    expect(await holderOf(l.ro)).toEqual(full)
  })

  it('drops a confirmed run from the pending list and the dashboard, which shows the line only while a run is pending', async () => {
    const l = await harness()
    expect(attention(await getJson<api.DashboardResponse>(l, l.ro, '/dashboard'))).toBeUndefined()
    const runId = await runDaily(l)
    for (const identity of [l.sa, l.ro]) {
      expect(attention(await getJson<api.DashboardResponse>(l, identity, '/dashboard'))).toEqual({ kind: 'EXPIRY_RUN_TO_CONFIRM', count: 1, dueDate: null, href: '/expiry-runs' })
    }
    const ids = [l.id('OPT-9'), l.id('OPT-26')]
    const preview = await dryRun(l, runId, ids)
    const confirmed = await l.api('POST', l.path(`/expiry-runs/${runId}/confirm`), l.sa, {
      expectedLedgerSeq: preview.commands[0]!.ledgerSeq, securityIds: ids, switchToAutomatic: true,
      expectedEffectSha256s: Object.fromEntries(ids.map((id, index) => [id, preview.commands[index]!.effectSha256])),
    }, { 'Idempotency-Key': 'confirm-expiry-reads' })
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    expect((await getJson<api.ExpiryRunList>(l, l.ro, '/expiry-runs')).items).toEqual([])
    expect(attention(await getJson<api.DashboardResponse>(l, l.ro, '/dashboard'))).toBeUndefined()
    const detail = api.expiryRunDetailSchema.parse(await getJson(l, l.ro, `/expiry-runs/${runId}`))
    // The confirming administrator is named by their console name.
    expect(detail).toMatchObject({ state: 'confirmed', confirmedAt: l.clock.time, confirmedBy: 'Owner Example', confirmationStartedAt: l.clock.time })
    expect(detail.proposals.every((proposal) => proposal.confirmable === null)).toBe(true)
    expect(api.expiryRunDetailSchema.parse(await getJson(l, l.sa, `/expiry-runs/${runId}`)).confirmedBy).toBe('Owner Example')
  })

  it("follows a real partial confirmation: confirming while it's stopped, superseded once the next day's run takes over", async () => {
    const l = await harness()
    const runId = await runDaily(l)
    const ids = [l.id('OPT-9'), l.id('OPT-26')]
    const preview = await dryRun(l, runId, ids)
    const effects = Object.fromEntries(ids.map((id, index) => [id, preview.commands[index]!.effectSha256]))
    // The second expiry fails (another request holds its child key), after the first, OPT-9, has committed.
    await l.db.prepare(
      `INSERT INTO idempotency_keys
       (id, scope, actor, route, idem_key, request_sha256, response_status, response_body, created_at, console_organization_id)
       VALUES (?, ?, ?, ?, ?, ?, 200, '{}', ?, ?)`,
    ).bind(crypto.randomUUID(), l.orgId, OWNER_USER_ID,
      'POST /api/orgs/:orgId/expiry-runs/:runId/confirm', expiryKey('partial-confirmation', ids[1]!),
      '0'.repeat(64), l.clock.time, CONSOLE_ORGANIZATION_ID).run()
    const stopped = await l.api('POST', l.path(`/expiry-runs/${runId}/confirm`), l.sa, {
      expectedLedgerSeq: preview.commands[0]!.ledgerSeq, securityIds: ids, expectedEffectSha256s: effects, switchToAutomatic: true,
    }, { 'Idempotency-Key': 'partial-confirmation' })
    expect(stopped.status).toBe(409)

    // Between the attempts: the run is confirming, listed and on the dashboard. OPT-9 is done; OPT-26 matches the dry run.
    const between = api.expiryRunDetailSchema.parse(await getJson(l, l.sa, `/expiry-runs/${runId}`))
    expect(between).toMatchObject({ state: 'confirming', confirmationStartedAt: l.clock.time, confirmedAt: null })
    const byId = new Map(between.proposals.map((proposal) => [proposal.displayId, proposal]))
    expect(byId.get('OPT-9')!.confirmable).toBeNull()
    const rest = await dryRun(l, runId, [l.id('OPT-26')])
    expect(byId.get('OPT-26')!.confirmable).toEqual({ quantity: rest.commands[0]!.transactions[0]!.quantity, effectiveDate: rest.commands[0]!.transactions[0]!.effectiveDate })
    expect((await getJson<api.ExpiryRunList>(l, l.ro, '/expiry-runs')).items).toEqual([expect.objectContaining({ runId, state: 'confirming' })])
    expect(attention(await getJson<api.DashboardResponse>(l, l.ro, '/dashboard'))?.count).toBe(1)

    // The next day's processing re-proposes the remainder: the stopped run is superseded and the new one is pending.
    l.clock.time = Date.UTC(2027, 0, 3, 17)
    const next = await runDaily(l)
    expect(next).not.toBe(runId)
    expect((await getJson<api.ExpiryRunList>(l, l.ro, '/expiry-runs')).items).toEqual([{ runId: next, localDate: '2027-01-03', startedAt: Date.UTC(2027, 0, 3, 17), state: 'pending', proposalCount: 1 }])
    expect((await getJson<api.ExpiryRunDetail>(l, l.ro, `/expiry-runs/${runId}`)).state).toBe('superseded')

    // Confirming it, switching to automatic, clears the list and the dashboard; the stopped run stays superseded.
    const nextPreview = await dryRun(l, next, [l.id('OPT-26')])
    const confirmed = await l.api('POST', l.path(`/expiry-runs/${next}/confirm`), l.sa, {
      expectedLedgerSeq: nextPreview.commands[0]!.ledgerSeq, securityIds: [l.id('OPT-26')],
      expectedEffectSha256s: { [l.id('OPT-26')]: nextPreview.commands[0]!.effectSha256 }, switchToAutomatic: true,
    }, { 'Idempotency-Key': 'confirm-next-run' })
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    expect((await getJson<api.ExpiryRunList>(l, l.ro, '/expiry-runs')).items).toEqual([])
    expect(attention(await getJson<api.DashboardResponse>(l, l.ro, '/dashboard'))).toBeUndefined()
    expect((await getJson<api.ExpiryRunDetail>(l, l.ro, `/expiry-runs/${runId}`)).state).toBe('superseded')
    expect((await getJson<api.ExpiryRunDetail>(l, l.ro, `/expiry-runs/${next}`)).state).toBe('confirmed')
  })
})
