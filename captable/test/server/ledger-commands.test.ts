import { describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import type { Acme } from '../shared/engine/fixtures/acme.ts'
import { seedOrg } from '../support/read-helpers.ts'
import {
  ADMIN_EMAIL,
  ADMIN_USER_ID,
  OWNER_EMAIL,
  addDocument,
  addEmail,
  addStakeholder,
  batchIncludesSql,
  batchRaceInjector,
  commit,
  count,
  errorOf,
  getJson,
  headSeq,
  ledgerHarness,
  linkAdmin,
  runCommand,
  VS1_TEMPLATE_ID,
  withImportedRestrictedShares,
  withRestrictedShares,
  withRsuAndSar,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'
import { appRequestWithDatabase } from '../support/server-harness.ts'

/** The command routes that refuse an administrator's own holdings (403 self_dealing), each proven live below. */
const LEDGER_SELF_DEALING_ROUTE_IDS = [
  'terminateStakeholder', 'scheduleTermination', 'exerciseOption', 'grantEquityCompensation', 'cancelSecurity',
  'recordRepurchase', 'markExecuted', 'recordLeaveOfAbsence', 'extendExerciseDeadline', 'setPlanTerms', 'mergeStakeholders', 'reverseCommand',
] as const

/**
 * Every command through the public router (local D1) on the synthetic Acme org: the happy path, each product rule (a
 * 422 from the dry run, before anything is written), an idempotent retry and the conflicts.
 */

async function dryRun(l: LedgerHarness, identity: Record<string, string>, name: string, body: Record<string, unknown>) {
  const response = await l.api('POST', l.path(`/commands/${name}?dryRun=true`), identity, body)
  return { status: response.status, body: await response.json() as unknown }
}

async function violations(l: LedgerHarness, identity: Record<string, string>, name: string, body: Record<string, unknown>): Promise<string[]> {
  const { status, body: answer } = await dryRun(l, identity, name, body)
  expect(status, `${name}: ${JSON.stringify(answer)}`).toBe(422)
  expect(errorOf(answer).code).toBe('invariant_violation')
  return (errorOf(answer).violations ?? []).map((violation) => violation.code)
}

function terminationBody(l: LedgerHarness, label: string, extra: Record<string, unknown> = {}) {
  return { stakeholderId: l.id(label), terminationDate: '2026-10-21', terminationType: 'voluntary', ...extra }
}

async function exerciseBody(l: LedgerHarness, extra: Record<string, unknown> = {}) {
  return {
    securityId: l.id('OPT-1'),
    quantity: '10000',
    notice: { documentId: await addDocument(l.db, l.orgId, 'NOTICE_OF_EXERCISE'), receivedOn: '2026-10-20' },
    payment: { amount: '1000', receivedOn: '2026-10-20', method: 'ACH', reference: 'EX-OPT-1' },
    exerciseDate: '2026-10-20',
    fmv: { source: 'valuation', valuationId: l.id('V5') },
    tax: { treatment: 'W2' },
    resultingShares: [{ portion: 'ISO' }],
    ...extra,
  }
}

async function grantBody(l: LedgerHarness, extra: Record<string, unknown> = {}) {
  return {
    stockPlanId: l.id('plan:P1'),
    stakeholderId: l.id('S04'),
    quantity: '20000',
    board: { approvalDate: '2026-10-20', consentDocumentId: await addDocument(l.db, l.orgId, 'BOARD_CONSENT') },
    optionType: 'ISO',
    isoAttestations: { employeeAtGrant: true, tenPercentHolder: false },
    vesting: { terms: { templateId: VS1_TEMPLATE_ID }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true },
    exercisePrice: '0.95',
    valuationId: l.id('V5'),
    expirationDate: '2036-10-20',
    exemption: { federal: 'RULE_701' },
    executedAgreement: { documentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signedByHolderAndSignatory: true },
    ...extra,
  }
}

async function cancelBody(l: LedgerHarness, label: string, extra: Record<string, unknown> = {}) {
  return { securityId: l.id(label), effectiveDate: '2026-10-21', reason: 'HOLDER_WAIVER', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: label, ...extra }
}

const WINDOWS = [
  { reason: 'VOLUNTARY', period: '6', unit: 'MONTHS' },
  { reason: 'INVOLUNTARY', period: '6', unit: 'MONTHS' },
  { reason: 'WITH_CAUSE', period: '0', unit: 'DAYS' },
  { reason: 'DEATH', period: '12', unit: 'MONTHS' },
  { reason: 'DISABILITY', period: '12', unit: 'MONTHS' },
  { reason: 'RETIREMENT', period: '6', unit: 'MONTHS' },
]

async function planTermsBody(l: LedgerHarness, extra: Record<string, unknown> = {}) {
  return {
    stockPlanId: l.id('plan:P1'),
    effectiveDate: '2026-10-21',
    returnRules: { cancelledUnvestedAwards: 'RETURN', expiredVestedOptions: 'RETURN', repurchasedUnvestedShares: 'RETURN', repurchasedVestedShares: 'RETIRE', sharesWithheldForTax: 'RETIRE' },
    defaultTerminationWindows: WINDOWS,
    defaultRepurchaseWindow: { period: '90', unit: 'DAYS' },
    status: 'active',
    pourOverPlanId: null,
    documentId: await addDocument(l.db, l.orgId, 'PLAN_DOCUMENT'),
    note: 'Board amended the default exit windows',
    ...extra,
  }
}

describe('terminate-stakeholder', () => {
  it('cancels the unvested remainder, ends the relationship and audits it', async () => {
    const l = await ledgerHarness({ emails: { S10: 's10.home@example.test' } })
    const before = await headSeq(l)
    const result = await commit(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S10'))
    expect(result.dryRun).toBe(false)
    expect(result.ledgerSeq).toBe(before + 4)
    expect(result.dependencies.map((edge) => edge.kind)).toContain('consumes_security')
    expect(await headSeq(l)).toBe(before + 4)
    expect(await l.db.prepare('SELECT relationship, version FROM stakeholders WHERE id = ?').bind(l.id('S10')).first())
      .toEqual({ relationship: 'ex_employee', version: 2 })
    // The holder's own address stays: leaving no longer changes anyone's addresses.
    expect(await count(l.db, 'SELECT COUNT(*) AS n FROM stakeholder_emails WHERE stakeholder_id = ? AND removed_at IS NULL', l.id('S10'))).toBe(1)
    const command = await getJson<api.CommandDetail>(l, l.sa, `/commands/${result.commandId}`)
    expect(command).toMatchObject({ type: 'terminate-stakeholder', actorKind: 'user' })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'command.terminate-stakeholder' AND target_id = ?", l.id('S10'))).toBe(1)
    // The relationship the termination set changes only by reversing it.
    const relationship = await l.api('PATCH', l.path(`/stakeholders/${l.id('S10')}`), l.rw, { version: 2, relationship: 'employee' })
    expect(relationship.status).toBe(409)
    expect(errorOf(await relationship.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })
    const patchedResponse = await l.api('PATCH', l.path(`/stakeholders/${l.id('S10')}`), l.rw, {
      version: 2, displayName: 'Synthetic Former Holder S10',
    })
    expect(patchedResponse.status, await patchedResponse.clone().text()).toBe(200)
    const patched = await patchedResponse.json() as api.Stakeholder
    const read = await getJson<api.StakeholderDetail>(l, l.rw, `/stakeholders/${l.id('S10')}`)
    expect(patched).toMatchObject({
      termination: read.termination,
      scheduledTermination: read.scheduledTermination,
      leaveOfAbsence: read.leaveOfAbsence,
      portalState: read.portalState,
      emails: read.emails,
      totals: read.totals,
      provenance: { importedFromPulley: true, pulleyId: null },
    })
  })

  it('refuses each rule before writing anything', async () => {
    const l = await ledgerHarness()
    const before = await headSeq(l)
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S10', { terminationDate: '2026-11-01' }))).toContain('TERMINATION_DATE_IN_FUTURE')
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S10', { vestingStopDate: '2026-10-22' }))).toContain('VESTING_STOP_AFTER_TERMINATION')
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S20'))).toContain('ALREADY_TERMINATED')
    const document = await addDocument(l.db, l.orgId, 'SEPARATION_AGREEMENT')
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S10', {
      accelerations: [{ securityId: l.id('OPT-52'), quantity: '16000', reason: 'Separation agreement', documentId: document }],
    }))).toContain('ACCELERATION_EXCEEDS_UNVESTED')
    // Another holder's security is a 400; an unknown stakeholder a 404; a bad enum a 400.
    expect((await dryRun(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S12', { accelerations: [{ securityId: l.id('OPT-1'), quantity: '1', reason: 'x', documentId: document }] }))).status).toBe(400)
    expect((await dryRun(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S99'))).status).toBe(404)
    expect((await dryRun(l, l.rw, 'terminate-stakeholder', { ...terminationBody(l, 'S10'), terminationType: 'quit' })).status).toBe(400)
    // The removed future-access e-mail is no longer part of the command.
    expect((await dryRun(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S10', { futureAccessEmail: 's10.home@example.test' }))).status).toBe(400)
    expect(await headSeq(l)).toBe(before)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE org_id = ? AND actor_kind = 'user' AND created_at >= ?", l.orgId, l.clock.time)).toBe(0)
  })

  it("needs a restricted lot's repurchase deadline unless its agreement sets none", async () => {
    // Planless restricted lots (no plan default): one whose recorded right has no deadline, one with no terms at all.
    const restricted = (acme: Acme, label: string, holder: string, right: Record<string, unknown> | null) => {
      const { b, id, cls } = acme
      b.stakeholder(holder, 'employee', { countryOfResidence: 'US' })
      const vt = b.vestingTerms(`vt:${label}`, { type: 'EXPLICIT', events: [{ date: '2026-03-01', quantity: '500' }, { date: '2027-03-01', quantity: '500' }] })
      b.command(`issue:${label}`, (c) => {
        const lot = c.security(label, { family: 'STOCK', subtype: 'COMMON', stakeholderId: id(holder), stockClassId: cls.CS, stockPlanId: null, parentSecurityId: null })
        c.tx('TX_STOCK_ISSUANCE', '2025-03-01', {
          security_id: lot, custom_id: label, stakeholder_id: id(holder), stock_class_id: cls.CS, share_price: { amount: '0.01', currency: 'USD' },
          quantity: '1000', x_origin: 'PURCHASE', vesting_terms_id: vt.id, x_definition_sha256: vt.sha, ...(right ? { x_repurchase_right: right } : {}),
        })
      })
    }
    const l = await ledgerHarness({ extend: (acme) => {
      restricted(acme, 'CS-90', 'S44', { price_per_share: { amount: '0.01', currency: 'USD' }, window: null, x_no_deadline: true })
      restricted(acme, 'CS-91', 'S45', null)
    } })
    const dry = await dryRun(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S44'))
    expect(dry.status, JSON.stringify(dry.body)).toBe(200)
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S45'))).toContain('REPURCHASE_DEADLINE_NOT_RECORDED')
  })

  it('replays a retried key and refuses the key for a different request', async () => {
    const l = await ledgerHarness()
    const body = terminationBody(l, 'S10')
    const first = await runCommand(l, l.rw, 'terminate-stakeholder', body, { key: 'terminate-s10-intent-1' })
    expect(first.response.status).toBe(200)
    const headAfter = await headSeq(l)
    const retry = await l.api('POST', l.path('/commands/terminate-stakeholder'), l.rw, {
      ...body, expectedLedgerSeq: first.preview.ledgerSeq, expectedDiffSha256: first.preview.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': 'terminate-s10-intent-1' })
    expect(retry.status).toBe(200)
    expect(retry.headers.get('Idempotent-Replay')).toBe('true')
    expect((await retry.json() as api.CommandResult).commandId).toBe((first.body as api.CommandResult).commandId)
    expect(await headSeq(l)).toBe(headAfter)
    const reused = await l.api('POST', l.path('/commands/terminate-stakeholder'), l.rw, {
      ...body, terminationType: 'involuntary', expectedLedgerSeq: first.preview.ledgerSeq, expectedDiffSha256: first.preview.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': 'terminate-s10-intent-1' })
    expect(reused.status).toBe(409)
    expect(errorOf(await reused.json())).toMatchObject({ code: 'conflict', reason: 'idempotency_key_reused' })
    expect(await headSeq(l)).toBe(headAfter)
  })

  it('answers 409 when the head moved or the diff changed, with nothing written', async () => {
    const l = await ledgerHarness()
    const body = terminationBody(l, 'S10')
    const { body: preview } = await dryRun(l, l.rw, 'terminate-stakeholder', body)
    const head = (preview as api.CommandResult).ledgerSeq
    await commit(l, l.rw, 'record-leave-of-absence', { stakeholderId: l.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true })
    const stale = await l.api('POST', l.path('/commands/terminate-stakeholder'), l.rw, {
      ...body, expectedLedgerSeq: head, expectedDiffSha256: (preview as api.CommandResult).diffSha256, acknowledge: [],
    })
    expect(stale.status).toBe(409)
    expect(errorOf(await stale.json())).toMatchObject({ code: 'conflict', reason: 'stale_ledger' })
    const changed = await l.api('POST', l.path('/commands/terminate-stakeholder'), l.rw, {
      ...body, expectedLedgerSeq: head + 1, expectedDiffSha256: '0'.repeat(64), acknowledge: [],
    })
    expect(changed.status).toBe(409)
    expect(errorOf(await changed.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })
    expect(await headSeq(l)).toBe(head + 1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM idempotency_keys WHERE route = 'POST /api/orgs/:orgId/commands/terminate-stakeholder' AND actor = ?", ADMIN_USER_ID)).toBe(0)
  })

  it('needs an Idempotency-Key on a real call and none on a dry run', async () => {
    const l = await ledgerHarness()
    const body = terminationBody(l, 'S10')
    // The server reads a missing key as an empty one; sending it empty keeps the harness from adding its own.
    const noKey = { 'Idempotency-Key': '' }
    const response = await l.api('POST', l.path('/commands/terminate-stakeholder'), l.rw, {
      ...body, expectedLedgerSeq: 1, expectedDiffSha256: '0'.repeat(64),
    }, noKey)
    expect(response.status).toBe(400)
    expect(errorOf(await response.json()).code).toBe('validation_failed')
    const dry = await l.api('POST', l.path('/commands/terminate-stakeholder?dryRun=true'), l.rw, body, noKey)
    expect(dry.status).toBe(200)
    expect((await dry.json() as api.CommandResult).commandId).toBeNull()
  })
})

describe("correcting an ex-employee's relationship", () => {
  it('lets a record imported as an ex-employee without a termination be corrected, and refuses it once a termination is scheduled', async () => {
    const l = await ledgerHarness()
    // As an import leaves a holder listed as an ex-employee without a termination date.
    await l.db.prepare("UPDATE stakeholders SET relationship = 'ex_employee', version = version + 1 WHERE id = ?").bind(l.id('S10')).run()
    const version = (await l.db.prepare('SELECT version FROM stakeholders WHERE id = ?').bind(l.id('S10')).first<number>('version'))!
    const corrected = await l.api('PATCH', l.path(`/stakeholders/${l.id('S10')}`), l.rw, { version, relationship: 'employee' })
    expect(corrected.status, await corrected.clone().text()).toBe(200)
    expect(await corrected.json()).toMatchObject({ relationship: 'employee', version: version + 1 })
    const audit = await l.db.prepare("SELECT details FROM audit_events WHERE action = 'stakeholder.updated' AND target_id = ?").bind(l.id('S10')).first<string>('details')
    expect(JSON.parse(audit!)).toMatchObject({ fields: ['relationship'] })
    // Still never set to ex_employee here: a termination does that.
    expect((await l.api('PATCH', l.path(`/stakeholders/${l.id('S10')}`), l.rw, { version: version + 1, relationship: 'ex_employee' })).status).toBe(400)

    // A scheduled termination locks the ex-employee relationship (a recorded one does too: see terminate-stakeholder).
    await l.db.prepare("UPDATE stakeholders SET relationship = 'ex_employee', version = version + 1 WHERE id = ?").bind(l.id('S14')).run()
    await l.db.prepare(
      `INSERT INTO scheduled_terminations
       (id, org_id, stakeholder_id, termination_date, termination_type, vesting_stop_date, request, request_sha256, status, version, created_at, updated_at)
       VALUES (?, ?, ?, '2026-12-31', 'voluntary', '2026-12-31', '{}', ?, 'SCHEDULED', 1, ?, ?)`,
    ).bind(crypto.randomUUID(), l.orgId, l.id('S14'), 'ab'.repeat(32), l.clock.time, l.clock.time).run()
    const s14 = (await l.db.prepare('SELECT version FROM stakeholders WHERE id = ?').bind(l.id('S14')).first<number>('version'))!
    const locked = await l.api('PATCH', l.path(`/stakeholders/${l.id('S14')}`), l.rw, { version: s14, relationship: 'employee' })
    expect(locked.status).toBe(409)
    expect(errorOf(await locked.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })
    // Other fields of such a record still change.
    expect((await l.api('PATCH', l.path(`/stakeholders/${l.id('S14')}`), l.rw, { version: s14, displayName: 'Synthetic Holder S14 (leaving)' })).status).toBe(200)
  })

  it('answers stale_version, as any stale edit, when the record is edited between the correction\'s read and its commit', async () => {
    const l = await ledgerHarness()
    await l.db.prepare("UPDATE stakeholders SET relationship = 'ex_employee', version = version + 1 WHERE id = ?").bind(l.id('S10')).run()
    const version = (await l.db.prepare('SELECT version FROM stakeholders WHERE id = ?').bind(l.id('S10')).first<number>('version'))!
    const path = l.path(`/stakeholders/${l.id('S10')}`)
    const race = batchRaceInjector(l.db)
    let edited: Response | undefined
    race.arm(async () => {
      edited = await l.api('PATCH', path, l.sa, { version, displayName: 'Synthetic Holder S10 (renamed)' })
    }, (statements) => batchIncludesSql(statements, 'UPDATE stakeholders SET kind'))
    const corrected = await appRequestWithDatabase(race.binding, path, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ version, relationship: 'employee' }),
    }, l.rw)
    expect(race.injections()).toBe(1)
    expect(edited?.status).toBe(200)
    expect(corrected.status).toBe(409)
    expect(errorOf(await corrected.json())).toMatchObject({ code: 'conflict', reason: 'stale_version' })
    expect(await l.db.prepare('SELECT relationship FROM stakeholders WHERE id = ?').bind(l.id('S10')).first('relationship')).toBe('ex_employee')
  })
})

describe('warnings to acknowledge', () => {
  it('asks for the warning to be acknowledged, audits the refusal, then records it', async () => {
    const l = await ledgerHarness()
    const body = await exerciseBody(l, { payment: { amount: '1200', receivedOn: '2026-10-20', method: 'WIRE', reference: 'EX-OPT-1' } })
    const { body: preview } = await dryRun(l, l.rw, 'exercise-option', body)
    expect((preview as api.CommandResult).warnings.map((warning) => warning.code)).toEqual(['PAYMENT_EXCEEDS_COST'])
    const unacknowledged = await runCommand(l, l.rw, 'exercise-option', body, { acknowledge: [] })
    expect(unacknowledged.response.status).toBe(422)
    expect(errorOf(unacknowledged.body)).toMatchObject({ code: 'warnings_unacknowledged', warnings: [{ code: 'PAYMENT_EXCEEDS_COST' }] })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'command.rejected' AND reason = 'warnings_unacknowledged'")).toBe(1)
    const acknowledged = await runCommand(l, l.rw, 'exercise-option', body)
    expect(acknowledged.response.status).toBe(200)
    expect((acknowledged.body as api.CommandResult).warnings.map((warning) => warning.code)).toEqual(['PAYMENT_EXCEEDS_COST'])
  })
})

describe('schedule-termination and cancel-scheduled-termination', () => {
  it('schedules a future termination with its preview, blocks a second one and lets a write administrator cancel it', async () => {
    const l = await ledgerHarness()
    const body = { stakeholderId: l.id('S14'), terminationDate: '2026-12-04', terminationType: 'voluntary' }
    const dry = await l.api('POST', l.path('/commands/schedule-termination?dryRun=true'), l.rw, body)
    const preview = await dry.json() as api.ScheduleTerminationResponse
    expect(dry.status).toBe(200)
    expect(preview.scheduledTerminationId).toBeNull()
    // P7: 39,375 + 35,000 + 15,000 unvested cancelled on the date.
    const cancelled = preview.preview.transactions.filter((tx) => tx.type === 'TX_EQUITY_COMPENSATION_CANCELLATION').map((tx) => tx.quantity)
    expect(cancelled.sort()).toEqual(['15000', '35000', '39375'])
    const scheduled = await l.api('POST', l.path('/commands/schedule-termination'), l.rw, { ...body, expectedDiffSha256: preview.preview.diffSha256, acknowledge: [] })
    expect(scheduled.status, await scheduled.clone().text()).toBe(200)
    const stored = await scheduled.json() as api.ScheduleTerminationResponse
    expect(stored.scheduledTerminationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await l.db.prepare('SELECT status, termination_date FROM scheduled_terminations').first()).toEqual({ status: 'SCHEDULED', termination_date: '2026-12-04' })
    // Nothing is in the ledger yet; the stakeholder is "terminating" and a second termination is refused.
    const status = await getJson<api.SecuritiesStatus>(l, l.sa, '/securities-status')
    expect(status.scheduledTerminations).toMatchObject([{ stakeholderId: l.id('S14'), securitiesAffected: 3, unvestedToCancel: '89375' }])
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S14'))).toContain('ALREADY_TERMINATED')
    expect(await violations(l, l.rw, 'schedule-termination', { ...body, terminationDate: '2026-10-21' })).toContain('TERMINATION_DATE_NOT_IN_FUTURE')

    // A read-only custom role can't cancel; a write administrator cancels with the version it read; a stale version is refused.
    const cancelBodyFor = (version: number) => ({ scheduledTerminationId: stored.scheduledTerminationId, version, note: 'Retention agreement signed' })
    expect((await l.api('POST', l.path('/commands/cancel-scheduled-termination'), l.ro, cancelBodyFor(1))).status).toBe(403)
    const stale = await l.api('POST', l.path('/commands/cancel-scheduled-termination'), l.sa, cancelBodyFor(2))
    expect(stale.status).toBe(409)
    expect(errorOf(await stale.json()).reason).toBe('stale_version')
    const done = await l.api('POST', l.path('/commands/cancel-scheduled-termination'), l.sa, cancelBodyFor(1), { 'Idempotency-Key': 'cancel-scheduled-s14' })
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ status: 'CANCELLED', version: 2, cancelNote: 'Retention agreement signed' })
    const again = await l.api('POST', l.path('/commands/cancel-scheduled-termination'), l.sa, cancelBodyFor(1), { 'Idempotency-Key': 'cancel-scheduled-s14' })
    expect(again.headers.get('Idempotent-Replay')).toBe('true')
    const later = await l.api('POST', l.path('/commands/cancel-scheduled-termination'), l.sa, cancelBodyFor(2))
    expect(errorOf(await later.json()).reason).toBe('state_changed')
  })
})

describe('exercise-option', () => {
  it('records the exercise and its ISO share lot, with the notice linked', async () => {
    const l = await ledgerHarness({ emails: { S04: 's04.holder@example.test' } })
    const body = await exerciseBody(l, { resultingShares: [{ portion: 'ISO', displayId: 'CS-11' }] })
    const result = await commit(l, l.rw, 'exercise-option', body)
    expect(result.transactions.map((tx) => tx.type)).toEqual(['TX_EQUITY_COMPENSATION_EXERCISE', 'TX_STOCK_ISSUANCE'])
    expect(result.created.securityIds).toHaveLength(1)
    const lot = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${result.created.securityIds[0]}`)
    expect(lot).toMatchObject({ displayId: 'CS-11', family: 'STOCK', parentSecurityId: l.id('OPT-1'), numbers: { outstanding: '10000' } })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE role = 'NOTICE' AND security_id = ? AND document_id = ?",
      l.id('OPT-1'), (body.notice as { documentId: string }).documentId)).toBe(1)
    const option = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-1')}`)
    expect(option.numbers!.exercised).toBe('60000')
  })

  it('records an exercise of a grant awaiting only the company signatory, once its warning is acknowledged', async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        acme.b.command('pending:OPT-2', (c) => { c.tx('X_EXECUTION_STATUS', '2026-10-01', { security_id: acme.id('OPT-2'), status: 'pending_company' }) })
      },
    })
    const pending = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-2')}`)
    expect(pending.executionStatus).toBe('pending_company')
    expect(pending.numbers!.exercisable).not.toBe('0')
    const body = await exerciseBody(l, { securityId: l.id('OPT-2') })
    const preview = await dryRun(l, l.rw, 'exercise-option', body)
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect((preview.body as api.CommandResult).warnings).toEqual([
      expect.objectContaining({ code: 'EXECUTION_PENDING_COMPANY', details: expect.objectContaining({ securityId: l.id('OPT-2') }) }),
    ])
    // The warning must be acknowledged like any other.
    const unacknowledged = await runCommand(l, l.rw, 'exercise-option', body, { acknowledge: [] })
    expect(unacknowledged.response.status).toBe(422)
    expect(errorOf(unacknowledged.body).code).toBe('warnings_unacknowledged')
    const result = await commit(l, l.rw, 'exercise-option', await exerciseBody(l, { securityId: l.id('OPT-2') }))
    expect(result.transactions.map((tx) => tx.type)).toEqual(['TX_EQUITY_COMPENSATION_EXERCISE', 'TX_STOCK_ISSUANCE'])
    // Still awaiting the company signatory: Mark executed completes it later.
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-2')}`)).executionStatus).toBe('pending_company')
  })

  it('refuses each rule of a reported exercise', async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        // OPT-2 back to execution pending (its holder hasn't countersigned): exercise is blocked until marked executed.
        acme.b.command('pending:OPT-2', (c) => { c.tx('X_EXECUTION_STATUS', '2026-10-01', { security_id: acme.id('OPT-2'), status: 'pending_holder' }) })
      },
    })
    const v = async (extra: Record<string, unknown>) => violations(l, l.rw, 'exercise-option', await exerciseBody(l, extra))
    expect(await v({ exerciseDate: '2026-10-19' })).toContain('EXERCISE_DATE_MISMATCH')
    expect(await v({ exerciseDate: '2026-10-22', payment: { amount: '1000', receivedOn: '2026-10-22', method: 'ACH', reference: 'x' } })).toContain('EXERCISE_DATE_IN_FUTURE')
    expect(await v({ securityId: l.id('OPT-33'), payment: { amount: '9500', receivedOn: '2026-10-20', method: 'ACH', reference: 'x' } })).toContain('EXCEEDS_VESTED_UNEXERCISED')
    expect(await v({ securityId: l.id('OPT-39'), quantity: '40000', payment: { amount: '38000', receivedOn: '2026-10-20', method: 'ACH', reference: 'x' } })).toContain('EARLY_EXERCISE_NOT_IN_R1')
    expect(await v({ securityId: l.id('OPT-2') })).toContain('EXECUTION_PENDING')
    expect(await v({ securityId: l.id('OPT-5') })).toContain('SECURITY_NOT_OUTSTANDING')
    expect(await v({ payment: { amount: '999', receivedOn: '2026-10-20', method: 'ACH', reference: 'x' } })).toContain('PAYMENT_BELOW_COST')
    expect(await v({ fmv: { source: 'valuation', valuationId: l.id('V4') } })).toContain('NO_FMV_FOR_EXERCISE_DATE')
    expect(await v({ resultingShares: [{ portion: 'ISO', displayId: 'CS-1' }] })).toContain('DISPLAY_ID_TAKEN')
    expect(await v({ resultingShares: [{ portion: 'NSO' }] })).toContain('RESULTING_SHARES_PORTIONS')
    expect(await v({ securityId: l.id('OPT-9'), resultingShares: [{ portion: 'NSO' }] })).toContain('ZERO_WITHHOLDING_NEEDS_REASON')
    expect(await v({ tax: { treatment: 'NON_US' } })).toContain('NON_US_NOTE_REQUIRED')
    // Cross-field rules are 400s; an unknown option is a 404.
    const bad = await dryRun(l, l.rw, 'exercise-option', await exerciseBody(l, { payment: { amount: '1000', receivedOn: '2026-10-20', method: 'ACH', reference: 'x', payerIsHolder: false } }))
    expect(bad.status).toBe(400)
    expect((await dryRun(l, l.rw, 'exercise-option', await exerciseBody(l, { securityId: l.id('OPT-404') }))).status).toBe(404)
    expect((await dryRun(l, l.rw, 'exercise-option', await exerciseBody(l, { securityId: l.id('CS-1') }))).status).toBe(400)
  })

  it('warns on an overpayment and a third-party payer', async () => {
    const l = await ledgerHarness()
    const { body } = await dryRun(l, l.rw, 'exercise-option', await exerciseBody(l, {
      payment: { amount: '1200', receivedOn: '2026-10-20', method: 'WIRE', reference: 'x', payerIsHolder: false, payerNote: "Paid by the holder's spouse" },
    }))
    expect((body as api.CommandResult).warnings.map((w) => w.code).sort()).toEqual(['PAYER_NOT_HOLDER', 'PAYMENT_EXCEEDS_COST'])
  })

  it('records ISO shares exercised after the ISO deadline as NSO, with a warning', async () => {
    // OPT-20's ISO deadline is 2026-11-30 (three months after S21's termination); its contractual one, 2027-02-28.
    const late = await ledgerHarness({ now: Date.UTC(2026, 11, 10, 20) })
    const memo = await addDocument(late.db, late.orgId, 'VALUATION_SUPPORT')
    const answer = await dryRun(late, late.rw, 'exercise-option', await exerciseBody(late, {
      securityId: late.id('OPT-20'),
      notice: { documentId: await addDocument(late.db, late.orgId, 'NOTICE_OF_EXERCISE'), receivedOn: '2026-12-10' },
      payment: { amount: '3100', receivedOn: '2026-12-10', method: 'ACH', reference: 'x' },
      exerciseDate: '2026-12-10',
      fmv: { source: 'manual', pricePerShare: '0.95', sourceNote: 'Valuation in progress; the last price applies', documentId: memo },
      tax: { treatment: 'W2', zeroReason: 'Former employee, no payroll' },
      resultingShares: [{ portion: 'NSO' }],
    }))
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect((answer.body as api.CommandResult).warnings.map((w) => w.code)).toContain('ISO_PORTION_AFTER_ISO_DEADLINE')
  })

  it('refuses an exercise after the contractual deadline', async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        acme.b.command('terminate:S28', (c) => {
          c.tx('X_STAKEHOLDER_TERMINATION', '2026-05-01', {
            stakeholder_id: acme.id('S28'), termination_date: '2026-05-01', termination_type: 'voluntary', vesting_stop_date: '2026-05-01',
            relationship_before: 'advisor', relationship_after: 'advisor',
          })
          c.tx('TX_EQUITY_COMPENSATION_CANCELLATION', '2026-05-01', { security_id: acme.id('OPT-32'), quantity: '15000', reason_text: 'Termination', x_reason: 'TERMINATION' })
        }, { type: 'terminate-stakeholder' })
      },
    })
    const codes = await violations(l, l.rw, 'exercise-option', await exerciseBody(l, {
      securityId: l.id('OPT-4'),
      payment: { amount: '1000', receivedOn: '2026-10-20', method: 'ACH', reference: 'x' },
      tax: { treatment: 'FORM_1099_NEC' },
      resultingShares: [{ portion: 'NSO' }],
    }))
    expect(codes).toContain('AFTER_CONTRACTUAL_DEADLINE')
  })
})

