import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import type { Acme } from '../shared/engine/fixtures/acme.ts'
import { monthlyEvents, usd, uuid } from '../shared/engine/fixtures/builder.ts'
import { addDocument, getJson, holderIdentity, readHarness, SEED_USER_ID, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

/**
 * What the base fixture lacks for a complete detail page: an imported lot carrying a legend snapshot and its holding
 * start, restricted stock of a holder who hasn't left, and an imported grant with acceleration terms and no board
 * approval date in the import.
 */
function withHoldingDetails(acme: Acme): void {
  const { b, id, cls } = acme
  b.command('issue:CS-L', (c) => {
    const lot = c.security('CS-L', { family: 'STOCK', subtype: 'COMMON', stakeholderId: id('S40'), stockClassId: cls.CS, stockPlanId: null, parentSecurityId: null })
    c.tx('TX_STOCK_ISSUANCE', '2025-05-01', {
      security_id: lot, custom_id: 'CS-L', stakeholder_id: id('S40'), stock_class_id: cls.CS, share_price: usd('0.44'), quantity: '1000', x_origin: 'PURCHASE',
      x_legends: [{ legend_id: uuid('legend:securities-act'), name: 'Securities Act legend', text: 'Synthetic restrictive legend text for the test lot.' }],
      x_holding_start_date: '2025-04-15',
    })
  })
  b.command('grant:OPT-A', (c) => {
    const grant = c.security('OPT-A', { family: 'EQUITY_COMPENSATION', subtype: 'OPTION_NSO', stakeholderId: id('S05'), stockClassId: cls.CS, stockPlanId: acme.plan, parentSecurityId: null })
    const terms = b.vestingTerms('vt:OPT-A', { type: 'EXPLICIT', events: monthlyEvents(4800n, '2026-01-01', 48, 12) })
    c.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2026-01-01', {
      security_id: grant, custom_id: 'OPT-A', stakeholder_id: id('S05'), stock_plan_id: acme.plan, stock_class_id: cls.CS,
      compensation_type: 'OPTION_NSO', quantity: '4800', exercise_price: usd('0.95'), expiration_date: '2036-01-01', termination_exercise_windows: [],
      vesting_terms_id: terms.id, x_definition_sha256: terms.sha, x_board_approval_not_recorded_in_pulley: true,
      x_acceleration_terms: { kind: 'DOUBLE_TRIGGER', text: 'Synthetic double-trigger terms for the test grant.' },
    })
    c.tx('TX_VESTING_START', '2026-01-01', { security_id: grant, x_vesting_start_date: '2026-01-01' })
  })
  b.command('issue:RSA-1', (c) => {
    const lot = c.security('RSA-1', { family: 'STOCK', subtype: 'COMMON', stakeholderId: id('S05'), stockClassId: cls.CS, stockPlanId: null, parentSecurityId: null })
    const terms = b.vestingTerms('vt:RSA-1', { type: 'EXPLICIT', events: monthlyEvents(4800n, '2026-01-01', 48, 12) })
    c.tx('TX_STOCK_ISSUANCE', '2026-01-01', {
      security_id: lot, custom_id: 'RSA-1', stakeholder_id: id('S05'), stock_class_id: cls.CS, share_price: usd('0.01'), quantity: '4800',
      x_origin: 'RSA', vesting_terms_id: terms.id, x_definition_sha256: terms.sha,
      x_repurchase_right: { price_per_share: usd('0.01'), window: { period: 30, period_type: 'DAYS' } },
    })
  })
}

/**
 * Restricted stock under the plan, whose default repurchase window is 90 days, on agreements that set no repurchase
 * deadline: S05 hasn't left; S24 left on 2026-09-15.
 */
function withNoDeadlineLots(acme: Acme): void {
  const { b, id, cls } = acme
  for (const [label, holder] of [['RSA-N', 'S05'], ['RSA-M', 'S24']] as const) {
    b.command(`issue:${label}`, (c) => {
      const lot = c.security(label, { family: 'STOCK', subtype: 'COMMON', stakeholderId: id(holder), stockClassId: cls.CS, stockPlanId: acme.plan, parentSecurityId: null })
      const terms = b.vestingTerms(`vt:${label}`, { type: 'EXPLICIT', events: monthlyEvents(4800n, '2026-01-01', 48, 12) })
      c.tx('TX_STOCK_ISSUANCE', '2026-01-01', {
        security_id: lot, custom_id: label, stakeholder_id: id(holder), stock_class_id: cls.CS, share_price: usd('0.01'), quantity: '4800',
        x_origin: 'RSA', vesting_terms_id: terms.id, x_definition_sha256: terms.sha,
        x_repurchase_right: { price_per_share: usd('0.01'), window: null, x_no_deadline: true },
      })
      c.tx('TX_VESTING_START', '2026-01-01', { security_id: lot, x_vesting_start_date: '2026-01-01' })
    })
  }
}

async function detail(label: string, email: string) {
  return getJson<api.PortalSecurityDetail>(
    harness!, holderIdentity(email), `/api/portal/orgs/${harness!.orgId}/securities/${harness!.id(label)}`,
  )
}

