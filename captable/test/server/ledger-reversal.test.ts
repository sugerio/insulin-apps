import { describe, expect, it } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import { newPlan } from '../../src/app/server/lib/ledger/commands/common.ts'
import { loadCommandContext, runCommand as runLedgerCommand } from '../../src/app/server/lib/ledger/run.ts'
import { uuid } from '../shared/engine/fixtures/builder.ts'
import {
  ADMIN_EMAIL,
  ADMIN_USER_ID,
  addDocument,
  addEmail,
  addStakeholder,
  commit,
  consoleActor,
  count,
  demoRow,
  errorOf,
  getJson,
  ledgerHarness,
  VS1_TEMPLATE_ID,
  withRestrictedShares,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/**
 * Whole-command reversal: the preview, the refusal while a dependent command stands (and for
 * migrated history), and the reversal itself, newest first, with its workflow effects.
 */

async function grantS41(l: LedgerHarness) {
  return commit(l, l.rw, 'grant-equity-compensation', await grantS41Body(l))
}

async function grantS41Body(l: LedgerHarness): Promise<Record<string, unknown>> {
  await addStakeholder(l.db, l.orgId, 'S41', 'employee')
  return {
    stockPlanId: l.id('plan:P1'),
    stakeholderId: l.id('S41'),
    quantity: '40000',
    board: { approvalDate: '2026-10-20', consentDocumentId: await addDocument(l.db, l.orgId, 'BOARD_CONSENT') },
    optionType: 'ISO',
    isoAttestations: { employeeAtGrant: true, tenPercentHolder: false },
    vesting: { terms: { templateId: VS1_TEMPLATE_ID }, vestingStartDate: '2026-10-19', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true },
    exercisePrice: '0.95',
    valuationId: l.id('V5'),
    expirationDate: '2036-10-20',
    exemption: { federal: 'RULE_701' },
    displayId: 'OPT-57',
    executedAgreement: { documentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signedByHolderAndSignatory: true },
  }
}

async function preview(l: LedgerHarness, commandId: string) {
  return getJson<api.ReversalPreview>(l, l.sa, `/commands/${commandId}/reversal-preview`)
}

async function reverse(l: LedgerHarness, commandId: string, confirmation: string, extra: Record<string, unknown> = {}) {
  const shown = await preview(l, commandId)
  const response = await l.api('POST', l.path('/commands/reverse-command'), l.sa, {
    commandId,
    note: 'Recorded in error',
    expectedLedgerSeq: shown.ledgerSeq,
    expectedDiffSha256: shown.diffSha256,
    confirmation,
    ...extra,
  })
  return { response, body: await response.json() as unknown, preview: shown }
}

describe('reverse-command', () => {
  it('previews, refuses while a dependent stands, then reverses newest first back to the same numbers', async () => {
    const l = await ledgerHarness()
    const start = await demoRow(l)
    const grant = await grantS41(l)
    const optionId = grant.created.securityIds[0]!
    const cancel = await commit(l, l.rw, 'cancel-security', {
      securityId: optionId, effectiveDate: '2026-10-21', quantity: '10000', reason: 'MUTUAL_AGREEMENT',
      documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-57',
    })
    expect(cancel.dependencies).toContainEqual({ commandId: grant.commandId, kind: 'consumes_security' })

    const blocked = await preview(l, grant.commandId!)
    expect(blocked).toMatchObject({ commandType: 'grant-equity-compensation', importedFromPulley: false, blocked: true })
    expect(blocked.inverse.map((tx) => tx.type)).toEqual(['TX_VESTING_START', 'TX_EQUITY_COMPENSATION_ISSUANCE'])
    expect(blocked.dependents).toEqual([expect.objectContaining({ commandId: cancel.commandId, kind: 'consumes_security' })])

    const refused = await reverse(l, grant.commandId!, 'OPT-57')
    expect(refused.response.status).toBe(409)
    expect(errorOf(refused.body)).toMatchObject({ code: 'conflict', reason: 'dependents_exist', dependents: [{ commandId: cancel.commandId }] })

    const undoCancel = await reverse(l, cancel.commandId!, 'OPT-57')
    expect(undoCancel.response.status, JSON.stringify(undoCancel.body)).toBe(200)
    expect(undoCancel.preview).toMatchObject({ blocked: false, dependents: [] })
    expect((undoCancel.body as api.CommandResult).transactions.map((tx) => tx.type)).toEqual(['X_REVERSAL'])

    const undoGrant = await reverse(l, grant.commandId!, 'OPT-57')
    expect(undoGrant.response.status, JSON.stringify(undoGrant.body)).toBe(200)
    expect(await demoRow(l)).toEqual(start)
    expect((await l.api('GET', l.path(`/securities/${optionId}`), l.sa)).status).toBe(404)

    // A reversal can't be reversed, and a reversed command can't be reversed twice.
    const again = await reverse(l, cancel.commandId!, 'OPT-57')
    expect(again.response.status).toBe(409)
    expect(errorOf(again.body).reason).toBe('state_changed')
    const ofReversal = await reverse(l, (undoCancel.body as api.CommandResult).commandId!, (undoCancel.body as api.CommandResult).commandId!)
    expect(ofReversal.response.status).toBe(409)
    expect(errorOf(ofReversal.body).reason).toBe('state_changed')
    const detail = await getJson<api.CommandDetail>(l, l.sa, `/commands/${cancel.commandId}`)
    expect(detail.reversedByCommandId).toBe((undoCancel.body as api.CommandResult).commandId)
  })

  it('reverses a grant recorded awaiting signatures as a whole, its execution status with it, and blocks it while Mark executed stands', async () => {
    const l = await ledgerHarness()
    const start = await demoRow(l)
    const { executedAgreement: _executed, ...body } = await grantS41Body(l)
    const holderSigned = await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT')
    const grant = await commit(l, l.rw, 'grant-equity-compensation', { ...body, awaitingSignatures: { missing: 'company', agreementDocumentId: holderSigned } })
    const optionId = grant.created.securityIds[0]!
    const marked = await commit(l, l.rw, 'mark-executed', {
      securityId: optionId, executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signatureDates: { company: '2026-10-21' },
      attestation: 'This PDF bears both signatures', confirmation: 'OPT-57',
    })
    expect(marked.dependencies.map((edge) => edge.commandId)).toContain(grant.commandId)
    expect((await preview(l, grant.commandId!)).blocked).toBe(true)
    const unmark = await reverse(l, marked.commandId!, 'OPT-57')
    expect(unmark.response.status, JSON.stringify(unmark.body)).toBe(200)
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${optionId}`)).executionStatus).toBe('pending_company')

    const shown = await preview(l, grant.commandId!)
    expect(shown.inverse.map((tx) => tx.type)).toEqual(['X_EXECUTION_STATUS', 'TX_VESTING_START', 'TX_EQUITY_COMPENSATION_ISSUANCE'])
    const undo = await reverse(l, grant.commandId!, 'OPT-57')
    expect(undo.response.status, JSON.stringify(undo.body)).toBe(200)
    expect(await demoRow(l)).toEqual(start)
    expect((await l.api('GET', l.path(`/securities/${optionId}`), l.sa)).status).toBe(404)
  })

  it("reverses one party's signature back to awaiting both, only once the signature that completed it is reversed", async () => {
    const l = await ledgerHarness()
    const { executedAgreement: _executed, ...body } = await grantS41Body(l)
    const grant = await commit(l, l.rw, 'grant-equity-compensation', { ...body, awaitingSignatures: { missing: 'both' } })
    const optionId = grant.created.securityIds[0]!
    const status = async () => (await getJson<api.SecurityDetail>(l, l.sa, `/securities/${optionId}`)).executionStatus
    const holder = await commit(l, l.rw, 'mark-executed', {
      securityId: optionId, signed: 'holder', executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'),
      signatureDates: { holder: '2026-10-20' }, attestation: "This PDF bears the holder's signature", confirmation: 'OPT-57',
    })
    const both = await commit(l, l.rw, 'mark-executed', {
      securityId: optionId, executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'),
      signatureDates: { company: '2026-10-21' }, attestation: 'This PDF bears both signatures', confirmation: 'OPT-57',
    })
    expect(await status()).toBe('executed')
    const blocked = await preview(l, holder.commandId!)
    expect(blocked.blocked).toBe(true)
    expect(blocked.dependents.map((dependent) => dependent.commandId)).toEqual([both.commandId])
    expect((await reverse(l, both.commandId!, 'OPT-57')).response.status).toBe(200)
    expect(await status()).toBe('pending_company')
    expect((await reverse(l, holder.commandId!, 'OPT-57')).response.status).toBe(200)
    expect(await status()).toBe('pending_both')
  })

  it('refuses migrated history (409 migrated_history) and says so in the preview', async () => {
    const l = await ledgerHarness()
    const migrated = uuid('command:grant:OPT-1')
    const shown = await preview(l, migrated)
    expect(shown).toMatchObject({ importedFromPulley: true, blocked: true })
    const refused = await reverse(l, migrated, 'OPT-1')
    expect(refused.response.status).toBe(409)
    expect(errorOf(refused.body).reason).toBe('migrated_history')
  })

  it('restores the relationship a reversed termination ended', async () => {
    const l = await ledgerHarness()
    await addEmail(l.db, l.orgId, l.id('S10'), 's10.home@example.test')
    const termination = await commit(l, l.rw, 'terminate-stakeholder', { stakeholderId: l.id('S10'), terminationDate: '2026-10-21', terminationType: 'voluntary' })
    expect((await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S10')}`)).termination).not.toBeNull()
    const shown = await preview(l, termination.commandId!)
    expect(shown.workflowEffects).toEqual([{ kind: 'stakeholder_relationship', id: l.id('S10'), from: 'ex_employee', to: 'employee' }])
    const reversed = await reverse(l, termination.commandId!, 'Synthetic Holder S10')
    expect(reversed.response.status, JSON.stringify(reversed.body)).toBe(200)
    expect(await l.db.prepare('SELECT relationship FROM stakeholders WHERE id = ?').bind(l.id('S10')).first('relationship')).toBe('employee')
    const s10 = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S10')}`)
    expect(s10.termination).toBeNull()
    expect(s10.emails.map((email) => email.email)).toEqual(['s10.home@example.test'])
    // The notification removed with the e-mail subsystem leaves no row to send: the reversal itself is the record.
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'command.reverse-command'")).toBe(1)
  })

  it('needs a write administrator, the typed confirmation and the reviewed head and diff', async () => {
    const l = await ledgerHarness()
    const cancelled = await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-55'), effectiveDate: '2026-10-21', reason: 'NOT_EXECUTED', documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-55',
    })
    const shown = await preview(l, cancelled.commandId!)
    const body = { commandId: cancelled.commandId, note: 'Cancelled the wrong grant', expectedLedgerSeq: shown.ledgerSeq, expectedDiffSha256: shown.diffSha256, confirmation: 'OPT-55' }
    expect((await l.api('POST', l.path('/commands/reverse-command'), l.ro, body)).status).toBe(403)
    // There is no dry run of a reversal: asking for one never reverses anything.
    expect((await l.api('POST', l.path('/commands/reverse-command?dryRun=true'), l.sa, body)).status).toBe(400)
    const wrong = await l.api('POST', l.path('/commands/reverse-command'), l.sa, { ...body, confirmation: 'OPT-56' })
    expect(wrong.status).toBe(400)
    // The removed holder notice is no longer part of the request.
    expect((await l.api('POST', l.path('/commands/reverse-command'), l.sa, { ...body, notifyHolder: false })).status).toBe(400)
    const changed = await l.api('POST', l.path('/commands/reverse-command'), l.sa, { ...body, expectedDiffSha256: 'f'.repeat(64) })
    expect(errorOf(await changed.json()).reason).toBe('state_changed')
    const stale = await l.api('POST', l.path('/commands/reverse-command'), l.sa, { ...body, expectedLedgerSeq: shown.ledgerSeq - 1 })
    expect(errorOf(await stale.json()).reason).toBe('stale_ledger')
    const done = await l.api('POST', l.path('/commands/reverse-command'), l.rw, body, { 'Idempotency-Key': 'reverse-cancel-intent' })
    expect(done.status).toBe(200)
    const replay = await l.api('POST', l.path('/commands/reverse-command'), l.rw, body, { 'Idempotency-Key': 'reverse-cancel-intent' })
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
    expect((await l.api('GET', l.path(`/commands/${l.id('missing')}/reversal-preview`), l.sa)).status).toBe(404)
  })

  it("refuses every command type that isn't reversible (422 COMMAND_NOT_REVERSIBLE), and the preview says blocked", async () => {
    const l = await ledgerHarness({
      extend: (acme) => {
        // An expiry recorded by due processing (system), as a ledger loaded with one would hold.
        acme.b.command('expire:OPT-26', (c) => {
          c.tx('TX_EQUITY_COMPENSATION_CANCELLATION', '2026-10-20', { security_id: acme.id('OPT-26'), quantity: '21250', reason_text: 'Expired after the exercise window', x_reason: 'EXPIRED' })
        }, { source: 'system', type: 'expire-securities' })
      },
    })
    const expiry = l.acme.b.commandIds.get('expire:OPT-26')!
    const leave = await commit(l, l.rw, 'record-leave-of-absence', { stakeholderId: l.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true })
    const extension = await commit(l, l.sa, 'extend-exercise-deadline', {
      securityId: l.id('OPT-20'), newContractualDeadline: '2027-06-30', documentId: await addDocument(l.db, l.orgId, 'COUNSEL_MEMO'), note: 'Separation agreement', confirmation: 'OPT-20',
    })
    const terms = await commit(l, l.sa, 'set-plan-terms', {
      stockPlanId: l.id('plan:P1'), effectiveDate: '2026-10-21',
      returnRules: { cancelledUnvestedAwards: 'RETURN', expiredVestedOptions: 'RETURN', repurchasedUnvestedShares: 'RETURN', repurchasedVestedShares: 'RETIRE', sharesWithheldForTax: 'RETIRE' },
      defaultTerminationWindows: [
        { reason: 'VOLUNTARY', period: '3', unit: 'MONTHS' }, { reason: 'INVOLUNTARY', period: '3', unit: 'MONTHS' }, { reason: 'WITH_CAUSE', period: '0', unit: 'DAYS' },
        { reason: 'DEATH', period: '12', unit: 'MONTHS' }, { reason: 'DISABILITY', period: '12', unit: 'MONTHS' }, { reason: 'RETIREMENT', period: '3', unit: 'MONTHS' },
      ],
      defaultRepurchaseWindow: { period: '90', unit: 'DAYS' }, status: 'active', pourOverPlanId: null,
      documentId: await addDocument(l.db, l.orgId, 'PLAN_DOCUMENT'), note: 'Board confirmed the rules',
    })
    for (const [type, commandId] of [
      ['record-leave-of-absence', leave.commandId!],
      ['extend-exercise-deadline', extension.commandId!],
      ['set-plan-terms', terms.commandId!],
      ['expire-securities', expiry],
    ] as const) {
      const shown = await preview(l, commandId)
      expect(shown, type).toMatchObject({ commandType: type, blocked: true })
      const refused = await reverse(l, commandId, commandId)
      expect(refused.response.status, type).toBe(422)
      expect(errorOf(refused.body).violations?.map((violation) => violation.code), type).toEqual(['COMMAND_NOT_REVERSIBLE'])
    }
    expect(await count(l.db, "SELECT COUNT(*) AS n FROM commands WHERE type = 'reverse-command'")).toBe(0)
  })
})

