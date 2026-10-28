import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { getJson, holderIdentity, readHarness, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

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
    expect((await detail('CS-4', 'former@example.test')).detail).toEqual({
      family: 'STOCK', pricePerShare: '0.31', form: 'uncertificated', legends: [], election83b: null,
      repurchase: { price: '0.31', window: { period: '90', unit: 'DAYS' }, lastDate: '2026-12-14', status: 'open' },
      origin: { kind: 'exercise', from: 'OPT-17' },
    })
    expect((await getJson<api.PortalSecurityDetail>(
      harness, harness.owner, `/stakeholders/${harness.id('S04')}/preview/securities/${harness.id('CS-7')}`,
    )).detail).toMatchObject({
      family: 'STOCK', form: 'uncertificated', origin: { kind: 'exercise', from: 'OPT-1' },
    })
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
    for (const identity of [harness.owner, harness.admin, harness.editor]) {
      expect(await getJson(
        harness, identity, `/stakeholders/${harness.id('S04')}/preview/securities/${harness.id('OPT-1')}`,
      )).toEqual(own)
    }
    expect((await harness.api(
      'GET', harness.path(`/stakeholders/${harness.id('S04')}/preview/securities/${harness.id('OPT-2')}`), harness.owner,
    )).status).toBe(404)
  })
})