describe('grant-equity-compensation', () => {
  it('records a signed grant with its own explicit schedule and links the consent and agreement', async () => {
    const l = await ledgerHarness()
    const body = await grantBody(l, {
      quantity: '1200',
      optionType: 'NSO',
      isoAttestations: undefined,
      vesting: { terms: { explicit: [{ date: '2027-10-20', quantity: '600' }, { date: '2028-10-20', quantity: '600' }] }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'DOUBLE_TRIGGER', percent: '100', months: 12 }, matchesSignedAgreement: true },
    })
    const result = await commit(l, l.rw, 'grant-equity-compensation', body)
    expect(result.created.vestingTermsIds).toHaveLength(1)
    const security = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${result.created.securityIds[0]}`)
    expect(security).toMatchObject({ displayId: 'OPT-57', subtype: 'OPTION_NSO', numbers: { outstanding: '1200', vested: '0' } })
    expect(security.terms.x_acceleration_terms).toEqual({ kind: 'DOUBLE_TRIGGER', percent: '100', months: 12 })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE security_id = ? AND role IN ('CONSENT', 'AGREEMENT')", result.created.securityIds[0])).toBe(2)
    const vesting = await getJson<api.SecurityVesting>(l, l.sa, `/securities/${result.created.securityIds[0]}/vesting`)
    expect(vesting.events.map((event) => [event.date, event.quantity])).toEqual([['2027-10-20', '600'], ['2028-10-20', '600']])
  })

  it('records a grant awaiting signatures as execution pending, the partly signed agreement as evidence', async () => {
    const l = await ledgerHarness()
    // An NSO vested at grant, so its exercise shows what the pending status allows.
    const vestedAtGrant = { terms: { explicit: [{ date: '2026-10-20', quantity: '1200' }] }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true }
    const nso = { quantity: '1200', optionType: 'NSO', isoAttestations: undefined, vesting: vestedAtGrant, executedAgreement: undefined }
    const holderSigned = await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT')
    const result = await commit(l, l.rw, 'grant-equity-compensation', await grantBody(l, {
      ...nso, displayId: 'OPT-70', awaitingSignatures: { missing: 'company', agreementDocumentId: holderSigned },
    }))
    expect(result.transactions.map((tx) => [tx.type, tx.effectiveDate])).toEqual([
      ['TX_EQUITY_COMPENSATION_ISSUANCE', '2026-10-20'], ['TX_VESTING_START', '2026-10-20'], ['X_EXECUTION_STATUS', '2026-10-20'],
    ])
    const companyPending = result.created.securityIds[0]!
    expect(await getJson<api.SecurityDetail>(l, l.sa, `/securities/${companyPending}`)).toMatchObject({ executionStatus: 'pending_company', numbers: { exercisable: '1200' } })
    // Evidence on the security and on the execution status, never the grant's agreement.
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'EVIDENCE' AND security_id = ?", holderSigned, companyPending)).toBe(1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'AGREEMENT'", holderSigned)).toBe(0)
    const payloads = (await l.db.prepare('SELECT type, payload FROM transactions WHERE command_id = ? ORDER BY seq').bind(result.commandId).all<{ type: string, payload: string }>()).results
    const issuance = JSON.parse(payloads[0]!.payload) as { x_documents: { id: string, role: string }[] }
    expect(issuance.x_documents.map((document) => document.role)).toEqual(['CONSENT'])
    expect(JSON.parse(payloads[2]!.payload)).toMatchObject({ security_id: companyPending, status: 'pending_company', attestation: 'Recorded before all signatures', document: { id: holderSigned } })
    // Awaiting only the company signatory, it can be exercised (with the warning acknowledged).
    const exercise = (securityId: string) => exerciseBody(l, {
      securityId, quantity: '1200', payment: { amount: '1140', receivedOn: '2026-10-20', method: 'ACH', reference: 'EX-OPT-70' }, resultingShares: [{ portion: 'NSO' }],
    })
    const exercised = await commit(l, l.rw, 'exercise-option', await exercise(companyPending))
    expect(exercised.warnings.map((warning) => warning.code)).toEqual(['EXECUTION_PENDING_COMPANY'])

    // Awaiting the holder (or both), it is blocked until Mark executed records the signatures; no agreement is needed yet.
    const pendingIds: string[] = []
    for (const [displayId, missing, status] of [['OPT-71', 'holder', 'pending_holder'], ['OPT-72', 'both', 'pending_both']] as const) {
      const pending = await commit(l, l.rw, 'grant-equity-compensation', await grantBody(l, { ...nso, displayId, awaitingSignatures: { missing } }))
      expect(pending.transactions.map((tx) => tx.type)).toEqual(['TX_EQUITY_COMPENSATION_ISSUANCE', 'TX_VESTING_START', 'X_EXECUTION_STATUS'])
      const id = pending.created.securityIds[0]!
      pendingIds.push(id)
      expect(await getJson<api.SecurityDetail>(l, l.sa, `/securities/${id}`)).toMatchObject({ executionStatus: status, numbers: { exercisable: '0' } })
      expect(await violations(l, l.rw, 'exercise-option', await exercise(id))).toContain('EXECUTION_PENDING')
    }
    const signed = await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT')
    await commit(l, l.rw, 'mark-executed', { securityId: pendingIds[0], executedAgreementDocumentId: signed, signatureDates: { holder: '2026-10-21' }, attestation: 'This PDF bears both signatures', confirmation: 'OPT-71' })
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${pendingIds[0]}`)).executionStatus).toBe('executed')
    await commit(l, l.rw, 'exercise-option', await exercise(pendingIds[0]!).then((body) => ({ ...body, notice: { ...body.notice, receivedOn: '2026-10-21' }, payment: { ...body.payment, receivedOn: '2026-10-21' }, exerciseDate: '2026-10-21' })))
  })

  it("warns of a grant dated before the company's incorporation, without blocking it", async () => {
    const l = await ledgerHarness()
    const warnings = async () => ((await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l))).body as api.CommandResult).warnings
    expect(await warnings()).toEqual([])
    await l.db.prepare("UPDATE orgs SET incorporation_date = '2026-10-21', version = version + 1 WHERE id = ?").bind(l.orgId).run()
    expect(await warnings()).toEqual([{ code: 'GRANT_BEFORE_INCORPORATION', message: "The grant date 2026-10-20 is before the company's incorporation on 2026-10-21", details: { incorporationDate: '2026-10-21' } }])
    // Acknowledged, it records.
    const result = await commit(l, l.rw, 'grant-equity-compensation', await grantBody(l))
    expect(result.warnings.map((warning) => warning.code)).toEqual(['GRANT_BEFORE_INCORPORATION'])
    await l.db.prepare("UPDATE orgs SET incorporation_date = '2026-10-20', version = version + 1 WHERE id = ?").bind(l.orgId).run()
    expect(await warnings()).toEqual([])
  })

  it('needs exactly one of the executed agreement and the signatures awaited, and the holder-signed agreement when only the company signs later', async () => {
    const l = await ledgerHarness()
    const status = async (extra: Record<string, unknown>) => (await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, extra))).status
    expect(await status({ executedAgreement: undefined })).toBe(400)
    expect(await status({ awaitingSignatures: { missing: 'both' } })).toBe(400)
    expect(await status({ executedAgreement: undefined, awaitingSignatures: { missing: 'company' } })).toBe(400)
    expect(await status({ executedAgreement: undefined, awaitingSignatures: { missing: 'both' } })).toBe(200)
    // The board consent, the 409A and the plan's availability still block a grant awaiting signatures.
    const awaiting = { executedAgreement: undefined, awaitingSignatures: { missing: 'holder' } }
    expect(await violations(l, l.rw, 'grant-equity-compensation', await grantBody(l, { ...awaiting, valuationId: l.id('V4') }))).toContain('NO_PRESUMPTIVELY_VALID_409A')
    expect(await violations(l, l.rw, 'grant-equity-compensation', await grantBody(l, { ...awaiting, quantity: '500000' }))).toContain('EXCEEDS_PLAN_AVAILABLE')
    expect(await violations(l, l.rw, 'grant-equity-compensation', await grantBody(l, { ...awaiting, stakeholderId: l.id('S28') }))).toContain('ISO_NOT_EMPLOYEE')
    expect((await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, { executedAgreement: undefined, awaitingSignatures: { missing: 'company', agreementDocumentId: l.id('doc:none') } }))).status).toBe(404)
  })

  it("refuses each grant rule, and lets a write administrator override a missing 409A only with counsel's memo", async () => {
    const l = await ledgerHarness()
    const v = async (extra: Record<string, unknown>, identity = l.rw) => violations(l, identity, 'grant-equity-compensation', await grantBody(l, extra))
    expect(await v({ quantity: '500000' })).toContain('EXCEEDS_PLAN_AVAILABLE')
    expect(await v({ valuationId: l.id('V4') })).toContain('NO_PRESUMPTIVELY_VALID_409A')
    expect(await v({ exercisePrice: '0.5' })).toContain('ISO_PRICE_BELOW_FMV')
    expect(await v({ isoAttestations: { employeeAtGrant: true, tenPercentHolder: true } })).toContain('ISO_TEN_PERCENT_TERMS')
    expect(await v({ stakeholderId: l.id('S28') })).toContain('ISO_NOT_EMPLOYEE')
    expect(await v({ exemption: { federal: 'NON_US' } })).toContain('NON_US_NEEDS_COUNTRY')
    expect(await v({ displayId: 'OPT-1' })).toContain('DISPLAY_ID_TAKEN')
    expect(await v({ vesting: { terms: { explicit: [{ date: '2027-10-20', quantity: '100' }] }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true } })).toContain('EXPLICIT_SUM_MISMATCH')
    expect(await v({ optionType: 'NSO', isoAttestations: undefined, exercisePrice: '0.5' })).toContain('NSO_PRICE_BELOW_FMV')
    const consent = await addDocument(l.db, l.orgId, 'BOARD_CONSENT')
    await l.db.prepare('UPDATE documents SET archived_at = ?, version = version + 1 WHERE id = ?').bind(l.clock.time, consent).run()
    expect(await v({ board: { approvalDate: '2026-10-20', consentDocumentId: consent } })).toContain('MISSING_BOARD_CONSENT')
    // Every write administrator may override with counsel's memo (there is no separate super-administrator any more);
    // a read-only custom role can't even preview a grant.
    const memo = await addDocument(l.db, l.orgId, 'COUNSEL_MEMO')
    for (const identity of [l.rw, l.sa]) {
      const override = await dryRun(l, identity, 'grant-equity-compensation', await grantBody(l, { valuationId: l.id('V4'), exercisePrice: '0.95', counselMemoDocumentId: memo }))
      expect(override.status, JSON.stringify(override.body)).toBe(200)
    }
    expect((await dryRun(l, l.ro, 'grant-equity-compensation', await grantBody(l, { valuationId: l.id('V4'), counselMemoDocumentId: memo }))).status).toBe(403)
    // An NSO below FMV with the memo is a warning to acknowledge.
    const nso = await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, { optionType: 'NSO', isoAttestations: undefined, exercisePrice: '0.5', counselMemoDocumentId: memo }))
    expect((nso.body as api.CommandResult).warnings.map((w) => w.code)).toEqual(['NSO_PRICE_BELOW_FMV'])
    await l.db.prepare("UPDATE stock_plans SET expiration_date = '2026-01-01', version = version + 1 WHERE id = ?").bind(l.id('plan:P1')).run()
    expect(await v({})).toContain('PLAN_EXPIRED')
    // 400 for a missing ISO attestation and a non-template schedule; 404 for unknown references.
    expect((await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, { isoAttestations: undefined }))).status).toBe(400)
    expect((await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, { vesting: { terms: { templateId: l.id('vt:OPT-1') }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true } }))).status).toBe(400)
    expect((await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, { stakeholderId: l.id('S404') }))).status).toBe(404)
    expect((await dryRun(l, l.rw, 'grant-equity-compensation', await grantBody(l, { executedAgreement: { documentId: l.id('doc:none'), signedByHolderAndSignatory: true } }))).status).toBe(404)
  })
})