/**
 * A recorded repurchase is reversed whole, its balance lot with it. It stands on the termination that opened the window,
 * a later command on its balance lot stands on it, and the engine refuses a reversal that would take back pool capacity
 * a later grant has used.
 */
describe('reversing a recorded repurchase', () => {
  async function repurchaseCs4(l: LedgerHarness, effectiveDate = '2026-10-20') {
    return commit(l, l.rw, 'record-repurchase', {
      securityId: l.id('CS-4'), effectiveDate, quantity: '34500', pricePerShare: '0.31',
      consideration: { method: 'WIRE', paidDate: effectiveDate, reference: 'W-CS-4' },
      noticeDocumentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'CS-4',
    })
  }

  it('restores the lot, removes the balance lot and returns every figure', async () => {
    const l = await ledgerHarness()
    const start = await demoRow(l)
    const recorded = await repurchaseCs4(l)
    const balanceId = recorded.created.securityIds[0]!
    expect(await demoRow(l)).not.toEqual(start)
    // The share pages offer the repurchase as the command to reverse, on the lot and on its balance lot.
    for (const id of [l.id('CS-4'), balanceId]) {
      expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${id}`)).lastReversibleCommandId).toBe(recorded.commandId)
    }
    const shown = await preview(l, recorded.commandId!)
    expect(shown).toMatchObject({ commandType: 'record-repurchase', importedFromPulley: false, blocked: false, dependents: [] })
    expect(shown.inverse.map((tx) => tx.type)).toEqual(['TX_STOCK_ISSUANCE', 'TX_STOCK_REPURCHASE'])
    // The lot's label confirms it (the security of the command's first transaction).
    expect((await reverse(l, recorded.commandId!, 'CS-9')).response.status).toBe(400)
    const reversed = await reverse(l, recorded.commandId!, 'CS-4')
    expect(reversed.response.status, JSON.stringify(reversed.body)).toBe(200)
    expect(await demoRow(l)).toEqual(start)
    expect(await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('CS-4')}`)).toMatchObject({ status: 'OUTSTANDING', numbers: { outstanding: '72000', unvested: '34500', repurchased: '0' } })
    expect((await l.api('GET', l.path(`/securities/${balanceId}`), l.sa)).status).toBe(404)
    expect((await getJson<api.SecuritiesStatus>(l, l.sa, '/securities-status')).unvestedSharesFromTerminated).toContainEqual(expect.objectContaining({ securityId: l.id('CS-4'), unvested: '34500' }))
  })

  it('is refused while a later command on the balance lot stands', async () => {
    const l = await ledgerHarness()
    const recorded = await repurchaseCs4(l)
    const balanceId = recorded.created.securityIds[0]!
    // The app has no command on a plain share lot yet; a later one acts on the balance lot here.
    const ctx = await loadCommandContext({ db: l.db, now: l.clock.time, config: l.config, orgId: l.orgId, actor: consoleActor(ADMIN_USER_ID, ADMIN_EMAIL), source: 'app' })
    const later = await runLedgerCommand(ctx, {
      route: 'POST /api/orgs/:orgId/commands/later-share-command', path: '/later', body: { balanceId }, dryRun: false,
      idempotencyKey: 'later-share-command', expectedLedgerSeq: null, expectedDiffSha256: null, acknowledge: [],
    }, async (current) => {
      const plan = newPlan(current, 'later-share-command')
      plan.transactions.push({ type: 'TX_STOCK_CANCELLATION', effectiveDate: current.today, payload: { security_id: balanceId, quantity: '1000', reason_text: 'A later act on the balance lot' } })
      return { plan, documents: null }
    })
    expect(later.result.dependencies).toContainEqual({ commandId: recorded.commandId, kind: 'consumes_security' })
    const shown = await preview(l, recorded.commandId!)
    expect(shown).toMatchObject({ blocked: true, dependents: [expect.objectContaining({ commandId: later.result.commandId, kind: 'consumes_security' })] })
    const refused = await reverse(l, recorded.commandId!, 'CS-4')
    expect(refused.response.status).toBe(409)
    expect(errorOf(refused.body)).toMatchObject({ code: 'conflict', reason: 'dependents_exist', dependents: [{ commandId: later.result.commandId }] })
  })

  it('blocks reversing the termination it stands on until the repurchase is reversed first', async () => {
    const l = await ledgerHarness({ extend: withRestrictedShares })
    const termination = await commit(l, l.rw, 'terminate-stakeholder', { stakeholderId: l.id('S41'), terminationDate: '2026-08-01', terminationType: 'voluntary' })
    const recorded = await commit(l, l.rw, 'record-repurchase', {
      securityId: l.id('RS-1'), effectiveDate: '2026-09-15', quantity: '2900', pricePerShare: '1',
      consideration: { method: 'CHECK', paidDate: '2026-09-15' }, noticeDocumentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'RS-1',
    })
    expect(recorded.dependencies).toContainEqual({ commandId: termination.commandId, kind: 'relies_on_deadline' })
    const shown = await preview(l, termination.commandId!)
    expect(shown).toMatchObject({ blocked: true, dependents: [expect.objectContaining({ commandId: recorded.commandId, kind: 'relies_on_deadline' })] })
    const refused = await reverse(l, termination.commandId!, 'Synthetic Holder S41')
    expect(refused.response.status).toBe(409)
    expect(errorOf(refused.body)).toMatchObject({ reason: 'dependents_exist', dependents: [{ commandId: recorded.commandId }] })
    // Newest first: the repurchase, then the termination.
    expect((await reverse(l, recorded.commandId!, 'RS-1')).response.status).toBe(200)
    const undone = await reverse(l, termination.commandId!, 'Synthetic Holder S41')
    expect(undone.response.status, JSON.stringify(undone.body)).toBe(200)
    expect((await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S41')}`)).termination).toBeNull()
  })

  it("can't take back pool capacity a later grant has used", async () => {
    const l = await ledgerHarness()
    const available = BigInt((await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')).metrics.planAvailable)
    // The repurchase returns CS-4's 34,500 unvested plan shares; a grant five days later uses all of the pool.
    const recorded = await repurchaseCs4(l, '2026-10-15')
    const grant = await commit(l, l.rw, 'grant-equity-compensation', {
      stockPlanId: l.id('plan:P1'), stakeholderId: l.id('S13'), quantity: String(available + 34500n),
      board: { approvalDate: '2026-10-20', consentDocumentId: await addDocument(l.db, l.orgId, 'BOARD_CONSENT') }, optionType: 'NSO',
      vesting: { terms: { templateId: VS1_TEMPLATE_ID }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true },
      exercisePrice: '0.95', valuationId: l.id('V5'), expirationDate: '2036-10-20', exemption: { federal: 'RULE_701' },
      executedAgreement: { documentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signedByHolderAndSignatory: true },
    })
    expect((await getJson<api.CapTableResponse>(l, l.sa, '/cap-table')).metrics.planAvailable).toBe('0')
    // Nothing links the grant to the repurchase, so the engine's replay without it is what refuses.
    const shown = await preview(l, recorded.commandId!)
    expect(shown).toMatchObject({ blocked: true, dependents: [] })
    expect(shown.violations.map((violation) => violation.code)).toContain('EXCEEDS_PLAN_AVAILABLE')
    const refused = await reverse(l, recorded.commandId!, 'CS-4')
    expect(refused.response.status).toBe(422)
    expect(errorOf(refused.body).violations?.map((violation) => violation.code)).toContain('EXCEEDS_PLAN_AVAILABLE')
    expect(grant.commandId).toBeTruthy()
    expect((await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('CS-4')}`)).status).toBe('REPURCHASED')
  })
})
