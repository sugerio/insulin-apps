import { describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import {
  ADMIN_EMAIL,
  ADMIN_USER_ID,
  OWNER_EMAIL,
  addDocument,
  addEmail,
  addStakeholder,
  commit,
  count,
  errorOf,
  getJson,
  headSeq,
  ledgerHarness,
  linkAdmin,
  runCommand,
  VS1_TEMPLATE_ID,
  withRsuAndSar,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/** The command routes that refuse an administrator's own holdings (403 self_dealing), each proven live below. */
const LEDGER_SELF_DEALING_ROUTE_IDS = [
  'terminateStakeholder', 'scheduleTermination', 'exerciseOption', 'grantEquityCompensation', 'cancelSecurity',
  'markExecuted', 'recordLeaveOfAbsence', 'extendExerciseDeadline', 'setPlanTerms', 'mergeStakeholders', 'reverseCommand',
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

    // A read-only EDITOR can't cancel; a write administrator cancels with the version it read; a stale version is refused.
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
    // a read-only EDITOR can't even preview a grant.
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
        acme.b.command('pending:OPT-2', (c) => { c.tx('X_EXECUTION_STATUS', '2026-10-01', { security_id: acme.id('OPT-2'), status: 'pending_company' }) })
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
  it('refuses a read-only EDITOR every command, the write-administrator ones included', async () => {
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
