import { describe, expect, it } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import { planLeave } from '../../src/app/server/lib/ledger/commands/leave.ts'
import { planMarkExecuted, type MarkExecutedFields } from '../../src/app/server/lib/ledger/commands/mark-executed.ts'
import { planTermination } from '../../src/app/server/lib/ledger/commands/terminate.ts'
import { processDue } from '../../src/app/server/lib/ledger/daily.ts'
import { loadCommandContext, runCommand } from '../../src/app/server/lib/ledger/run.ts'
import { cancelScheduledTermination, scheduleTermination } from '../../src/app/server/lib/ledger/workflow.ts'
import { ledgerCache, loadLedger } from '../../src/app/server/lib/read/ledger.ts'
import {
  ADMIN_EMAIL,
  ADMIN_USER_ID,
  OWNER_EMAIL,
  OWNER_USER_ID,
  addDocument,
  batchIncludesSql,
  batchRaceInjector,
  concurrently,
  consoleActor,
  errorOf,
  ledgerHarness,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/**
 * Concurrent writes on one company at the same head: exactly one wins and the other gets 409
 * with nothing of it left behind; a same-key duplicate replays the winner's response; due processing and an
 * administrator cancelling the same scheduled termination never both win.
 */

const adminActor = consoleActor(ADMIN_USER_ID, ADMIN_EMAIL)
const ownerActor = consoleActor(OWNER_USER_ID, OWNER_EMAIL)
const TIMEZONE = 'America/Los_Angeles'

function post(l: LedgerHarness, suffix: string, body: unknown, key: string): () => Promise<Response> {
  return () => l.api('POST', l.path(suffix), l.rw, body, { 'Idempotency-Key': key })
}

async function reviewed(l: LedgerHarness, name: string, body: Record<string, unknown>) {
  const response = await l.api('POST', l.path(`/commands/${name}?dryRun=true`), l.rw, body)
  const preview = await response.json() as api.CommandResult
  expect(response.status, JSON.stringify(preview)).toBe(200)
  return { ...body, expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256, acknowledge: preview.warnings.map((w) => w.code) }
}

async function counts(l: LedgerHarness) {
  const row = await l.db.prepare(
    `SELECT (SELECT seq FROM ledger_heads WHERE org_id = ?1) AS seq,
            (SELECT COUNT(*) FROM commands WHERE org_id = ?1) AS commands,
            (SELECT COUNT(*) FROM idempotency_keys WHERE scope = ?1) AS receipts,
            (SELECT COUNT(*) FROM audit_events WHERE org_id = ?1 AND action LIKE 'command.%' AND result = 'success') AS audits`,
  ).bind(l.orgId).first<{ seq: number; commands: number; receipts: number; audits: number }>()
  return row!
}

function contextInput(l: LedgerHarness, actor = adminActor, db: D1Database = l.db) {
  return { db, now: l.clock.time, config: l.config, orgId: l.orgId, actor, source: 'app' as const }
}

const leaveOfS05 = (l: LedgerHarness) => ({ stakeholderId: l.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true, documentIds: [], acknowledge: [] })

async function scheduleS14(l: LedgerHarness): Promise<string> {
  const body = { stakeholderId: l.id('S14'), terminationDate: '2026-12-04', terminationType: 'voluntary' }
  const dry = await l.api('POST', l.path('/commands/schedule-termination?dryRun=true'), l.rw, body)
  const shown = await dry.json() as api.ScheduleTerminationResponse
  const scheduled = await l.api('POST', l.path('/commands/schedule-termination'), l.rw, { ...body, expectedDiffSha256: shown.preview.diffSha256, acknowledge: [] })
  expect(scheduled.status).toBe(200)
  return (await scheduled.json() as api.ScheduleTerminationResponse).scheduledTerminationId!
}

describe('ledger race suite', () => {
  it('lets exactly one of two commands reviewed at the same head win; the other gets 409 stale_ledger and leaves nothing', async () => {
    const l = await ledgerHarness()
    const terminate = await reviewed(l, 'terminate-stakeholder', { stakeholderId: l.id('S10'), terminationDate: '2026-10-21', terminationType: 'voluntary' })
    const leave = await reviewed(l, 'record-leave-of-absence', { stakeholderId: l.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true })
    const before = await counts(l)
    const responses = await concurrently([
      post(l, '/commands/terminate-stakeholder', terminate, 'race-terminate-s10'),
      post(l, '/commands/record-leave-of-absence', leave, 'race-leave-s05'),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const loser = responses.find((response) => response.status === 409)!
    expect(errorOf(await loser.json())).toMatchObject({ code: 'conflict', reason: 'stale_ledger' })
    const winner = await responses.find((response) => response.status === 200)!.json() as api.CommandResult
    const after = await counts(l)
    expect(after.seq).toBe(before.seq + winner.transactions.length)
    expect(after.commands).toBe(before.commands + 1)
    expect(after.receipts).toBe(before.receipts + 1)
    expect(after.audits).toBe(before.audits + 1)
  })

  it('rolls the losing batch back whole when both writers passed the head check (the trigger guard)', async () => {
    const l = await ledgerHarness()
    // Both read the same head before either commits.
    const first = await loadCommandContext(contextInput(l))
    const second = await loadCommandContext(contextInput(l))
    const before = await counts(l)
    await runCommand(first, {
      route: 'POST /api/orgs/:orgId/commands/record-leave-of-absence', path: '/race/leave', body: { n: 1 }, dryRun: false,
      idempotencyKey: 'trigger-guard-leave', expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [],
    }, (ctx) => planLeave(ctx, leaveOfS05(l)))
    await expect(runCommand(second, {
      route: 'POST /api/orgs/:orgId/commands/terminate-stakeholder', path: '/race/terminate', body: { n: 2 }, dryRun: false,
      idempotencyKey: 'trigger-guard-terminate', expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [], autoAcknowledge: true,
    }, (ctx) => planTermination(ctx, {
      stakeholderId: l.id('S10'), terminationDate: '2026-10-21', terminationType: 'voluntary', relationshipAfter: 'ex_employee',
      accelerations: [], deadlineExtensions: [], repurchaseDeadlines: [], documentIds: [],
    }, { kind: 'immediate' }))).rejects.toMatchObject({ code: 'conflict', extra: { reason: 'stale_ledger' } })
    const after = await counts(l)
    expect(after.seq).toBe(before.seq + 1)
    expect(after.commands).toBe(before.commands + 1)
    expect(after.receipts).toBe(before.receipts + 1)
    expect(after.audits).toBe(before.audits + 1)
    // The termination's workflow rows went with its batch.
    expect(await l.db.prepare('SELECT relationship FROM stakeholders WHERE id = ?').bind(l.id('S10')).first('relationship')).toBe('employee')
  })

  it('never stores a scheduled termination validated against a head a ledger command has since moved', async () => {
    const l = await ledgerHarness()
    const termination = {
      stakeholderId: l.id('S14'), terminationDate: '2026-12-04', terminationType: 'voluntary' as const, relationshipAfter: 'ex_employee' as const,
      accelerations: [], deadlineExtensions: [], repurchaseDeadlines: [], documentIds: [],
    }
    const route = 'POST /api/orgs/:orgId/commands/schedule-termination'
    // The schedule is reviewed and about to commit on the head it read...
    const stale = await loadCommandContext(contextInput(l))
    const preview = await scheduleTermination(stale, termination, {
      route, path: '/schedule', body: termination, dryRun: true, key: null, expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [],
    })
    const diff = (preview.body as api.ScheduleTerminationResponse).preview.diffSha256
    // ...when a ledger command commits first.
    await runCommand(await loadCommandContext(contextInput(l)), {
      route: 'POST /api/orgs/:orgId/commands/record-leave-of-absence', path: '/race/leave', body: { n: 1 }, dryRun: false,
      idempotencyKey: 'schedule-race-leave', expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [],
    }, (ctx) => planLeave(ctx, leaveOfS05(l)))
    // The public field is optional; the batch asserts the head the preview was computed on anyway.
    await expect(scheduleTermination(stale, termination, {
      route, path: '/schedule', body: termination, dryRun: false, key: 'schedule-race-key', expectedLedgerSeq: null, expectedDiffSha256: diff, acknowledge: [],
    })).rejects.toMatchObject({ code: 'conflict', extra: { reason: 'stale_ledger' } })
    expect(await l.db.prepare('SELECT COUNT(*) AS n FROM scheduled_terminations').first('n')).toBe(0)
    expect(await l.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE route = ?').bind(route).first('n')).toBe(0)
  })

  it('loads a ledger as one snapshot when a writer commits between the head check and the read', async () => {
    const l = await ledgerHarness()
    const writer = await loadCommandContext(contextInput(l))
    const before = writer.ledger.seq
    let fired = false
    // A binding whose first batch (the load's read) runs only after a ledger command commits.
    const racing = new Proxy(l.db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true
              await runCommand(writer, {
                route: 'POST /api/orgs/:orgId/commands/record-leave-of-absence', path: '/race/snapshot', body: { n: 1 }, dryRun: false,
                idempotencyKey: 'snapshot-race-leave', expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [],
              }, (ctx) => planLeave(ctx, leaveOfS05(l)))
            }
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    ledgerCache().clear()
    const loaded = (await loadLedger(racing, l.orgId))!
    expect(fired).toBe(true)
    // The ledger reports the head it was read with: the writer's, with its transaction.
    expect(loaded.seq).toBe(before + 1)
    expect(loaded.transactions).toHaveLength(loaded.seq)
    expect(loaded.headHash).toBe(await l.db.prepare('SELECT head_hash FROM ledger_heads WHERE org_id = ?').bind(l.orgId).first('head_hash'))
    expect(loaded.key).toContain(`|${before + 1}|`)
  })

  it("answers a concurrent same-key duplicate with the winner's stored response", async () => {
    const l = await ledgerHarness()
    const leave = await reviewed(l, 'record-leave-of-absence', { stakeholderId: l.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true })
    const before = await counts(l)
    const race = batchRaceInjector(l.db)
    const request = {
      route: 'POST /api/orgs/:orgId/commands/record-leave-of-absence', path: l.path('/commands/record-leave-of-absence'), body: leave,
      dryRun: false, idempotencyKey: 'same-key-leave-s05', expectedLedgerSeq: leave.expectedLedgerSeq,
      expectedDiffSha256: leave.expectedDiffSha256, acknowledge: leave.acknowledge,
    } as const
    const [firstContext, secondContext] = await Promise.all([
      loadCommandContext(contextInput(l, adminActor, race.binding)),
      loadCommandContext(contextInput(l, adminActor)),
    ])
    let winner: Awaited<ReturnType<typeof runCommand>> | undefined
    race.arm(async () => { winner = await runCommand(secondContext, request, (ctx) => planLeave(ctx, leaveOfS05(l))) })
    const replay = await runCommand(firstContext, request, (ctx) => planLeave(ctx, leaveOfS05(l)))
    expect(race.injections()).toBe(1)
    expect(winner?.replay).toBeNull()
    expect(replay.replay).not.toBeNull()
    expect(replay.result.commandId).toBe(winner?.result.commandId)
    const after = await counts(l)
    expect(after.commands).toBe(before.commands + 1)
    expect(after.receipts).toBe(before.receipts + 1)
  })

  it('forces both Mark executed batches to the commit boundary and rolls the loser back whole', async () => {
    const l = await ledgerHarness()
    const race = batchRaceInjector(l.db)
    const context = (actor: typeof adminActor) => loadCommandContext(contextInput(l, actor, race.binding))
    const [firstContext, secondContext] = await Promise.all([context(adminActor), context(ownerActor)])
    const body = async (): Promise<MarkExecutedFields> => ({
      securityId: l.id('OPT-51'), executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'),
      signatureDates: { company: '2026-10-20' }, attestation: 'This PDF bears both signatures', confirmation: 'OPT-51',
      documentIds: [], acknowledge: [],
    })
    const [a, b] = await Promise.all([body(), body()])
    const execute = (ctx: Awaited<ReturnType<typeof context>>, fields: MarkExecutedFields, key: string) => runCommand(ctx, {
      route: 'POST /api/orgs/:orgId/commands/mark-executed', path: l.path('/commands/mark-executed'), body: fields,
      dryRun: false, idempotencyKey: key, expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [],
    }, (current) => planMarkExecuted(current, fields, { confirm: true }))
    let winner: Awaited<ReturnType<typeof execute>> | undefined
    race.arm(async () => { winner = await execute(secondContext!, b, 'mark-executed-forced-b') })
    await expect(execute(firstContext!, a, 'mark-executed-forced-a')).rejects.toMatchObject({
      code: 'conflict', extra: { reason: 'stale_ledger' },
    })
    expect(winner?.result.commandId).toBeTruthy()
    expect(race.injections()).toBe(1)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'X_EXECUTION_STATUS' AND security_id = ? AND source = 'app'").bind(l.id('OPT-51')).first('n')).toBe(1)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type = 'mark-executed'").first('n')).toBe(1)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idem_key LIKE 'mark-executed-forced-%'").first('n')).toBe(1)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'command.mark-executed' AND result = 'success'").first('n')).toBe(1)
    expect(await l.db.prepare('SELECT COUNT(*) AS n FROM document_links WHERE document_id IN (?, ?)')
      .bind(a.executedAgreementDocumentId, b.executedAgreementDocumentId).first('n')).toBe(1)
    expect(await l.db.prepare('SELECT document_id FROM document_links WHERE document_id IN (?, ?)')
      .bind(a.executedAgreementDocumentId, b.executedAgreementDocumentId).first('document_id')).toBe(b.executedAgreementDocumentId)
  })

  it('runs due processing with the cancellation winning and rolls the apply back whole', async () => {
    const l = await ledgerHarness()
    const scheduledTerminationId = await scheduleS14(l)
    l.clock.time = Date.UTC(2026, 11, 4, 8, 30)
    const race = batchRaceInjector(l.db)
    const scheduledRow = await l.db.prepare('SELECT version FROM scheduled_terminations WHERE id = ?')
      .bind(scheduledTerminationId).first<{ version: number }>()
    const cancelContext = await loadCommandContext(contextInput(l, ownerActor))
    let cancel: Awaited<ReturnType<typeof cancelScheduledTermination>> | undefined
    race.arm(async () => {
      cancel = await cancelScheduledTermination(cancelContext, {
        scheduledTerminationId, version: scheduledRow!.version, note: 'Retention agreement signed',
      }, {
        route: 'POST /api/orgs/:orgId/commands/cancel-scheduled-termination',
        path: l.path('/commands/cancel-scheduled-termination'), key: 'forced-cancel-race',
      })
    }, (statements) => batchIncludesSql(statements, "UPDATE scheduled_terminations SET status = 'APPLIED'"))
    const outcome = await processDue(race.binding, l.config, l.orgId, TIMEZONE, l.clock.time)
    expect(outcome).toMatchObject({ localDate: '2026-12-04', appliedTerminations: 0, failures: 1 })
    expect(cancel?.body).toMatchObject({ status: 'CANCELLED' })
    expect(race.injections()).toBe(1)
    const row = await l.db.prepare('SELECT status, applied_command_id FROM scheduled_terminations WHERE id = ?').bind(scheduledTerminationId)
      .first<{ status: string; applied_command_id: string | null }>()
    expect(row!.status).toBe('CANCELLED')
    expect(row!.applied_command_id).toBeNull()
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type = 'terminate-stakeholder' AND actor_kind = 'system'").first('n')).toBe(0)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE command_id IN (SELECT id FROM commands WHERE type = 'terminate-stakeholder' AND actor_kind = 'system')").first('n')).toBe(0)
    expect(await l.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE idem_key = ?').bind(`system:terminate:${scheduledTerminationId}`).first('n')).toBe(0)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'command.terminate-stakeholder' AND actor_kind = 'system'").first('n')).toBe(0)
    expect(await l.db.prepare('SELECT relationship FROM stakeholders WHERE id = ?').bind(l.id('S14')).first('relationship')).toBe('employee')
  })

  it('runs due processing with the apply winning and rolls the cancellation back whole', async () => {
    const l = await ledgerHarness()
    const scheduledTerminationId = await scheduleS14(l)
    l.clock.time = Date.UTC(2026, 11, 4, 8, 30)
    const race = batchRaceInjector(l.db)
    const cancelContext = await loadCommandContext(contextInput(l, ownerActor, race.binding))
    let due: Awaited<ReturnType<typeof processDue>> | undefined
    race.arm(async () => {
      due = await processDue(l.db, l.config, l.orgId, TIMEZONE, l.clock.time)
    }, (statements) => batchIncludesSql(statements, "UPDATE scheduled_terminations SET status = 'CANCELLED'"))
    await expect(cancelScheduledTermination(cancelContext, {
      scheduledTerminationId, version: 1, note: 'Retention agreement signed',
    }, {
      route: 'POST /api/orgs/:orgId/commands/cancel-scheduled-termination',
      path: l.path('/commands/cancel-scheduled-termination'), key: 'forced-losing-cancel',
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(due).toMatchObject({ appliedTerminations: 1, failures: 0 })
    expect(race.injections()).toBe(1)
    expect(await l.db.prepare(
      'SELECT status, version, applied_command_id, cancelled_by, cancelled_at, cancel_note FROM scheduled_terminations WHERE id = ?',
    ).bind(scheduledTerminationId).first()).toEqual({
      status: 'APPLIED', version: 2, applied_command_id: expect.any(String),
      cancelled_by: null, cancelled_at: null, cancel_note: null,
    })
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE type = 'terminate-stakeholder' AND actor_kind = 'system'").first('n')).toBe(1)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idem_key = 'forced-losing-cancel'").first('n')).toBe(0)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'scheduled_termination.cancelled'").first('n')).toBe(0)
  })
})