describe('cancel-security', () => {
  it("cancels a warrant and returns an option's unvested shares to the pool", async () => {
    const l = await ledgerHarness()
    const warrant = await commit(l, l.rw, 'cancel-security', await cancelBody(l, 'WAR-1', { reason: 'MUTUAL_AGREEMENT' }))
    expect(warrant.transactions).toMatchObject([{ type: 'TX_WARRANT_CANCELLATION', quantity: '60000' }])
    const before = await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')
    await commit(l, l.rw, 'cancel-security', await cancelBody(l, 'OPT-55', { reason: 'NOT_EXECUTED' }))
    const after = await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')
    expect(BigInt(after.metrics.planAvailable) - BigInt(before.metrics.planAvailable)).toBe(10000n)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-55')}`)).status).toBe('CANCELLED')
  })

  it('refuses shares, closed lots, future dates, excess quantities and a wrong confirmation', async () => {
    const l = await ledgerHarness()
    expect(await violations(l, l.rw, 'cancel-security', await cancelBody(l, 'CS-1'))).toContain('NOT_OPTION_OR_WARRANT')
    expect(await violations(l, l.rw, 'cancel-security', await cancelBody(l, 'OPT-5'))).toContain('SECURITY_NOT_OUTSTANDING')
    expect(await violations(l, l.rw, 'cancel-security', await cancelBody(l, 'OPT-55', { effectiveDate: '2026-11-01' }))).toContain('EFFECTIVE_DATE_IN_FUTURE')
    expect(await violations(l, l.rw, 'cancel-security', await cancelBody(l, 'OPT-55', { quantity: '10001' }))).toContain('EXCEEDS_OUTSTANDING')
    const wrong = await runCommand(l, l.rw, 'cancel-security', await cancelBody(l, 'OPT-55', { confirmation: 'OPT-56' }))
    expect(wrong.response.status).toBe(400)
    expect(errorOf(wrong.body).code).toBe('validation_failed')
  })
})

