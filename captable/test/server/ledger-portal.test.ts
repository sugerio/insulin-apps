import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import {
  getJson, holderIdentity, readHarness, type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

function walk(json: unknown) {
  expect(api.findForbiddenKeys(json)).toEqual([])
}

describe('holder portal over the synthetic Acme ledger', () => {
  it('shows exactly the matching holder securities and 404s anything else', async () => {
    harness = await readHarness({ emails: { S04: 's04.holder@example.test' } })
    const holder = holderIdentity('S04.HOLDER@example.test')
    const me = api.meResponseSchema.parse(await getJson(harness, holder, '/api/me'))
    expect(me.portal.matches.map((match) => match.stakeholderId)).toEqual([harness.id('S04')])
    const overview = api.portalOverviewSchema.parse(await getJson(harness, holder, '/api/portal/overview'))
    walk(overview)
    expect(overview.holdings).toHaveLength(1)
    expect(overview.holdings[0]!.securities.map((security) => security.displayId).sort())
      .toEqual(['CS-7', 'OPT-1', 'OPT-16', 'OPT-37'])
    expect(overview.holdings[0]!.securities.find((security) => security.displayId === 'OPT-1')).toMatchObject({
      optionType: 'ISO', planName: '2023 Equity Incentive Plan', exercisePrice: '0.1', status: 'OUTSTANDING',
      numbers: { granted: '300000', outstanding: '250000', vested: '268750', exercised: '50000', exercisable: '218750' },
    })
    const detail = api.portalSecurityDetailSchema.parse(await getJson(
      harness, holder, `/api/portal/orgs/${harness.orgId}/securities/${harness.id('OPT-37')}`,
    ))
    walk(detail)
    expect(detail.vesting[0]).toMatchObject({ date: '2026-11-20', quantity: '30000', status: 'UPCOMING' })
    expect((await harness.api('GET', `/api/portal/orgs/${harness.orgId}/securities/${harness.id('OPT-2')}`, holder)).status).toBe(404)
    expect((await harness.api('GET', `/api/portal/orgs/${harness.orgId}/securities/${harness.id('OPT-404')}`, holder)).status).toBe(404)
  })

  it('supports historical holder views and admin preview parity', async () => {
    harness = await readHarness({ emails: { S04: 's04.holder@example.test' } })
    const holder = holderIdentity('s04.holder@example.test')
    const current = await getJson<api.PortalOverview>(harness, holder, '/api/portal/overview')
    const past = await getJson<api.PortalOverview>(harness, holder, '/api/portal/overview?asOf=2025-01-01')
    expect(past.asOf).toBe('2025-01-01')
    expect(past.holdings[0]!.securities.map((security) => security.displayId).sort()).toEqual(['OPT-1', 'OPT-16'])
    for (const identity of [harness.owner, harness.admin, harness.editor]) {
      expect(await getJson(harness, identity, `/stakeholders/${harness.id('S04')}/preview`)).toEqual(current)
    }
  })

  it('lists SAFE conversion results only from the caller own holdings', async () => {
    harness = await readHarness({ emails: { S34: 's34.investor@example.test' } })
    const holder = holderIdentity('s34.investor@example.test')
    const overview = await getJson<api.PortalOverview>(harness, holder, '/api/portal/overview')
    walk(overview)
    const own = overview.holdings[0]!.securities
    expect(own.find((security) => security.displayId === 'SAFE-1')).toMatchObject({
      family: 'CONVERTIBLE', status: 'CONVERTED', convertedInto: [{ displayId: 'PS-1' }],
    })
    expect(own.find((security) => security.displayId === 'PS-7')?.numbers.outstanding).toBe('234875')
    expect(own.some((security) => security.displayId === 'SAFE-2')).toBe(false)
  })

  it('matches every self e-mail record and excludes contact-only addresses', async () => {
    harness = await readHarness({ emails: { S04: 'shared@example.test', S05: 'other@example.test' } })
    await harness.db.prepare(
      `INSERT INTO stakeholder_emails
       (id, org_id, stakeholder_id, email, kind, created_at)
       VALUES (?, ?, ?, 'shared@example.test', 'self', ?)`,
    ).bind(crypto.randomUUID(), harness.orgId, harness.id('S05'), Date.now()).run()
    await harness.db.prepare(
      `INSERT INTO stakeholder_emails
       (id, org_id, stakeholder_id, email, kind, created_at)
       VALUES (?, ?, ?, 'contact-only@example.test', 'contact', ?)`,
    ).bind(crypto.randomUUID(), harness.orgId, harness.id('S06'), Date.now()).run()
    const shared = await getJson<api.PortalOverview>(harness, holderIdentity('shared@example.test'), '/api/portal/overview')
    expect(shared.holdings.map((holding) => holding.stakeholderId).sort()).toEqual([harness.id('S04'), harness.id('S05')].sort())
    expect((await harness.api('GET', '/api/portal/overview', holderIdentity('contact-only@example.test'))).status).toBe(404)
  })

  it('serves how-to-exercise contact and current payment details', async () => {
    harness = await readHarness({ emails: { S04: 's04.holder@example.test' } })
    const details = {
      bankName: 'Example Bank', beneficiaryName: 'Acme Robotics, Inc.', beneficiaryAddress: '1 Main Street',
      accountNumber: '000111222333', routingNumber: '021000021', iban: 'GB29NWBK60161331927766',
      swift: 'EXAMPLT1', referenceFormat: 'Holder and grant',
    }
    expect((await harness.api('POST', harness.path('/payment-instructions'), harness.owner, { details, updatedAt: null })).status).toBe(200)
    const holder = holderIdentity('s04.holder@example.test')
    const howTo = await getJson<api.HowToExercise>(harness, holder, `/api/portal/orgs/${harness.orgId}/how-to-exercise`)
    expect(howTo).toMatchObject({
      noticeForm: null, privacyNotice: null, paymentInstructions: details,
      companyContact: { name: 'Acme Equity Team', email: 'equity@example.test' },
    })
    expect(await getJson(harness, harness.owner, `/stakeholders/${harness.id('S04')}/preview/how-to-exercise`))
      .toMatchObject({ paymentInstructions: details })
    expect(await getJson(harness, harness.editor, `/stakeholders/${harness.id('S04')}/preview/how-to-exercise`))
      .toMatchObject({ paymentInstructions: { ...details, accountNumber: '••••2333', iban: '••••7766' } })
  })
})
