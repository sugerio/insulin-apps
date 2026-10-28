import { describe, expect, it } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import {
  addDocument,
  addStakeholder,
  commit,
  demoRow,
  getJson,
  ledgerHarness,
  VS1_TEMPLATE_ID,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

/**
 * The engine's golden numbers through the HTTP API: the complete lifecycle recorded with the real
 * commands, dry run first, on the synthetic Acme org; after each step the cap table and dashboard endpoints show the
 * cumulative row the engine's golden test asserts.
 */

async function p4(l: LedgerHarness) {
  return commit(l, l.rw, 'mark-executed', {
    securityId: l.id('OPT-50'),
    executedAgreementDocumentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'),
    signatureDates: { company: '2026-10-20' },
    attestation: 'This PDF bears both signatures',
    confirmation: 'OPT-50',
  })
}

async function p5(l: LedgerHarness) {
  await addStakeholder(l.db, l.orgId, 'S41', 'employee', { email: 's41.newhire@example.test' })
  return commit(l, l.rw, 'grant-equity-compensation', {
    stockPlanId: l.id('plan:P1'),
    stakeholderId: l.id('S41'),
    quantity: '40000',
    board: { approvalDate: '2026-10-20', consentDocumentId: await addDocument(l.db, l.orgId, 'BOARD_CONSENT') },
    optionType: 'ISO',
    isoAttestations: { employeeAtGrant: true, tenPercentHolder: false },
    vesting: {
      terms: { templateId: VS1_TEMPLATE_ID },
      vestingStartDate: '2026-10-19',
      earlyExercisable: false,
      accelerationTerms: { kind: 'NONE' },
      matchesSignedAgreement: true,
    },
    exercisePrice: '0.95',
    valuationId: l.id('V5'),
    expirationDate: '2036-10-20',
    exemption: { federal: 'RULE_701' },
    displayId: 'OPT-57',
    executedAgreement: { documentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signedByHolderAndSignatory: true },
  })
}

async function p6(l: LedgerHarness) {
  return commit(l, l.rw, 'terminate-stakeholder', {
    stakeholderId: l.id('S10'),
    terminationDate: '2026-10-21',
    terminationType: 'voluntary',
  })
}

async function exercise(l: LedgerHarness, option: string, quantity: string, amount: string, portion: 'ISO' | 'NSO', displayId: string) {
  return commit(l, l.rw, 'exercise-option', {
    securityId: l.id(option),
    quantity,
    notice: { documentId: await addDocument(l.db, l.orgId, 'NOTICE_OF_EXERCISE'), receivedOn: '2026-10-20' },
    payment: { amount, receivedOn: '2026-10-20', method: 'ACH', reference: `EX-${option}` },
    exerciseDate: '2026-10-20',
    fmv: { source: 'valuation', valuationId: l.id('V5') },
    tax: portion === 'ISO' ? { treatment: 'W2' } : { treatment: 'FORM_1099_NEC' },
    resultingShares: [{ portion, displayId }],
  })
}

describe('the complete lifecycle through the HTTP API', () => {
  it('moves the cap table and dashboard exactly as the cumulative ledger says', async () => {
    const l = await ledgerHarness()
    expect(await demoRow(l)).toEqual(['24312120', '3796250', '460750', '9743000', '19945120', '16147718.6', '38', '6'])

    await p4(l)
    expect(await demoRow(l)).toEqual(['24312120', '3796250', '460750', '9743000', '19945120', '16147718.6', '38', '5'])

    const grant = await p5(l)
    expect(grant.created.securityIds).toHaveLength(1)
    expect(await demoRow(l)).toEqual(['24312120', '3836250', '420750', '9743000', '19945120', '16147718.6', '39', '5'])

    const termination = await p6(l)
    expect(termination.transactions.map((tx) => [tx.type, tx.quantity])).toEqual([
      ['X_STAKEHOLDER_TERMINATION', null],
      ['TX_EQUITY_COMPENSATION_CANCELLATION', '17500'],
      ['TX_EQUITY_COMPENSATION_CANCELLATION', '20625'],
      ['TX_EQUITY_COMPENSATION_CANCELLATION', '15000'],
    ])
    expect(await demoRow(l)).toEqual(['24312120', '3783125', '473875', '9743000', '19945120', '16147718.6', '39', '5'])

    await exercise(l, 'OPT-20', '30000', '9300', 'ISO', 'CS-9')
    expect(await demoRow(l)).toEqual(['24312120', '3753125', '473875', '9773000', '19975120', '16157018.6', '39', '5'])

    await exercise(l, 'OPT-9', '10000', '1000', 'NSO', 'CS-10')
    expect(await demoRow(l)).toEqual(['24312120', '3743125', '473875', '9783000', '19985120', '16158018.6', '39', '5'])

    const cancel = await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-56'),
      effectiveDate: '2026-10-21',
      reason: 'NOT_EXECUTED',
      reasonText: 'Holder declined to sign',
      documentId: await addDocument(l.db, l.orgId, 'OTHER'),
      confirmation: 'OPT-56',
    })
    expect(await demoRow(l)).toEqual(['24312120', '3733125', '483875', '9783000', '19985120', '16158018.6', '39', '4'])

    const preview = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${cancel.commandId}/reversal-preview`)
    expect(preview).toMatchObject({ commandType: 'cancel-security', blocked: false, dependents: [] })
    const reversal = await l.api('POST', l.path('/commands/reverse-command'), l.sa, {
      commandId: cancel.commandId,
      note: 'Recorded in error: the holder signed after all',
      expectedLedgerSeq: preview.ledgerSeq,
      expectedDiffSha256: preview.diffSha256,
      confirmation: 'OPT-56',
    })
    expect(reversal.status, await reversal.clone().text()).toBe(200)
    expect(await demoRow(l)).toEqual(['24312120', '3743125', '473875', '9783000', '19985120', '16158018.6', '39', '5'])

    // The details of each step, from the read endpoints.
    const s10 = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S10')}`)
    expect(s10.relationship).toBe('ex_employee')
    const opt12 = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-12')}`)
    expect(opt12.deadlines).toMatchObject({ contractual: '2027-01-21', iso: '2027-01-21' })
    const opt57 = await getJson<api.SecurityVesting>(l, l.sa, `/securities/${grant.created.securityIds[0]}/vesting`)
    expect(opt57.events[0]).toMatchObject({ date: '2027-10-19', quantity: '10000' })
    expect(opt57.events).toHaveLength(37)
    const opt56 = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-56')}`)
    expect(opt56).toMatchObject({ status: 'OUTSTANDING', executionStatus: 'pending_company' })
    const opt50 = await getJson<api.SecurityDetail>(l, l.sa, `/securities/${l.id('OPT-50')}`)
    expect(opt50.executionStatus).toBe('executed')
  }, 60_000)
})
