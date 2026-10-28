import { describe, expect, it, vi } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import { processDue as runDue } from '../../src/app/server/lib/ledger/daily.ts'
import { expiryKey } from '../../src/app/server/lib/ledger/workflow.ts'
import type { Acme } from '../shared/engine/fixtures/acme.ts'
import {
  OWNER,
  OWNER_USER_ID,
  CONSOLE_ORGANIZATION_ID,
  addDocument,
  addStakeholder,
  commit,
  batchIncludesSql,
  batchRaceInjector,
  count,
  errorOf,
  getJson,
  ledgerHarness,
  openTestApp,
  sendApi,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/**
 * Due ledger work, run on demand (`POST /api/orgs/:orgId/process-due`, and bounded on every dashboard load by a write
 * administrator): applying a due scheduled termination as the system, and expiring what is past its last exercise day —
 * report-only (an expiry run to confirm) until an administrator confirms it and switches to automatic. The org's local
 * date (America/Los_Angeles here) decides what is due; date-scoped receipt keys make every repeat safe.
 */

interface ProcessDueResult {
  localDate: string
  appliedTerminations: number
  expiredSecurities: number
  proposedExpirations: number
  remainingExpirations: number
  failures: number
}

async function processDue(l: LedgerHarness, identity = l.sa): Promise<ProcessDueResult> {
  const response = await l.api('POST', l.path('/process-due'), identity)
  const body = await response.json() as ProcessDueResult
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body
}

async function schedule(l: LedgerHarness, label: string, date: string, extra: Record<string, unknown> = {}): Promise<string> {
  const body = { stakeholderId: l.id(label), terminationDate: date, terminationType: 'voluntary', ...extra }
  const dry = await l.api('POST', l.path('/commands/schedule-termination?dryRun=true'), l.rw, body)
  const shown = await dry.json() as api.ScheduleTerminationResponse
  expect(dry.status, JSON.stringify(shown)).toBe(200)
  const response = await l.api('POST', l.path('/commands/schedule-termination'), l.rw, { ...body, expectedDiffSha256: shown.preview.diffSha256, acknowledge: [] })
  expect(response.status).toBe(200)
  return (await response.json() as api.ScheduleTerminationResponse).scheduledTerminationId!
}

/** The run pending confirmation (the newest report-only run). */
async function pendingRun(l: LedgerHarness): Promise<api.ExpiryRunSummary> {
  const list = await getJson<api.ExpiryRunList>(l, l.ro, '/expiry-runs')
  expect(list.items).toHaveLength(1)
  return list.items[0]!
}

/** The review of an expiry run: its dry run's head and each security's effect, as the real call sends them back. */
async function review(l: LedgerHarness, runId: number, securityIds: string[]): Promise<{ seq: number; effects: Record<string, string> }> {
  const response = await l.api('POST', l.path(`/expiry-runs/${runId}/confirm?dryRun=true`), l.sa, { securityIds })
  const body = await response.json() as api.ConfirmExpiryRunResponse
  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(body.commands.map((command) => command.dryRun)).toEqual(securityIds.map(() => true))
  return { seq: body.commands[0]!.ledgerSeq, effects: Object.fromEntries(securityIds.map((id, index) => [id, body.commands[index]!.effectSha256])) }
}

async function status(l: LedgerHarness, label: string): Promise<string> {
  return (await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id(label)}`)).status
}

/** S29 left on 2026-09-01: OPT-9's last exercise day was 2026-12-01; with OPT-26 (S27) a run proposes two expiries. */
const leaverS29 = (acme: Acme) => {
  acme.b.command('terminate:S29', (c) => {
    c.tx('X_STAKEHOLDER_TERMINATION', '2026-09-01', {
      stakeholder_id: acme.id('S29'), termination_date: '2026-09-01', termination_type: 'voluntary', vesting_stop_date: '2026-09-01',
      relationship_before: 'advisor', relationship_after: 'advisor',
    })
    c.tx('TX_EQUITY_COMPENSATION_CANCELLATION', '2026-09-01', { security_id: acme.id('OPT-47'), quantity: '30000', reason_text: 'Termination', x_reason: 'TERMINATION' })
  }, { type: 'terminate-stakeholder' })
}

const CONFIRM_ROUTE = 'POST /api/orgs/:orgId/expiry-runs/:runId/confirm'

/** Another request holding an expiry's child key: the confirmation stops there with 409. */
async function takeChildKey(l: LedgerHarness, key: string, securityId: string): Promise<void> {
  await l.db.prepare(
    `INSERT INTO idempotency_keys
     (id, scope, actor, route, idem_key, request_sha256, response_status, response_body, created_at, console_organization_id)
     VALUES (?, ?, ?, ?, ?, ?, 200, '{}', ?, ?)`,
  ).bind(crypto.randomUUID(), l.orgId, OWNER_USER_ID, CONFIRM_ROUTE, expiryKey(key, securityId),
    '0'.repeat(64), l.clock.time, CONSOLE_ORGANIZATION_ID).run()
}

describe('due ledger work, processed on demand', () => {
  it('applies a due scheduled termination as the system once its local date has come, and only once', async () => {
    const l = await ledgerHarness()
    const id = await schedule(l, 'S14', '2026-12-04')
    // 23:00 on Dec 3 in Los Angeles: nothing is due yet.
    l.clock.time = Date.UTC(2026, 11, 4, 7)
    expect(await processDue(l)).toMatchObject({ localDate: '2026-12-03', appliedTerminations: 0, failures: 0 })
    // 00:10 on Dec 4: the date has come (there is no start-of-day window without a scheduler).
    l.clock.time = Date.UTC(2026, 11, 4, 8, 10)
    expect(await processDue(l)).toMatchObject({ localDate: '2026-12-04', appliedTerminations: 1, failures: 0 })
    const row = await l.db.prepare('SELECT status, applied_command_id, version FROM scheduled_terminations WHERE id = ?').bind(id)
      .first<{ status: string; applied_command_id: string; version: number }>()
    expect(row).toMatchObject({ status: 'APPLIED', version: 2 })
    const command = await l.db.prepare('SELECT type, actor_kind, actor_user_id FROM commands WHERE id = ?').bind(row!.applied_command_id).first()
    expect(command).toEqual({ type: 'terminate-stakeholder', actor_kind: 'system', actor_user_id: null })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM transactions WHERE command_id = ? AND effective_date = '2026-12-04'", row!.applied_command_id)).toBe(4)
    expect(await l.db.prepare('SELECT relationship FROM stakeholders WHERE id = ?').bind(l.id('S14')).first('relationship')).toBe('ex_employee')
    const scheduled = (await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S14')}`)).scheduledTermination
    expect(scheduled ?? null).toBeNull()
    // Later calls the same day, or the next, find nothing left to do.
    l.clock.time += 3_600_000
    expect(await processDue(l)).toMatchObject({ appliedTerminations: 0, failures: 0 })
    l.clock.time += 86_400_000
    expect(await processDue(l)).toMatchObject({ appliedTerminations: 0, failures: 0 })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'terminate-stakeholder' AND actor_kind = 'system'")).toBe(1)
  })

  it('needs a write administrator', async () => {
    const l = await ledgerHarness()
    const response = await l.api('POST', l.path('/process-due'), l.ro)
    expect(response.status).toBe(403)
    expect(errorOf(await response.json()).code).toBe('forbidden')
  })

  it('keeps a termination that no longer validates scheduled, and reports and logs the failure', async () => {
    const l = await ledgerHarness()
    // Scheduled with an acceleration of OPT-54's 15,000 unvested options; then OPT-54 is cancelled before the date.
    const document = await addDocument(l.db, l.orgId, 'SEPARATION_AGREEMENT')
    const scheduledTerminationId = await schedule(l, 'S14', '2026-12-04', {
      accelerations: [{ securityId: l.id('OPT-54'), quantity: '15000', reason: 'Separation agreement', documentId: document }],
    })
    await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-54'), effectiveDate: '2026-10-21', reason: 'NOT_EXECUTED', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-54',
    })
    l.clock.time = Date.UTC(2026, 11, 4, 8, 30)
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let outcome: ProcessDueResult
    let lines: unknown[][]
    try {
      outcome = await processDue(l)
    } finally {
      lines = [...logged.mock.calls]
      logged.mockRestore()
    }
    expect(outcome).toMatchObject({ appliedTerminations: 0, failures: 1 })
    const failure = lines.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).find((line) => line.event === 'process_due_failures')
    expect(failure).toMatchObject({ orgId: l.orgId, localDate: '2026-12-04', failures: [{ kind: 'scheduled-termination', id: scheduledTerminationId, code: 'invariant_violation' }] })
    expect(await l.db.prepare('SELECT status FROM scheduled_terminations WHERE id = ?').bind(scheduledTerminationId).first('status')).toBe('SCHEDULED')
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'terminate-stakeholder' AND actor_kind = 'system'")).toBe(0)
  })

  it('runs the bounded processing on a write administrator\'s dashboard load, never on an EDITOR\'s', async () => {
    const l = await ledgerHarness()
    const id = await schedule(l, 'S14', '2026-12-04')
    l.clock.time = Date.UTC(2026, 11, 4, 8, 30)
    await getJson<api.DashboardResponse>(l, l.ro, '/dashboard')
    expect(await l.db.prepare('SELECT status FROM scheduled_terminations WHERE id = ?').bind(id).first('status')).toBe('SCHEDULED')
    await getJson<api.DashboardResponse>(l, l.rw, '/dashboard')
    expect(await l.db.prepare('SELECT status FROM scheduled_terminations WHERE id = ?').bind(id).first('status')).toBe('APPLIED')
    expect((await getJson<api.StakeholderDetail>(l, l.ro, `/stakeholders/${l.id('S14')}`)).relationship).toBe('ex_employee')
  })

  it.each([
    ['2027-03-01', Date.UTC(2027, 2, 1, 17)],
    ['2027-09-01', Date.UTC(2027, 8, 1, 16)],
    ['2028-06-01', Date.UTC(2028, 5, 1, 16)],
  ])('the dashboard proposes the same engine expirations as process-due on %s', async (_date, now) => {
    const l = await ledgerHarness({ now })
    await getJson<api.DashboardResponse>(l, l.sa, '/dashboard')
    const dashboardRun = await pendingRun(l)
    const dashboard = await getJson<api.ExpiryRunDetail>(l, l.sa, `/expiry-runs/${dashboardRun.runId}`)
    expect(dashboard.proposals).toHaveLength(2)

    await l.db.prepare('DELETE FROM expiry_runs WHERE org_id = ?').bind(l.orgId).run()
    const explicit = await processDue(l)
    const explicitRun = await pendingRun(l)
    const posted = await getJson<api.ExpiryRunDetail>(l, l.sa, `/expiry-runs/${explicitRun.runId}`)
    expect(explicit.proposedExpirations).toBe(dashboard.proposals.length)
    expect(posted.proposals.map((proposal) => proposal.securityId))
      .toEqual(dashboard.proposals.map((proposal) => proposal.securityId))
  })

  it('reports the first expiry run, lets an administrator confirm it and switch to automatic, then expires as the system', async () => {
    // 09:00 on Jan 2, 2027 in Los Angeles: OPT-26's last exercise day (S27's three months) was Jan 1.
    const l = await ledgerHarness({ now: Date.UTC(2027, 0, 2, 17) })
    expect(await processDue(l)).toMatchObject({ localDate: '2027-01-02', proposedExpirations: 1, expiredSecurities: 0, failures: 0 })
    const run = await pendingRun(l)
    expect(run).toMatchObject({ localDate: '2027-01-02', state: 'pending', proposalCount: 1 })
    const detail = await getJson<api.ExpiryRunDetail>(l, l.sa, `/expiry-runs/${run.runId}`)
    expect(detail.proposals).toMatchObject([
      { securityId: l.id('OPT-26'), displayId: 'OPT-26', quantity: '21250', lastExerciseDate: '2027-01-01', effectiveDate: '2027-01-02' },
    ])
    expect(await status(l, 'OPT-26')).toBe('OUTSTANDING')
    const attention = (await getJson<api.DashboardResponse>(l, l.sa, '/dashboard')).needsAttention.find((item) => item.kind === 'EXPIRY_RUN_TO_CONFIRM')
    expect(attention).toEqual({ kind: 'EXPIRY_RUN_TO_CONFIRM', count: 1, dueDate: null, href: '/expiry-runs' })
    // The dashboard's own processing re-proposed the same run: still one.
    expect((await pendingRun(l)).runId).toBe(run.runId)

    const { seq, effects } = await review(l, run.runId, [l.id('OPT-26')])
    const confirm = (identity: Record<string, string>, body: Record<string, unknown>, key?: string) =>
      l.api('POST', l.path(`/expiry-runs/${run.runId}/confirm`), identity, body, key ? { 'Idempotency-Key': key } : {})
    expect((await confirm(l.ro, { expectedLedgerSeq: seq, securityIds: [l.id('OPT-26')], expectedEffectSha256s: effects, switchToAutomatic: true })).status).toBe(403)
    const outside = await confirm(l.sa, { expectedLedgerSeq: seq, securityIds: [l.id('OPT-1')], expectedEffectSha256s: { [l.id('OPT-1')]: effects[l.id('OPT-26')] }, switchToAutomatic: false })
    expect(outside.status).toBe(422)
    expect(errorOf(await outside.json()).violations?.map((v) => v.code)).toEqual(['NOT_IN_EXPIRY_RUN'])
    const done = await confirm(l.sa, { expectedLedgerSeq: seq, securityIds: [l.id('OPT-26')], expectedEffectSha256s: effects, switchToAutomatic: true }, 'confirm-first-expiry-run')
    expect(done.status, await done.clone().text()).toBe(200)
    const body = await done.json() as api.ConfirmExpiryRunResponse
    expect(body).toMatchObject({ runId: run.runId, expiryMode: 'automatic', commands: [{ transactions: [{ type: 'TX_EQUITY_COMPENSATION_CANCELLATION', quantity: '21250', effectiveDate: '2027-01-02' }] }] })
    expect(await status(l, 'OPT-26')).toBe('EXPIRED')
    const replay = await confirm(l.sa, { expectedLedgerSeq: seq, securityIds: [l.id('OPT-26')], expectedEffectSha256s: effects, switchToAutomatic: true }, 'confirm-first-expiry-run')
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
    expect((await getJson<api.Org>(l, l.ro, l.path(''))).settings.expiry.mode).toBe('automatic')
    expect(await l.db.prepare("SELECT actor_kind, actor_user_id FROM commands WHERE type = 'expire-securities'").first()).toEqual({ actor_kind: 'user', actor_user_id: OWNER_USER_ID })
    expect((await getJson<api.DashboardResponse>(l, l.sa, '/dashboard')).needsAttention.find((item) => item.kind === 'EXPIRY_RUN_TO_CONFIRM')).toBeUndefined()

    // Automatic from now on: OPT-20's contractual deadline (2027-02-28, extended) passes and processing expires it.
    l.clock.time = Date.UTC(2027, 2, 1, 17)
    expect(await processDue(l)).toMatchObject({ expiredSecurities: 1, proposedExpirations: 0, failures: 0 })
    expect(await status(l, 'OPT-20')).toBe('EXPIRED')
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'expire-securities' AND actor_kind = 'system'")).toBe(1)
    expect((await getJson<api.ExpiryRunList>(l, l.ro, '/expiry-runs')).items).toEqual([])
  })

  it('does the work once when two calls run concurrently', async () => {
    const l = await ledgerHarness({ now: Date.UTC(2027, 0, 2, 17) })
    const id = await schedule(l, 'S14', '2027-01-03')
    // 01:00 on Jan 3 in Los Angeles: S14's termination is due and OPT-26 is past its last exercise day (report-only).
    l.clock.time = Date.UTC(2027, 0, 3, 9)
    const race = batchRaceInjector(l.db)
    let second: ProcessDueResult | undefined
    race.arm(async () => { second = await processDue(l) }, (statements) =>
      batchIncludesSql(statements, "UPDATE scheduled_terminations SET status = 'APPLIED'"))
    const first = await runDue(race.binding, l.config, l.orgId, 'America/Los_Angeles', l.clock.time)
    expect(race.injections()).toBe(1)
    // Without a scheduler there is no claim on the day: each call answers for itself, and a call that finds the work
    // just done by the other replays its receipt instead of doing it again or failing.
    for (const result of [first, second!]) expect(result).toMatchObject({ localDate: '2027-01-03', failures: 0, proposedExpirations: 1 })
    expect(Math.max(first.appliedTerminations, second!.appliedTerminations)).toBe(1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'terminate-stakeholder' AND actor_kind = 'system'")).toBe(1)
    expect(await count(l.db, 'SELECT COUNT(*) AS n FROM expiry_runs WHERE org_id = ?', l.orgId)).toBe(1)
    expect(await l.db.prepare('SELECT status, version FROM scheduled_terminations WHERE id = ?').bind(id).first()).toEqual({ status: 'APPLIED', version: 2 })
    expect(await processDue(l)).toMatchObject({ appliedTerminations: 0, proposedExpirations: 1, failures: 0 })
    expect(await count(l.db, 'SELECT COUNT(*) AS n FROM expiry_runs WHERE org_id = ?', l.orgId)).toBe(1)
  })

  it('caps automatic expiries per background load and reports the remainder', async () => {
    const l = await ledgerHarness({
      now: Date.UTC(2027, 0, 2, 17), extend: leaverS29, settings: { expiry: { mode: 'automatic' } },
    })
    const first = await runDue(l.db, l.config, l.orgId, 'America/Los_Angeles', l.clock.time, { automaticExpiryLimit: 1 })
    expect(first).toMatchObject({ expiredSecurities: 1, remainingExpirations: 1, failures: 0 })
    const second = await runDue(l.db, l.config, l.orgId, 'America/Los_Angeles', l.clock.time, { automaticExpiryLimit: 1 })
    expect(second).toMatchObject({ expiredSecurities: 1, remainingExpirations: 0, failures: 0 })
  })

  it('removes at most 100 staging chunks older than a day during due processing', async () => {
    const l = await ledgerHarness()
    const old = l.clock.time - 86_400_001
    await l.db.batch(Array.from({ length: 101 }, (_, index) => l.db.prepare(
      `INSERT INTO document_upload_chunks
       (org_id, document_id, chunk_index, bytes, created_at, console_organization_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(l.orgId, 'old-staging', index, new Uint8Array([index % 251]), old, CONSOLE_ORGANIZATION_ID)))
    await l.db.prepare(
      `INSERT INTO document_upload_chunks
       (org_id, document_id, chunk_index, bytes, created_at, console_organization_id) VALUES (?, ?, 0, ?, ?, ?)`,
    ).bind(l.orgId, 'fresh-staging', new Uint8Array([1]), l.clock.time, CONSOLE_ORGANIZATION_ID).run()
    await l.db.prepare(
      `INSERT INTO document_upload_chunks
       (org_id, document_id, chunk_index, bytes, created_at, console_organization_id) VALUES (?, ?, 0, ?, ?, ?)`,
    ).bind(l.orgId, 'foreign-staging', new Uint8Array([1]), old, 'console-org-2').run()

    await processDue(l)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_upload_chunks WHERE document_id = 'old-staging'")).toBe(1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_upload_chunks WHERE document_id = 'fresh-staging'")).toBe(1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_upload_chunks WHERE document_id = 'foreign-staging'")).toBe(1)
  })

  it("binds a confirmation's key to the run before its first expiry, so a retry resumes and nothing else can", async () => {
    const l = await ledgerHarness({ now: Date.UTC(2027, 0, 2, 17), extend: leaverS29 })
    expect(await processDue(l)).toMatchObject({ proposedExpirations: 2 })
    const run = await pendingRun(l)
    const ids = (await getJson<api.ExpiryRunDetail>(l, l.sa, `/expiry-runs/${run.runId}`)).proposals.map((proposal) => proposal.securityId)
    expect([...ids].sort()).toEqual([l.id('OPT-26'), l.id('OPT-9')].sort())
    const key = 'confirm-two-expiries'
    const { seq, effects } = await review(l, run.runId, ids)
    const body = { expectedLedgerSeq: seq, securityIds: ids, expectedEffectSha256s: effects, switchToAutomatic: false }
    const confirm = (payload: unknown, idempotencyKey = key) => l.api('POST', l.path(`/expiry-runs/${run.runId}/confirm`), l.sa, payload, { 'Idempotency-Key': idempotencyKey })
    const expired = () => count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'expire-securities'")

    // The second expiry fails (its child key is taken by another request): the first has committed.
    await takeChildKey(l, key, ids[1]!)
    const failed = await confirm(body)
    expect(failed.status).toBe(409)
    expect(await expired()).toBe(1)
    // Mid-way, the same key can't confirm anything else, and no other key can confirm this run.
    const other = await confirm({ ...body, securityIds: [ids[0]], expectedEffectSha256s: { [ids[0]!]: effects[ids[0]!] } })
    expect(errorOf(await other.json())).toMatchObject({ code: 'conflict', reason: 'idempotency_key_reused' })
    const rival = await confirm(body, 'another-confirmation-key')
    expect(errorOf(await rival.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })
    expect(await expired()).toBe(1)
    // Once the blocker is gone, the identical retry resumes: the first expiry replays, the second commits.
    await l.db.prepare('DELETE FROM idempotency_keys WHERE idem_key = ?').bind(expiryKey(key, ids[1]!)).run()
    const resumed = await confirm(body)
    expect(resumed.status, await resumed.clone().text()).toBe(200)
    expect((await resumed.json() as api.ConfirmExpiryRunResponse).commands).toHaveLength(2)
    expect(await expired()).toBe(2)
    const after = await confirm({ ...body, securityIds: [ids[0]], expectedEffectSha256s: { [ids[0]!]: effects[ids[0]!] } })
    expect(errorOf(await after.json()).reason).toBe('idempotency_key_reused')
  })

  it('holds every expiry to the effect the administrator reviewed, on the first attempt and on a resume', async () => {
    const l = await ledgerHarness({ now: Date.UTC(2027, 0, 2, 17), extend: leaverS29 })
    await processDue(l)
    const run = await pendingRun(l)
    const ids = [l.id('OPT-9'), l.id('OPT-26')]
    const confirm = (payload: unknown, key: string) => l.api('POST', l.path(`/expiry-runs/${run.runId}/confirm`), l.sa, payload, { 'Idempotency-Key': key })
    const cancelPart = async (label: string, quantity: string) => commit(l, l.rw, 'cancel-security', {
      securityId: l.id(label), effectiveDate: '2027-01-02', quantity, reason: 'HOLDER_WAIVER', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: label,
    })
    const expired = () => count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'expire-securities'")

    // The ledger changes between the review and the confirmation: OPT-26 loses 1,000 shares to a waiver.
    const reviewed = await review(l, run.runId, ids)
    await cancelPart('OPT-26', '1000')
    const stale = await confirm({ expectedLedgerSeq: reviewed.seq, securityIds: ids, expectedEffectSha256s: reviewed.effects, switchToAutomatic: false }, 'confirm-after-change')
    expect(errorOf(await stale.json()).reason).toBe('stale_ledger')
    // The new head with the old effects: OPT-9 still expires as reviewed, OPT-26 doesn't (409 state_changed).
    const head = (await l.db.prepare('SELECT seq FROM ledger_heads WHERE org_id = ?').bind(l.orgId).first<number>('seq'))!
    const refused = await confirm({ expectedLedgerSeq: head, securityIds: ids, expectedEffectSha256s: reviewed.effects, switchToAutomatic: false }, 'confirm-old-effects')
    expect(errorOf(await refused.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })
    expect(await expired()).toBe(1)
    // A resume can't commit it either while its effect differs (the next day's run proposes it again).
    const resumed = await confirm({ expectedLedgerSeq: head, securityIds: ids, expectedEffectSha256s: reviewed.effects, switchToAutomatic: false }, 'confirm-old-effects')
    expect(errorOf(await resumed.json()).reason).toBe('state_changed')
    expect(await expired()).toBe(1)
    expect(await status(l, 'OPT-26')).toBe('OUTSTANDING')
  })

  it('refuses a resumed expiry whose security changed after the first attempt', async () => {
    const l = await ledgerHarness({ now: Date.UTC(2027, 0, 2, 17), extend: leaverS29 })
    await processDue(l)
    const run = await pendingRun(l)
    const ids = [l.id('OPT-9'), l.id('OPT-26')]
    const reviewed = await review(l, run.runId, ids)
    const body = { expectedLedgerSeq: reviewed.seq, securityIds: ids, expectedEffectSha256s: reviewed.effects, switchToAutomatic: false }
    const send = () => l.api('POST', l.path(`/expiry-runs/${run.runId}/confirm`), l.sa, body, { 'Idempotency-Key': 'confirm-and-resume' })
    // The first attempt stops after OPT-9 (OPT-26's child key is taken), then OPT-26 changes, then the retry resumes.
    await takeChildKey(l, 'confirm-and-resume', ids[1]!)
    expect((await send()).status).toBe(409)
    await l.db.prepare('DELETE FROM idempotency_keys WHERE idem_key = ?').bind(expiryKey('confirm-and-resume', ids[1]!)).run()
    await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-26'), effectiveDate: '2027-01-02', quantity: '1000', reason: 'HOLDER_WAIVER', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-26',
    })
    const resume = await send()
    expect(errorOf(await resume.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'expire-securities'")).toBe(1)
  })
})

describe('the bound on one call', () => {
  it('applies at most 100 due terminations per call and the rest on the next', async () => {
    const { db } = await openTestApp(Date.UTC(2026, 9, 21, 20))
    const created = await sendApi('POST', '/api/orgs', OWNER, {
      orgKey: 'bounded-example', legalName: 'Bounded Example, Inc.', displayName: 'Bounded Example', timezone: 'UTC',
    })
    expect(created.status).toBe(201)
    const orgId = (await created.json() as { id: string }).id
    const ids: string[] = []
    for (let n = 0; n < 101; n += 1) {
      const stakeholderId = await addStakeholder(db, orgId, `bound:S${n}`, 'employee')
      const request = {
        stakeholderId, terminationDate: '2026-10-21', terminationType: 'voluntary', vestingStopDate: '2026-10-21',
        relationshipAfter: 'ex_employee', accelerations: [], deadlineExtensions: [], repurchaseDeadlines: [], documentIds: [],
      }
      const id = crypto.randomUUID()
      ids.push(id)
      await db.prepare(
        `INSERT INTO scheduled_terminations (id, org_id, stakeholder_id, termination_date, termination_type, vesting_stop_date, request,
           request_sha256, status, created_by, version, created_at, updated_at)
         VALUES (?, ?, ?, '2026-10-21', 'voluntary', '2026-10-21', ?, ?, 'SCHEDULED', ?, 1, ?, ?)`,
      ).bind(id, orgId, stakeholderId, JSON.stringify(request), '0'.repeat(64), OWNER_USER_ID, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 1)).run()
    }
    const run = async () => {
      const response = await sendApi('POST', `/api/orgs/${orgId}/process-due`, OWNER)
      expect(response.status).toBe(200)
      return response.json() as Promise<ProcessDueResult>
    }
    expect(await run()).toMatchObject({ appliedTerminations: 100, failures: 0 })
    expect(await count(db, "SELECT COUNT(*) AS n FROM scheduled_terminations WHERE status = 'SCHEDULED'")).toBe(1)
    expect(await run()).toMatchObject({ appliedTerminations: 1, failures: 0 })
    expect(await count(db, "SELECT COUNT(*) AS n FROM scheduled_terminations WHERE status = 'APPLIED'")).toBe(101)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM transactions WHERE org_id = ?', orgId)).toBe(101)
  }, 120_000)
})