describe('holder security detail', () => {
  it('answers option terms, ISO split, windows and exercises', async () => {
    harness = await readHarness({ emails: { S04: 's04@example.test' } })
    const option = await detail('OPT-1', 's04@example.test')
    expect(option).toMatchObject({
      displayId: 'OPT-1', family: 'EQUITY_COMPENSATION', optionType: 'ISO', exercisePrice: '0.1',
      numbers: { granted: '300000', outstanding: '250000', vested: '268750', exercised: '50000' },
    })
    expect(option).toMatchObject({ executionPending: null, vestingStartDate: '2023-03-01' })
    // Board-approved on the grant date; no acceleration terms recorded.
    expect(option.detail).toMatchObject({ boardApprovalDate: '2023-04-14', acceleration: null })
    expect((option.detail as api.PortalOptionDetail).isoSplit.length).toBeGreaterThan(0)
    expect((option.detail as api.PortalOptionDetail).postTerminationPeriods).toEqual([
      { period: '3', unit: 'MONTHS', reason: 'VOLUNTARY' },
      { period: '3', unit: 'MONTHS', reason: 'INVOLUNTARY' },
      { period: '0', unit: 'DAYS', reason: 'WITH_CAUSE' },
      { period: '12', unit: 'MONTHS', reason: 'DEATH' },
      { period: '12', unit: 'MONTHS', reason: 'DISABILITY' },
      { period: '3', unit: 'MONTHS', reason: 'RETIREMENT' },
    ])
    expect((option.detail as api.PortalOptionDetail).exercises)
      .toEqual([{ date: '2026-03-20', quantity: '50000', iso: '50000', nso: '0', resultingShares: [{ displayId: 'CS-7' }] }])
  })

  it('distinguishes NSO and early-exercisable option detail', async () => {
    harness = await readHarness({ emails: { S01: 'founder@example.test', S24: 'former@example.test' } })
    expect((await detail('OPT-34', 'founder@example.test')).detail).toMatchObject({ isoSplit: [] })
    expect((await detail('OPT-17', 'former@example.test')).detail).toMatchObject({
      earlyExerciseAllowed: true,
      exercises: [{ date: '2024-09-01', quantity: '72000', iso: '72000', nso: '0', resultingShares: [{ displayId: 'CS-4' }] }],
    })
  })

  it('answers restricted and exercised share origins and repurchase rights', async () => {
    harness = await readHarness({ emails: { S24: 'former@example.test', S04: 'employee@example.test' } })
    // Early-exercised shares that vest: no 83(b) on record is "not recorded", never "not required".
    expect((await detail('CS-4', 'former@example.test')).detail).toEqual({
      family: 'STOCK', pricePerShare: '0.31', form: 'uncertificated', legends: [], holdingStartDate: null,
      election83b: { status: 'NOT_RECORDED', filedOn: null },
      repurchase: { price: '0.31', window: { period: '90', unit: 'DAYS' }, lastDate: '2026-12-14', status: 'open' },
      origin: { kind: 'exercise', from: 'OPT-17' },
    })
    expect((await getJson<api.PortalSecurityDetail>(
      harness, harness.owner, `/stakeholders/${harness.id('S04')}/preview/securities/${harness.id('CS-7')}`,
    )).detail).toMatchObject({
      // Exercise shares never vested over time: no 83(b) applies.
      family: 'STOCK', form: 'uncertificated', election83b: null, origin: { kind: 'exercise', from: 'OPT-1' },
    })
  })

  it('answers the holding start, legends, acceleration, board approval and an unrecorded 83(b) as recorded', async () => {
    harness = await readHarness({ extend: withHoldingDetails, emails: { S05: 'holder@example.test', S40: 'lender@example.test' } })
    // An imported lot's legend snapshot is named, and its holding start as recorded; it never vested, so no 83(b) applies.
    expect((await detail('CS-L', 'lender@example.test')).detail).toMatchObject({
      family: 'STOCK', legends: ['Securities Act legend'], holdingStartDate: '2025-04-15', election83b: null, origin: null,
    })
    // Restricted stock of a holder still with the company: the right is described, not dated, and no 83(b) is on record.
    expect((await detail('RSA-1', 'holder@example.test')).detail).toMatchObject({
      family: 'STOCK', form: 'uncertificated', origin: null, election83b: { status: 'NOT_RECORDED', filedOn: null },
      repurchase: { price: '0.01', window: { period: '30', unit: 'DAYS' }, lastDate: null, status: null },
    })
    // An imported grant whose source had no board approval date, with acceleration terms in the agreement's words.
    const accelerated = await detail('OPT-A', 'holder@example.test')
    expect(accelerated).toMatchObject({ vestingStartDate: '2026-01-01' })
    expect(accelerated.detail).toMatchObject({
      boardApprovalDate: null,
      acceleration: { kind: 'DOUBLE_TRIGGER', text: 'Synthetic double-trigger terms for the test grant.' },
    })
  })

  it('says whose signature a grant awaits, as the execution status records it', async () => {
    // Part of each grant vested ahead of its cliff, so the exercisable count shows what the signature leaves open.
    harness = await readHarness({
      extend: (acme) => {
        for (const label of ['OPT-49', 'OPT-50']) {
          acme.b.command(`accelerate:${label}`, (c) => { c.tx('TX_VESTING_ACCELERATION', '2026-09-10', { security_id: acme.id(label), quantity: '5000', reason_text: 'Board approval' }) })
        }
      },
      emails: { S18: 'both@example.test', S12: 'company@example.test' },
    })
    // OPT-49 awaits both signatures: the holder's own is missing, so nothing of it is exercisable.
    expect(await detail('OPT-49', 'both@example.test')).toMatchObject({ executionPending: 'pending_both', numbers: { vested: '5000', exercisable: '0' } })
    // OPT-50 awaits only the company's countersignature: what has vested can be exercised meanwhile, and the overview
    // carries the same status.
    expect(await detail('OPT-50', 'company@example.test')).toMatchObject({ executionPending: 'pending_company', numbers: { vested: '5000', exercisable: '5000' } })
    const overview = await getJson<api.PortalOverview>(harness, holderIdentity('company@example.test'), '/api/portal/overview')
    const listed = overview.holdings[0]!.securities
    expect(listed.find((security) => security.displayId === 'OPT-50')!.executionPending).toBe('pending_company')
    expect(listed.filter((security) => security.displayId !== 'OPT-50').every((security) => security.executionPending === null)).toBe(true)
  })

  it('never gives a lot whose agreement sets no repurchase deadline the plan default window, before or after the holder leaves', async () => {
    harness = await readHarness({ extend: withNoDeadlineLots, emails: { S05: 'holder@example.test', S24: 'former@example.test' } })
    expect((await detail('RSA-N', 'holder@example.test')).detail).toMatchObject({
      repurchase: { price: '0.01', window: null, lastDate: null, status: null },
    })
    expect((await detail('RSA-M', 'former@example.test')).detail).toMatchObject({
      repurchase: { price: '0.01', window: null, lastDate: null, status: 'no_deadline' },
    })
  })

  it('gives an imported document the date it was uploaded where it came from, beside the import date', async () => {
    harness = await readHarness({ emails: { S04: 's04@example.test' } })
    const uploadedAt = Date.UTC(2023, 4, 2, 15, 30)
    const document = await addDocument(harness.db, harness.orgId, 'GRANT_AGREEMENT', { holderVisible: true })
    await harness.db.prepare('UPDATE documents SET source_created_at = ?, version = version + 1 WHERE id = ?').bind(uploadedAt, document).run()
    await harness.db.prepare(
      `INSERT INTO document_links (id, org_id, document_id, role, security_id, created_by, created_at)
       VALUES (?, ?, ?, 'AGREEMENT', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), harness.orgId, document, harness.id('OPT-1'), SEED_USER_ID, Date.now()).run()
    const option = await detail('OPT-1', 's04@example.test')
    expect(option.documents).toContainEqual(expect.objectContaining({ id: document, sourceCreatedAt: uploadedAt }))
    const listed = await getJson<api.PortalDocumentList>(harness, holderIdentity('s04@example.test'), `/api/portal/orgs/${harness.orgId}/documents`)
    expect(listed.find((item) => item.id === document)).toMatchObject({ scope: 'mine', sourceCreatedAt: uploadedAt })
  })

  it('answers warrant and SAFE details without exposing another holder security', async () => {
    harness = await readHarness({ emails: { S40: 'warrant@example.test', S34: 'safe@example.test' } })
    expect(await detail('WAR-1', 'warrant@example.test')).toMatchObject({
      family: 'WARRANT', exercisePrice: '0.44', expirationDate: '2035-04-01', detail: { family: 'WARRANT' },
    })
    expect(await detail('SAFE-1', 'safe@example.test')).toMatchObject({
      family: 'CONVERTIBLE', status: 'CONVERTED', convertedInto: [{ displayId: 'PS-1' }],
      detail: { family: 'CONVERTIBLE', principal: '250000', conversion: { quantity: '520833', className: 'Series Seed Preferred' } },
    })
    expect((await harness.api(
      'GET', `/api/portal/orgs/${harness.orgId}/securities/${harness.id('SAFE-2')}`, holderIdentity('safe@example.test'),
    )).status).toBe(404)
  })

  it('keeps admin holding-preview detail byte-for-byte equal to the holder result', async () => {
    harness = await readHarness({ emails: { S04: 's04@example.test' } })
    const own = await detail('OPT-1', 's04@example.test')
    for (const identity of [harness.owner, harness.admin, harness.reader]) {
      expect(await getJson(
        harness, identity, `/stakeholders/${harness.id('S04')}/preview/securities/${harness.id('OPT-1')}`,
      )).toEqual(own)
    }
    expect((await harness.api(
      'GET', harness.path(`/stakeholders/${harness.id('S04')}/preview/securities/${harness.id('OPT-2')}`), harness.owner,
    )).status).toBe(404)
  })
})