/** The unvested quantity Securities Status shows for a terminated holder's restricted lot (the engine's figure). */
async function unvestedOf(l: LedgerHarness, label: string): Promise<string> {
  const status = await getJson<api.SecuritiesStatus>(l, l.sa, '/securities-status')
  return status.unvestedSharesFromTerminated.find((row) => row.securityId === l.id(label))!.unvested
}

async function repurchaseBody(l: LedgerHarness, label: string, extra: Record<string, unknown> = {}) {
  return {
    securityId: l.id(label),
    effectiveDate: '2026-10-20',
    quantity: label === 'CS-4' ? '34500' : '1000',
    pricePerShare: label === 'CS-4' ? '0.31' : '0.5',
    consideration: { method: 'CHECK', paidDate: '2026-10-20', reference: 'Check 1042' },
    noticeDocumentId: await addDocument(l.db, l.orgId, 'OTHER'),
    confirmation: label,
    ...extra,
  }
}

describe('record-repurchase', () => {
  it('repurchases every unvested share of CS-4 and moves the vested remainder to a balance lot, with the gross capital unchanged', async () => {
    const l = await ledgerHarness()
    // CS-4: 72,000 early-exercised shares vesting from 2024-08-15; S24 left on 2026-09-15 with 37,500 vested.
    expect(await unvestedOf(l, 'CS-4')).toBe('34500')
    const before = await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')
    const body = await repurchaseBody(l, 'CS-4')
    const result = await commit(l, l.rw, 'record-repurchase', body, { key: 'repurchase-cs-4' })
    expect(result.transactions).toMatchObject([
      { type: 'TX_STOCK_REPURCHASE', effectiveDate: '2026-10-20', securityId: l.id('CS-4'), quantity: '34500' },
      { type: 'TX_STOCK_ISSUANCE', effectiveDate: '2026-10-20', quantity: '37500' },
    ])
    expect(result.warnings).toEqual([])
    // It relies on the lot, and on the termination that opened the window.
    expect(result.dependencies).toEqual(expect.arrayContaining([
      { commandId: l.id('command:exercise:OPT-17'), kind: 'consumes_security' },
      { commandId: l.id('command:terminate:S24'), kind: 'relies_on_deadline' },
    ]))
    const [balanceId] = result.created.securityIds
    const source = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('CS-4')}`)
    expect(source).toMatchObject({ status: 'REPURCHASED', numbers: { outstanding: '0', repurchased: '34500' } })
    expect(source.lineage.children).toContainEqual({ id: balanceId, displayId: 'CS-9', transactionType: 'TX_STOCK_REPURCHASE' })
    const balance = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${balanceId}`)
    expect(balance).toMatchObject({ displayId: 'CS-9', status: 'OUTSTANDING', stakeholderId: l.id('S24'), stockPlanId: l.id('plan:P1'), parentSecurityId: l.id('CS-4') })
    expect(balance.numbers).toMatchObject({ outstanding: '37500', vested: '37500', unvested: '0' })
    // The lot's price and holding start, and nothing of its economics: no vesting, repurchase right or contribution.
    expect(balance.terms).toEqual({
      security_id: balanceId, custom_id: 'CS-9', stakeholder_id: l.id('S24'), stock_class_id: l.id('class:CS'), stock_plan_id: l.id('plan:P1'),
      share_price: { amount: '0.31', currency: 'USD' }, quantity: '37500', x_holding_start_date: '2024-09-01', x_origin: 'BALANCE',
      x_source_security_id: l.id('CS-4'),
    })
    const after = await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')
    expect(after.metrics.capitalContribution).toBe(before.metrics.capitalContribution)
    expect(after.metrics.issuedAndOutstanding).toBe(String(BigInt(before.metrics.issuedAndOutstanding) - 34500n))
    // Plan stock repurchased unvested returns to the pool (the plan's rule).
    expect(BigInt(after.metrics.planAvailable) - BigInt(before.metrics.planAvailable)).toBe(34500n)
    // The payment and the notice are on the chain, with the notice's hash; the notice is linked to the lot.
    const tx = (await getJson<{ items: api.Transaction[] }>(l, l.sa, `/transactions?securityId=${l.id('CS-4')}`)).items.find((item) => item.type === 'TX_STOCK_REPURCHASE')!
    const notice = await l.db.prepare('SELECT sha256 FROM documents WHERE id = ?').bind(body.noticeDocumentId).first<string>('sha256')
    expect(tx.payload).toMatchObject({
      price: { amount: '0.31', currency: 'USD' }, x_kind: 'UNVESTED', x_consideration: { amount: '10695', currency: 'USD' }, balance_security_id: balanceId,
      x_payment: { method: 'CHECK', paid_date: '2026-10-20', reference: 'Check 1042' }, x_notice: { id: body.noticeDocumentId, sha256: notice },
    })
    expect('x_authority_document' in tx.payload).toBe(false)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'NOTICE' AND security_id = ?", body.noticeDocumentId, l.id('CS-4'))).toBe(1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'command.record-repurchase' AND target_id = ?", l.id('CS-4'))).toBe(1)
    expect((await getJson<api.SecuritiesStatus>(l, l.sa, '/securities-status')).unvestedSharesFromTerminated.map((row) => row.securityId)).not.toContain(l.id('CS-4'))
    const timeline = await getJson<{ items: api.TimelineEntry[] }>(l, l.sa, `/securities/${l.id('CS-4')}/timeline`)
    expect(timeline.items.map((entry) => entry.summary)).toEqual(expect.arrayContaining(['Shares repurchased (34500)', 'Shares issued (37500)']))
    // The same intent again replays the recorded answer.
    const replay = await l.api('POST', l.path('/commands/record-repurchase'), l.rw, {
      ...body, expectedLedgerSeq: result.ledgerSeq - 2, expectedDiffSha256: result.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': 'repurchase-cs-4' })
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
  })

  it("carries the lot's descriptive terms to the balance lot, and leaves none when nothing vested", async () => {
    const l = await ledgerHarness({ extend: withRestrictedShares })
    await commit(l, l.rw, 'terminate-stakeholder', { stakeholderId: l.id('S41'), terminationDate: '2026-08-01', terminationType: 'voluntary' })
    // RS-1 vested 1,200 at the cliff and 100 a month after it: 1,900 on 2026-08-01.
    expect(await unvestedOf(l, 'RS-1')).toBe('2900')
    const rs1 = await commit(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'RS-1', { effectiveDate: '2026-09-15', quantity: '2900', pricePerShare: '1' }))
    const balance = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${rs1.created.securityIds[0]}`)
    expect(balance.terms).toMatchObject({
      quantity: '1900', share_price: { amount: '1', currency: 'USD' }, stock_legend_ids: [l.id('legend:RS-1')], issuance_type: 'RSA',
      board_approval_date: '2024-12-20', x_exemption: { federal: 'RULE_701' }, x_holding_start_date: '2024-12-31', x_origin: 'BALANCE',
    })
    for (const key of ['vesting_terms_id', 'x_definition_sha256', 'x_repurchase_right', 'x_capital_contribution', 'stock_plan_id']) expect(key in balance.terms, key).toBe(false)
    expect(balance).toMatchObject({ boardApprovalDate: '2024-12-20', exemption: { federal: 'RULE_701' } })

    // RS-2 vested nothing before S42 left: all 1,000 shares go and no balance lot is made. With no deadline recorded,
    // it is recorded on counsel's authority.
    const rs2 = await commit(l, l.sa, 'record-repurchase', await repurchaseBody(l, 'RS-2', { authorityDocumentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO') }))
    expect(rs2.transactions.map((tx) => tx.type)).toEqual(['TX_STOCK_REPURCHASE'])
    expect(rs2.created.securityIds).toEqual([])
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('RS-2')}`))).toMatchObject({ status: 'REPURCHASED', numbers: { outstanding: '0' } })
  })

  it('refuses a price whose total for the unvested shares needs more than 12 decimal places, saying so', async () => {
    // A company counting tenths of a share: RS-6 leaves 500.5 shares unvested when S49 leaves on 2026-08-01.
    const l = await ledgerHarness({ shareUnit: '0.1', extend: (acme) => {
      const { b, id, cls } = acme
      b.stakeholder('S49', 'employee', { countryOfResidence: 'US' })
      const vt = b.vestingTerms('vt:RS-6', { type: 'EXPLICIT', events: [{ date: '2026-03-01', quantity: '500' }, { date: '2027-03-01', quantity: '500.5' }] })
      b.command('issue:RS-6', (c) => {
        const lot = c.security('RS-6', { family: 'STOCK', subtype: 'COMMON', stakeholderId: id('S49'), stockClassId: cls.CS, stockPlanId: null, parentSecurityId: null })
        c.tx('TX_STOCK_ISSUANCE', '2025-03-01', {
          security_id: lot, custom_id: 'RS-6', stakeholder_id: id('S49'), stock_class_id: cls.CS, share_price: { amount: '0.01', currency: 'USD' }, quantity: '1000.5',
          x_origin: 'RSA', vesting_terms_id: vt.id, x_definition_sha256: vt.sha,
        })
      })
      b.command('terminate:S49', (c) => {
        c.tx('X_STAKEHOLDER_TERMINATION', '2026-08-01', {
          stakeholder_id: id('S49'), termination_date: '2026-08-01', termination_type: 'voluntary', vesting_stop_date: '2026-08-01',
          relationship_before: 'employee', relationship_after: 'ex_employee',
        })
      }, { type: 'terminate-stakeholder' })
    } })
    expect(await unvestedOf(l, 'RS-6')).toBe('500.5')
    // 500.5 × 0.123456789013 has 13 decimal places; one fewer in the price fits.
    const body = await repurchaseBody(l, 'RS-6', { quantity: '500.5', pricePerShare: '0.123456789013', authorityDocumentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO') })
    expect(await violations(l, l.sa, 'record-repurchase', body)).toContain('REPURCHASE_TOTAL_TOO_PRECISE')
    expect((await dryRun(l, l.sa, 'record-repurchase', { ...body, pricePerShare: '0.12345678901' })).status).toBe(200)
  })

  it("refuses a partial or excess quantity, a holder not terminated by the date, and a lot that isn't restricted shares", async () => {
    const l = await ledgerHarness({ extend: withRestrictedShares })
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { quantity: '34499' }))).toEqual(['REPURCHASE_NOT_ALL_UNVESTED'])
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { quantity: '34501' }))).toContain('REPURCHASE_NOT_ALL_UNVESTED')
    // S24 left on 2026-09-15: a repurchase is dated on or after it; S41 hasn't left.
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { effectiveDate: '2026-09-14' }))).toContain('REPURCHASE_BEFORE_TERMINATION')
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'RS-1', { quantity: '2900', pricePerShare: '1' }))).toContain('HOLDER_NOT_TERMINATED')
    // Exercise shares without vesting, an option, and a founder lot fully vested before anyone left.
    for (const label of ['CS-7', 'OPT-1', 'PS-9']) {
      expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, label)), label).toEqual(['NOT_RESTRICTED_STOCK'])
    }
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-1'))).toEqual(expect.arrayContaining(['HOLDER_NOT_TERMINATED', 'NO_UNVESTED_SHARES']))
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { effectiveDate: '2026-11-01', consideration: { method: 'WIRE', paidDate: '2026-11-01' } })))
      .toEqual(expect.arrayContaining(['EFFECTIVE_DATE_IN_FUTURE', 'PAID_DATE_IN_FUTURE']))
    const wrong = await runCommand(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { confirmation: 'CS-5' }))
    expect(wrong.response.status).toBe(400)
    expect(errorOf(wrong.body).code).toBe('validation_failed')
    // A read-only role records nothing.
    expect((await dryRun(l, l.ro, 'record-repurchase', await repurchaseBody(l, 'CS-4'))).status).toBe(403)
  })

  it("needs counsel's authority after the deadline, a document of its own, and a warning acknowledged for it", async () => {
    const l = await ledgerHarness({ extend: withRestrictedShares })
    await commit(l, l.rw, 'terminate-stakeholder', { stakeholderId: l.id('S41'), terminationDate: '2026-08-01', terminationType: 'voluntary' })
    // RS-1's 60-day right ended on 2026-09-30.
    const late = await repurchaseBody(l, 'RS-1', { effectiveDate: '2026-10-15', quantity: '2900', pricePerShare: '1' })
    const authority = await addDocument(l.db, l.orgId, 'COUNSEL_MEMO')
    // Without the authority it is refused, and the violation says what is needed; the engine refuses the late repurchase too.
    const refused = await dryRun(l, l.rw, 'record-repurchase', late)
    expect(refused.status).toBe(422)
    expect(errorOf(refused.body).violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REPURCHASE_AUTHORITY_REQUIRED', securityId: l.id('RS-1'), override: { role: 'admin_rw', requires: ['authorityDocumentId'] } }),
    ]))
    expect(await violations(l, l.sa, 'record-repurchase', late)).toEqual(expect.arrayContaining(['REPURCHASE_AUTHORITY_REQUIRED', 'REPURCHASE_AFTER_DEADLINE']))
    // The notice doesn't stand for counsel's authority: that is a document of its own.
    const notice = await dryRun(l, l.sa, 'record-repurchase', { ...late, authorityDocumentId: late.noticeDocumentId })
    expect(notice.status).toBe(422)
    expect(errorOf(notice.body).violations).toEqual([
      expect.objectContaining({ code: 'REPURCHASE_AUTHORITY_REQUIRED', message: expect.stringContaining('not the repurchase notice') }),
    ])
    // Within the window it needs no authority.
    expect((await dryRun(l, l.rw, 'record-repurchase', { ...late, effectiveDate: '2026-09-30' })).status).toBe(200)
    // Anyone who records changes (full access) records it late with the authority, once the warning is acknowledged.
    const shown = await dryRun(l, l.rw, 'record-repurchase', { ...late, authorityDocumentId: authority })
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect((shown.body as api.CommandResult).warnings.map((warning) => warning.code)).toEqual(['REPURCHASE_AFTER_DEADLINE'])
    const unacknowledged = await l.api('POST', l.path('/commands/record-repurchase'), l.rw, {
      ...late, authorityDocumentId: authority, expectedLedgerSeq: (shown.body as api.CommandResult).ledgerSeq, expectedDiffSha256: (shown.body as api.CommandResult).diffSha256,
    }, { 'Idempotency-Key': 'late-repurchase-unacknowledged' })
    expect(errorOf(await unacknowledged.json()).code).toBe('warnings_unacknowledged')
    const result = await commit(l, l.rw, 'record-repurchase', { ...late, authorityDocumentId: authority })
    const tx = (await getJson<{ items: api.Transaction[] }>(l, l.sa, `/transactions?securityId=${l.id('RS-1')}`)).items.find((item) => item.type === 'TX_STOCK_REPURCHASE')!
    expect(tx.payload.x_authority_document).toEqual({ id: authority, sha256: expect.any(String) })
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'EVIDENCE' AND security_id = ?", authority, l.id('RS-1'))).toBe(1)
    expect(result.commandId).toBeTruthy()
  })

  it("needs counsel's authority when no deadline is recorded", async () => {
    const l = await ledgerHarness({ extend: withRestrictedShares })
    const body = await repurchaseBody(l, 'RS-2')
    const authority = await addDocument(l.db, l.orgId, 'COUNSEL_MEMO')
    expect(await violations(l, l.rw, 'record-repurchase', body)).toEqual(['REPURCHASE_AUTHORITY_REQUIRED'])
    expect(await violations(l, l.sa, 'record-repurchase', body)).toEqual(['REPURCHASE_AUTHORITY_REQUIRED'])
    const shown = await dryRun(l, l.rw, 'record-repurchase', { ...body, authorityDocumentId: authority })
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect((shown.body as api.CommandResult).warnings.map((warning) => warning.code)).toEqual(['REPURCHASE_WITHOUT_DEADLINE'])
  })

  it("records a lot whose agreement sets no deadline without counsel's authority", async () => {
    const l = await ledgerHarness({ extend: withImportedRestrictedShares })
    const body = await repurchaseBody(l, 'RS-3', { quantity: '500', pricePerShare: '0.01' })
    const shown = await dryRun(l, l.rw, 'record-repurchase', body)
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect((shown.body as api.CommandResult).warnings).toEqual([])
    const result = await commit(l, l.rw, 'record-repurchase', body)
    expect(result.transactions.map((tx) => tx.type)).toEqual(['TX_STOCK_REPURCHASE', 'TX_STOCK_ISSUANCE'])
  })

  it("shows an imported lot's legends and missing board approval on its balance lot, which can't carry them", async () => {
    const l = await ledgerHarness({ extend: withImportedRestrictedShares, emails: { S47: 's47.holder@example.test' } })
    const result = await commit(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'RS-4', { quantity: '500', pricePerShare: '0.01' }))
    const [balanceId] = result.created.securityIds
    // The ledger is unchanged: the balance lot's own issuance has neither field.
    const balance = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${balanceId}`)
    for (const key of ['x_legends', 'x_board_approval_not_recorded_in_pulley', 'board_approval_date']) expect(key in balance.terms, key).toBe(false)
    // Read, it follows the lot it was split from: the legend snapshot, and "not recorded in the import".
    expect(balance).toMatchObject({ parentSecurityId: l.id('RS-4'), boardApprovalDate: null, boardApprovalNotRecordedInPulley: true })
    expect(balance.legends).toEqual([{ id: l.id('legend:RS-4'), name: 'Synthetic restriction legend' }])
    // So the securities list (which Compliance's checks read) puts it on the ratification list with its parent.
    const listed = (await getJson<{ items: api.Security[] }>(l, l.sa, '/securities')).items.filter((item) => item.boardApprovalNotRecordedInPulley).map((item) => item.id)
    expect(listed).toEqual(expect.arrayContaining([l.id('RS-4'), balanceId]))
    // The holder's share detail (as the admin previews it) names the legend too.
    const preview = await getJson<api.PortalSecurityDetail>(l, l.sa, `/stakeholders/${l.id('S47')}/preview/securities/${balanceId}`)
    expect(preview.detail).toMatchObject({ family: 'STOCK', legends: ['Synthetic restriction legend'] })
    // An imported balance lot shows what the import recorded for it.
    expect(await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('RS-5')}`)).toMatchObject({ boardApprovalDate: '2025-02-20' })
    expect(await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('RS-5B')}`)).toMatchObject({ parentSecurityId: l.id('RS-5'), boardApprovalDate: null, boardApprovalNotRecordedInPulley: false })
  })

  it("warns when the price differs from the lot's recorded repurchase price", async () => {
    const l = await ledgerHarness()
    const shown = await dryRun(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { pricePerShare: '0.25' }))
    expect(shown.status).toBe(200)
    expect((shown.body as api.CommandResult).warnings).toEqual([expect.objectContaining({ code: 'REPURCHASE_PRICE_DIFFERS', details: expect.objectContaining({ recorded: '0.31', entered: '0.25' }) })])
  })

  it("refuses another company's document and an archived one", async () => {
    const l = await ledgerHarness()
    const otherOrg = '00000000-0000-4000-8000-0000000000b2'
    await seedOrg(l.db, otherOrg, 'other-co', 'active', 'console-org-other')
    const foreign = await addDocument(l.db, otherOrg, 'OTHER')
    expect((await dryRun(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { noticeDocumentId: foreign }))).status).toBe(404)
    expect((await dryRun(l, l.sa, 'record-repurchase', await repurchaseBody(l, 'CS-4', { authorityDocumentId: foreign }))).status).toBe(404)
    const archived = await addDocument(l.db, l.orgId, 'OTHER')
    await l.db.prepare('UPDATE documents SET archived_at = ?, version = version + 1 WHERE id = ?').bind(l.clock.time, archived).run()
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { noticeDocumentId: archived }))).toEqual(['DOCUMENT_ARCHIVED'])
  })

  it('judges a backdated repurchase on the ledger of its date, and refuses one before a later fact on the lot', async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        // Counsel's later reading of S24's agreement, recorded on 2026-10-10: the right lasts until 2026-11-30.
        acme.b.command('deadline:CS-4', (c) => {
          c.tx('X_SECURITY_MODIFICATION', '2026-10-10', { kind: 'REPURCHASE_DEADLINE', security_id: acme.id('CS-4'), last_repurchase_date: '2026-11-30' })
        })
      },
    })
    // Before the recorded deadline change, the lot is closed by the repurchase: the later change would act on a closed lot.
    expect(await violations(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { effectiveDate: '2026-10-01', consideration: { method: 'ACH', paidDate: '2026-10-01' } }))).toContain('SECURITY_NOT_OUTSTANDING')
    // Plan terms recorded since: repurchased unvested shares are now retired. A repurchase dated before them follows the
    // rule in force on its date and returns the shares to the pool.
    await commit(l, l.sa, 'set-plan-terms', await planTermsBody(l, {
      returnRules: { cancelledUnvestedAwards: 'RETURN', expiredVestedOptions: 'RETURN', repurchasedUnvestedShares: 'RETIRE', repurchasedVestedShares: 'RETIRE', sharesWithheldForTax: 'RETIRE' },
    }))
    const before = await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')
    const backdated = await commit(l, l.rw, 'record-repurchase', await repurchaseBody(l, 'CS-4', { effectiveDate: '2026-10-15', consideration: { method: 'ACH', paidDate: '2026-10-16' } }))
    expect(backdated.transactions[0]).toMatchObject({ type: 'TX_STOCK_REPURCHASE', effectiveDate: '2026-10-15', quantity: '34500' })
    const after = await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')
    expect(BigInt(after.metrics.planAvailable) - BigInt(before.metrics.planAvailable)).toBe(34500n)
    expect(backdated.dependencies).toContainEqual({ commandId: l.id('command:deadline:CS-4'), kind: 'relies_on_deadline' })
  })
})

describe("award types outside the options and warrants", () => {
  it("refuses to cancel or extend an RSU or a SAR, and a termination's extension of a share lot", async () => {
    const l = await ledgerHarness({ extend: withRsuAndSar })
    for (const label of ['RSU-1', 'SAR-1']) {
      expect(await violations(l, l.rw, 'cancel-security', await cancelBody(l, label)), label).toContain('NOT_OPTION_OR_WARRANT')
      const extension = { securityId: l.id(label), newContractualDeadline: '2030-01-01', documentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO'), note: 'x', confirmation: label }
      expect(await violations(l, l.sa, 'extend-exercise-deadline', extension), label).toContain('NOT_OPTION_OR_WARRANT')
    }
    const document = await addDocument(l.db, l.orgId, 'SEPARATION_AGREEMENT')
    expect(await violations(l, l.rw, 'terminate-stakeholder', terminationBody(l, 'S04', {
      deadlineExtensions: [{ securityId: l.id('CS-7'), newContractualDeadline: '2027-06-30', documentId: document }],
    }))).toContain('NOT_OPTION_OR_WARRANT')
  })
})

describe('mark-executed', () => {
  it('marks a pending grant executed, which unblocks its exercise', async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        acme.b.command('pending:OPT-2', (c) => { c.tx('X_EXECUTION_STATUS', '2026-10-01', { security_id: acme.id('OPT-2'), status: 'pending_holder' }) })
      },
    })
    const exercise = await exerciseBody(l, { securityId: l.id('OPT-2') })
    expect(await violations(l, l.rw, 'exercise-option', exercise)).toContain('EXECUTION_PENDING')
    const document = await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT')
    const result = await commit(l, l.rw, 'mark-executed', { securityId: l.id('OPT-2'), executedAgreementDocumentId: document, signatureDates: { company: '2026-10-20', holder: '2026-10-19' }, attestation: 'This PDF bears both signatures', confirmation: 'OPT-2' })
    expect(result.transactions).toMatchObject([{ type: 'X_EXECUTION_STATUS', effectiveDate: '2026-10-20' }])
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'AGREEMENT'", document)).toBe(1)
    const executed = await commit(l, l.rw, 'exercise-option', await exerciseBody(l, { securityId: l.id('OPT-2') }))
    expect(executed.dependencies).toContainEqual({ commandId: result.commandId, kind: 'relies_on_terms' })
  })

  it("records one party's signature on a grant awaiting both, then the other's, each from its own date", async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        acme.b.command('pending:OPT-2', (c) => { c.tx('X_EXECUTION_STATUS', '2026-10-01', { security_id: acme.id('OPT-2'), status: 'pending_both' }) })
      },
    })
    const body = async (signed: string, signatureDates: Record<string, string>, attestation: string) => ({
      securityId: l.id('OPT-2'), signed, executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signatureDates, attestation, confirmation: 'OPT-2',
    })
    const holderSigned = await body('holder', { holder: '2026-10-10' }, "This PDF bears the holder's signature")
    const first = await commit(l, l.rw, 'mark-executed', holderSigned)
    expect(first.transactions).toMatchObject([{ type: 'X_EXECUTION_STATUS', effectiveDate: '2026-10-10' }])
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-2')}`)).executionStatus).toBe('pending_company')
    // Signed so far, not executed: the agreement is evidence, not the grant's agreement.
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'EVIDENCE'", holderSigned.executedAgreementDocumentId)).toBe(1)
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM document_links WHERE document_id = ? AND role = 'AGREEMENT'", holderSigned.executedAgreementDocumentId)).toBe(0)
    // The holder can't sign twice; the company's signature now completes it and is recorded as both.
    expect(await violations(l, l.rw, 'mark-executed', await body('holder', { holder: '2026-10-12' }, "This PDF bears the holder's signature"))).toEqual(['SIGNATURE_NOT_PENDING'])
    expect(await violations(l, l.rw, 'mark-executed', await body('company', { company: '2026-10-12' }, "This PDF bears the company signatory's signature"))).toEqual(['SIGNATURE_COMPLETES_EXECUTION'])
    // Not before the status it follows.
    expect(await violations(l, l.rw, 'mark-executed', await body('both', { company: '2026-10-05', holder: '2026-10-08' }, 'This PDF bears both signatures'))).toEqual(['SIGNATURE_DATE_BEFORE_STATUS'])
    const done = await commit(l, l.rw, 'mark-executed', await body('both', { company: '2026-10-15', holder: '2026-10-10' }, 'This PDF bears both signatures'))
    expect(done.transactions).toMatchObject([{ type: 'X_EXECUTION_STATUS', effectiveDate: '2026-10-15' }])
    expect(done.dependencies.map((edge) => edge.commandId)).toContain(first.commandId)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-2')}`)).executionStatus).toBe('executed')
  })

  it("refuses one party's signature a grant isn't awaiting, a mismatched attestation and the other party's date", async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        acme.b.command('pending:OPT-2', (c) => { c.tx('X_EXECUTION_STATUS', '2026-10-01', { security_id: acme.id('OPT-2'), status: 'pending_holder' }) })
      },
    })
    const document = await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT')
    const body = { securityId: l.id('OPT-2'), executedAgreementDocumentId: document, signatureDates: {}, confirmation: 'OPT-2' }
    // Awaiting only the holder: the company has signed already, and the holder's signature completes execution.
    expect(await violations(l, l.rw, 'mark-executed', { ...body, signed: 'company', attestation: "This PDF bears the company signatory's signature" })).toEqual(['SIGNATURE_NOT_PENDING'])
    expect(await violations(l, l.rw, 'mark-executed', { ...body, signed: 'holder', attestation: "This PDF bears the holder's signature" })).toEqual(['SIGNATURE_COMPLETES_EXECUTION'])
    expect(await violations(l, l.rw, 'mark-executed', { ...body, signatureDates: { holder: '2026-09-01' }, attestation: 'This PDF bears both signatures' })).toEqual(['SIGNATURE_DATE_BEFORE_STATUS'])
    expect(await violations(l, l.rw, 'mark-executed', { ...body, signatureDates: { holder: '2023-01-02' }, attestation: 'This PDF bears both signatures' })).toEqual(['SIGNATURE_DATE_BEFORE_ISSUE'])
    expect((await dryRun(l, l.rw, 'mark-executed', { ...body, signed: 'holder', attestation: 'This PDF bears both signatures' })).status).toBe(400)
    expect((await dryRun(l, l.rw, 'mark-executed', { ...body, signed: 'holder', signatureDates: { company: '2026-10-10' }, attestation: "This PDF bears the holder's signature" })).status).toBe(400)
    // A body without `signed` still means both.
    expect((await dryRun(l, l.rw, 'mark-executed', { ...body, attestation: 'This PDF bears both signatures' })).status).toBe(200)
  })

  it("refuses a grant that isn't pending and a wrong confirmation", async () => {
    const l = await ledgerHarness()
    const body = { securityId: l.id('OPT-1'), executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signatureDates: {}, attestation: 'This PDF bears both signatures', confirmation: 'OPT-1' }
    expect(await violations(l, l.rw, 'mark-executed', body)).toContain('NOT_EXECUTION_PENDING')
    expect(await violations(l, l.rw, 'mark-executed', { ...body, securityId: l.id('OPT-5'), confirmation: 'OPT-5' })).toContain('SECURITY_NOT_OUTSTANDING')
    const wrong = await runCommand(l, l.rw, 'mark-executed', { ...body, securityId: l.id('OPT-50'), confirmation: 'OPT-5' })
    expect(wrong.response.status).toBe(400)
  })
})

describe('record-leave-of-absence', () => {
  it('records a leave, which moves the ISO deadline, and refuses bad dates', async () => {
    const l = await ledgerHarness()
    const result = await commit(l, l.rw, 'record-leave-of-absence', { stakeholderId: l.id('S05'), startDate: '2026-06-01', endDate: null, returnGuaranteed: false })
    expect(result.transactions).toMatchObject([{ type: 'X_STAKEHOLDER_LEAVE', effectiveDate: '2026-06-01' }])
    const detail = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S05')}`)
    expect(detail.leaveOfAbsence).toMatchObject([{ startDate: '2026-06-01', endDate: null, returnGuaranteed: false }])
    expect(await violations(l, l.rw, 'record-leave-of-absence', { stakeholderId: l.id('S06'), startDate: '2026-11-01', endDate: null, returnGuaranteed: true })).toContain('LEAVE_START_IN_FUTURE')
    expect(await violations(l, l.rw, 'record-leave-of-absence', { stakeholderId: l.id('S06'), startDate: '2026-09-01', endDate: '2026-08-01', returnGuaranteed: true })).toContain('LEAVE_DATES')
  })

  it('closes an open leave when its start date comes again with an end, and refuses a leave inside another one', async () => {
    const l = await ledgerHarness()
    const body = (startDate: string, endDate: string | null, returnGuaranteed = false) => ({ stakeholderId: l.id('S05'), startDate, endDate, returnGuaranteed })
    await commit(l, l.rw, 'record-leave-of-absence', body('2026-06-01', null))
    // Open, with no right to return: employment ends for the ISO test on 2026-09-02, so OPT-2's ISO deadline is 2026-12-02.
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-2')}`)).deadlines?.iso).toBe('2026-12-02')
    // Another start date inside the open leave is a second leave: refused, with the start date to send instead.
    expect(await violations(l, l.rw, 'record-leave-of-absence', body('2026-07-01', '2026-08-15'))).toEqual(['LEAVE_OVERLAPS'])
    // Back on 2026-08-15, within three months: the same start date with its end closes the leave.
    const closed = await commit(l, l.rw, 'record-leave-of-absence', body('2026-06-01', '2026-08-15'))
    expect(closed.changes).toContainEqual(expect.objectContaining({
      entity: 'stakeholder', id: l.id('S05'), after: expect.objectContaining({ leaves: [{ startDate: '2026-06-01', endDate: '2026-08-15', returnGuaranteed: false }] }),
    }))
    expect((await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S05')}`)).leaveOfAbsence).toEqual([{ startDate: '2026-06-01', endDate: '2026-08-15', returnGuaranteed: false }])
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-2')}`)).deadlines?.iso ?? null).toBeNull()
    // A leave starting the day the last one ended is a new leave.
    await commit(l, l.rw, 'record-leave-of-absence', body('2026-08-15', null, true))
    expect((await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S05')}`)).leaveOfAbsence).toHaveLength(2)
  })
})

describe('extend-exercise-deadline', () => {
  it("lets a write administrator extend a deadline with counsel's document, warning on an ISO", async () => {
    const l = await ledgerHarness()
    const body = async (label: string, date: string) => ({ securityId: l.id(label), newContractualDeadline: date, documentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO'), note: 'Separation agreement', confirmation: label })
    expect((await l.api('POST', l.path('/commands/extend-exercise-deadline?dryRun=true'), l.ro, await body('OPT-26', '2027-04-01'))).status).toBe(403)
    const result = await commit(l, l.sa, 'extend-exercise-deadline', await body('OPT-26', '2027-04-01'))
    expect(result.transactions).toMatchObject([{ type: 'X_SECURITY_MODIFICATION', effectiveDate: '2026-10-21' }])
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-26')}`)).deadlines?.contractual).toBe('2027-04-01')
    expect(await violations(l, l.sa, 'extend-exercise-deadline', await body('OPT-26', '2027-03-01'))).toContain('EXTENSION_SHORTENS_DEADLINE')
    expect(await violations(l, l.sa, 'extend-exercise-deadline', await body('OPT-26', '2040-01-01'))).toContain('EXTENSION_AFTER_EXPIRATION')
    expect(await violations(l, l.sa, 'extend-exercise-deadline', await body('CS-1', '2027-04-01'))).toContain('NOT_OPTION_OR_WARRANT')
    const iso = await dryRun(l, l.rw, 'extend-exercise-deadline', await body('OPT-20', '2027-06-30'))
    expect((iso.body as api.CommandResult).warnings.map((w) => w.code)).toEqual(['ISO_MODIFICATION_RISK'])
  })
})

describe('set-plan-terms', () => {
  it('lets a write administrator set forward-dated plan terms and refuses back-dated or invalid ones', async () => {
    const l = await ledgerHarness()
    expect((await l.api('POST', l.path('/commands/set-plan-terms?dryRun=true'), l.ro, await planTermsBody(l))).status).toBe(403)
    const result = await commit(l, l.sa, 'set-plan-terms', await planTermsBody(l))
    expect(result.transactions).toMatchObject([{ type: 'X_STOCK_PLAN_TERMS', effectiveDate: '2026-10-21' }])
    const plan = await getJson<api.StockPlanDetail>(l, l.sa, `/stock-plans/${l.id('plan:P1')}`)
    expect(plan.defaultTerminationWindows).toContainEqual({ reason: 'VOLUNTARY', period: '6', unit: 'MONTHS' })
    expect(plan.returnRulesConfirmation).toMatchObject({ effectiveDate: '2026-10-21', documentId: expect.any(String) })
    expect(await violations(l, l.sa, 'set-plan-terms', await planTermsBody(l, { effectiveDate: '2026-01-01' }))).toContain('PLAN_TERMS_BEFORE_CURRENT')
    expect(await violations(l, l.sa, 'set-plan-terms', await planTermsBody(l, { effectiveDate: '2026-11-01' }))).toContain('EFFECTIVE_DATE_IN_FUTURE')
    expect(await violations(l, l.sa, 'set-plan-terms', await planTermsBody(l, { pourOverPlanId: l.id('plan:P1') }))).toContain('POUR_OVER_INVALID')
    const duplicate = await dryRun(l, l.sa, 'set-plan-terms', await planTermsBody(l, { defaultTerminationWindows: [...WINDOWS.slice(0, 5), WINDOWS[0]] }))
    expect(duplicate.status).toBe(400)
  })
})

describe('authorization of the commands', () => {
  it('refuses a read-only custom role every command, the write-administrator ones included', async () => {
    const l = await ledgerHarness()
    const terminate = await l.api('POST', l.path('/commands/terminate-stakeholder?dryRun=true'), l.ro, terminationBody(l, 'S10'))
    expect(terminate.status).toBe(403)
    for (const name of ['reverse-command', 'cancel-scheduled-termination']) {
      expect((await l.api('POST', l.path(`/commands/${name}`), l.ro, {})).status, name).toBe(403)
    }
  })

  it.each(LEDGER_SELF_DEALING_ROUTE_IDS)('keeps %s blocked after the administrator tries to remove their own link', async (routeId) => {
    const l = await ledgerHarness()
    const route = api.routeById(routeId)!
    expect(route.path).toContain('/commands/')
    const name = route.path.split('/').at(-1)!
    const identity = l.sa
    let body: Record<string, unknown>
    let holder: string
    switch (routeId) {
      case 'terminateStakeholder': holder = 'S10'; body = terminationBody(l, 'S10'); break
      case 'scheduleTermination': holder = 'S14'; body = { ...terminationBody(l, 'S14'), terminationDate: '2026-12-04' }; break
      case 'exerciseOption': holder = 'S04'; body = await exerciseBody(l); break
      case 'grantEquityCompensation': holder = 'S04'; body = await grantBody(l); break
      case 'cancelSecurity': holder = 'S11'; body = await cancelBody(l, 'OPT-55'); break
      case 'recordRepurchase': holder = 'S24'; body = await repurchaseBody(l, 'CS-4'); break
      case 'markExecuted': holder = 'S12'; body = { securityId: l.id('OPT-50'), executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signatureDates: {}, attestation: 'This PDF bears both signatures', confirmation: 'OPT-50' }; break
      case 'recordLeaveOfAbsence': holder = 'S05'; body = { stakeholderId: l.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true }; break
      case 'extendExerciseDeadline': holder = 'S27'; body = { securityId: l.id('OPT-26'), newContractualDeadline: '2027-04-01', documentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO'), note: 'x', confirmation: 'OPT-26' }; break
      case 'setPlanTerms': holder = 'S04'; body = await planTermsBody(l); break
      case 'mergeStakeholders': holder = 'S10'; body = { mergedStakeholderId: l.id('S10'), survivingStakeholderId: l.id('S14'), reason: 'Duplicate imported stakeholder', confirmation: 'Synthetic Holder' }; break
      case 'reverseCommand': {
        holder = 'S11'
        const cancelled = await commit(l, l.rw, 'cancel-security', await cancelBody(l, 'OPT-55', { reason: 'NOT_EXECUTED' }))
        body = { commandId: cancelled.commandId, note: 'Entered in error', expectedLedgerSeq: cancelled.ledgerSeq, expectedDiffSha256: '0'.repeat(64), confirmation: 'OPT-55' }
        break
      }
    }
    const linkId = await linkAdmin(l.db, l.orgId, OWNER_EMAIL, l.id(holder))
    const removal = await l.api('POST', l.path(`/admin-links/${linkId}/remove`), identity, { reason: 'Synthetic self-link removal attempt' })
    expect(removal.status, await removal.clone().text()).toBe(403)
    expect(errorOf(await removal.json()).code).toBe('self_dealing')
    const target = routeId === 'reverseCommand' ? l.path(`/commands/${name}`) : l.path(`/commands/${name}?dryRun=true`)
    const response = await l.api('POST', target, identity, body)
    if (routeId === 'setPlanTerms') {
      // Plan terms touch no holder's securities or stakeholder record: holding awards under the plan
      // doesn't block the administrator, and the rule can't apply.
      expect(response.status, await response.clone().text()).toBe(200)
      return
    }
    expect(response.status, await response.clone().text()).toBe(403)
    expect(errorOf(await response.json()).code).toBe('self_dealing')
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'access.denied' AND reason = 'self_dealing'")).toBe(2)
  })

  it("finds an administrator's own holdings by their console e-mail too", async () => {
    const l = await ledgerHarness()
    await addEmail(l.db, l.orgId, l.id('S10'), ADMIN_EMAIL)
    const response = await l.api('POST', l.path('/commands/terminate-stakeholder?dryRun=true'), l.rw, terminationBody(l, 'S10'))
    expect(response.status).toBe(403)
    expect(errorOf(await response.json()).code).toBe('self_dealing')
  })
})

describe("a new holder's grant needs the stakeholder row", () => {
  it('grants to a stakeholder created after the import', async () => {
    const l = await ledgerHarness()
    await addStakeholder(l.db, l.orgId, 'S41', 'employee')
    const result = await commit(l, l.rw, 'grant-equity-compensation', await grantBody(l, { stakeholderId: l.id('S41'), quantity: '40000', displayId: 'OPT-57' }))
    expect(result.created.securityIds).toHaveLength(1)
  })
})
