import { afterEach, describe, expect, it } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
import { ByteBoundedLru } from '../../src/app/server/lib/read/cache.ts'
import { ledgerCache, LEDGER_CACHE_BYTES } from '../../src/app/server/lib/read/ledger.ts'
import {
  ACME_NOW,
  addDocument,
  commit,
  getJson,
  readHarness,
  recordCommittedImport,
  SEED_USER_ID,
  VS1_TEMPLATE_ID,
  type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

const ratio = (value: string) => engine.Rational.from(value)

describe('read endpoints on the synthetic Acme ledger', () => {
  it('serves the dashboard, cap table, securities status and company golden values', async () => {
    harness = await readHarness()
    const dashboard = await getJson<api.DashboardResponse>(harness, harness.owner, '/dashboard')
    expect(dashboard.company).toEqual({
      totalCapitalContribution: '16147718.6', fullyDilutedShares: '24312120', stakeholdersWithSecurities: 38,
    })
    expect(dashboard.employeeEquity).toEqual([expect.objectContaining({
      stockPlanId: harness.id('plan:P1'), granted: '4039250', available: '460750', usedPct: '16157/18000',
    })])
    expect(dashboard.needsAttention.map(({ kind, count }) => [kind, count])).toEqual([
      ['EXECUTION_PENDING', 6], ['SCHEDULED_TERMINATION', 0], ['ISO_DEADLINE_SOON', 0],
      ['REPURCHASE_WINDOW_CLOSING', 0], ['VALUATION_STATUS', 1],
    ])

    const table = await getJson<api.CapTableResponse>(harness, harness.owner, '/cap-table')
    expect(table).toMatchObject({
      asOf: '2026-10-21', engineVersion: engine.ENGINE_VERSION,
      metrics: {
        issuedAndOutstanding: '19945120', fullyDiluted: '24312120', planAvailable: '460750',
        capitalContribution: '16147718.6', executionPendingAwards: '130000',
      },
    })
    const s01 = table.ownership!.find((row) => row.stakeholderId === harness!.id('S01'))!
    expect(s01).toMatchObject({ name: 'Synthetic Holder S01', relationship: 'founder', fullyDiluted: '4300000' })
    expect(ratio(s01.fullyDilutedPct).roundTo(4, 'HALF_EVEN').toString()).toBe('0.1769')
    const then = await getJson<api.CapTableResponse>(harness, harness.owner, '/cap-table?asOf=2025-12-31&tab=options')
    expect(then.metrics).toMatchObject({ planAvailable: '798000', fullyDiluted: '24312120' })
    expect((then.rows ?? []).reduce((sum, row) => sum.add(row.numbers!.outstanding), engine.Dec.ZERO).toString()).toBe('3570000')
    expect((await getJson<api.CapTableResponse>(harness, harness.owner, '/cap-table?tab=safes')).safes).toHaveLength(12)
    expect((await harness.api('GET', harness.path('/cap-table?tab=everything'), harness.owner)).status).toBe(400)

    const status = await getJson<api.SecuritiesStatus>(harness, harness.owner, '/securities-status')
    expect(status.executionPending.map((row) => row.displayId).sort()).toEqual(['OPT-49', 'OPT-50', 'OPT-51', 'OPT-53', 'OPT-55', 'OPT-56'])
    expect(status.optionsFromTerminated.map((row) => row.securityId)).toEqual([harness.id('OPT-26'), harness.id('OPT-20')])
    expect(await getJson<api.Org>(harness, harness.editor, '')).toMatchObject({
      id: harness.orgId, legalName: 'Acme Robotics, Inc.', ledgerSeq: harness.acme.b.headSeq,
      shareUnitFrozen: true, settings: { expiry: { mode: 'report_only' } },
    })
  })

  it('serves securities, vesting, timeline and termination previews', async () => {
    harness = await readHarness()
    expect((await getJson<api.SecurityList>(harness, harness.owner, '/securities?family=EQUITY_COMPENSATION')).items).toHaveLength(56)
    const option = await getJson<api.SecurityDetail>(harness, harness.owner, `/securities/${harness.id('OPT-1')}`)
    expect(option).toMatchObject({
      displayId: 'OPT-1', stakeholderName: 'Synthetic Holder S04', subtype: 'OPTION_ISO', status: 'OUTSTANDING',
      executionStatus: 'executed', numbers: { exercised: '50000', outstanding: '250000', vested: '268750' },
      exemption: { federal: 'RULE_701' }, provenance: { importedFromPulley: true, pulleyId: 'security_syn-OPT-1' },
    })
    expect(option.lineage.children).toEqual([{ id: harness.id('CS-7'), displayId: 'CS-7', transactionType: 'TX_EQUITY_COMPENSATION_EXERCISE' }])
    const vesting = await getJson<api.SecurityVesting>(harness, harness.owner, `/securities/${harness.id('OPT-1')}/vesting`)
    expect(vesting).toMatchObject({ quantity: '300000', vested: '268750', unvested: '31250' })
    const timeline = await getJson<{ items: api.TimelineEntry[] }>(harness, harness.owner, `/securities/${harness.id('OPT-1')}/timeline`)
    expect(timeline.items[0]).toMatchObject({ kind: 'transaction', type: 'TX_EQUITY_COMPENSATION_ISSUANCE' })
    const preview = await getJson<api.TerminationPreview>(
      harness, harness.owner,
      `/securities/${harness.id('OPT-18')}/termination-preview?terminationDate=2026-12-04&terminationType=voluntary`,
    )
    expect(preview).toMatchObject({ vested: '50625', unvested: '39375', contractualDeadline: '2027-03-04' })
    expect((await harness.api('GET', harness.path('/securities/not-a-uuid'), harness.owner)).status).toBe(404)
  })

  it('serves stakeholder lists, holdings, portal preview and ISO split with console PII', async () => {
    harness = await readHarness({ emails: { S04: 's04.holder@example.test' } })
    await harness.db.prepare("UPDATE stakeholders SET phone = '+1 555 0100', version = version + 1 WHERE id = ?")
      .bind(harness.id('S04')).run()
    for (const identity of [harness.owner, harness.admin, harness.editor]) {
      const list = await getJson<api.StakeholderList>(harness, identity, '/stakeholders')
      const s04 = list.items.find((row) => row.id === harness!.id('S04'))!
      expect(s04).toMatchObject({ displayName: 'Synthetic Holder S04', phone: '+1 555 0100' })
      expect(s04.emails[0]!.email).toBe('s04.holder@example.test')
    }
    const detail = await getJson<api.StakeholderDetail>(harness, harness.owner, `/stakeholders/${harness.id('S04')}`)
    expect(detail.exercises.map((exercise) => exercise.grantDisplayId)).toEqual(['OPT-1'])
    const holdings = await getJson<api.StakeholderHoldings>(harness, harness.owner, `/stakeholders/${harness.id('S04')}/holdings`)
    expect(holdings.items.map((security) => security.displayId).sort()).toEqual(['CS-7', 'OPT-1', 'OPT-16', 'OPT-37'])
    const preview = await getJson<api.PortalOverview>(harness, harness.editor, `/stakeholders/${harness.id('S04')}/preview`)
    expect(api.findForbiddenKeys(preview)).toEqual([])
    const split = await getJson<api.IsoSplit>(harness, harness.owner, `/stakeholders/${harness.id('S13')}/iso-split`)
    expect(split.years.find((entry) => entry.year === 2026)!.lots)
      .toEqual([expect.objectContaining({ displayId: 'OPT-33', isoQuantity: '105263', nsoQuantity: '3070' })])
  })

  it('serves structure and a pure vesting preview to EDITOR', async () => {
    harness = await readHarness()
    const classes = await getJson<api.StockClassList>(harness, harness.owner, '/stock-classes')
    expect(classes.items.find((entry) => entry.name === 'Common Stock')).toMatchObject({
      authorizedShares: '30000000', numbers: { issuedAndOutstanding: '9743000', fullyDiluted: '14060000' },
    })
    const plan = await getJson<api.StockPlanDetail>(harness, harness.owner, `/stock-plans/${harness.id('plan:P1')}`)
    expect(plan.returnRules).toMatchObject({ cancelledUnvestedAwards: 'RETURN', repurchasedVestedShares: 'RETIRE' })
    expect((await getJson<api.VestingTermsList>(harness, harness.owner, '/vesting-terms?templates=true')).items.map((entry) => entry.id))
      .toEqual([VS1_TEMPLATE_ID])
    const response = await harness.api('POST', harness.path('/vesting-terms/preview'), harness.editor, {
      definition: {
        type: 'SCHEDULE', totalMonths: 48, frequency: 'MONTHLY',
        cliff: { months: 12, quantityRule: 'RATABLE' }, dayRule: 'SAME_DAY_CLAMPED',
      },
      quantity: '40000', vestingStartDate: '2026-10-19',
    })
    expect(response.status).toBe(200)
    expect((await response.json() as api.VestingPreviewResponse).events).toHaveLength(37)
  })

  it('serves valuations, ledger history, exercises and retained records', async () => {
    harness = await readHarness()
    await harness.db.prepare(
      `INSERT INTO valuation_events (id, org_id, valuation_id, kind, event_date, description, created_by, created_at)
       VALUES (?, ?, ?, 'MATERIAL_EVENT', '2024-01-01', 'Synthetic event', ?, ?)`,
    ).bind(crypto.randomUUID(), harness.orgId, harness.id('V1'), SEED_USER_ID, Date.now()).run()
    const valuations = await getJson<api.ValuationList>(harness, harness.editor, '/valuations')
    expect(valuations.items.map((entry) => [entry.name, entry.status])).toEqual([
      ['409A V5', 'expiring_soon'], ['409A V4', 'superseded'], ['409A V3', 'superseded'],
      ['409A V2', 'superseded'], ['409A V1', 'superseded'],
    ])
    expect((await getJson<api.FmvResponse>(harness, harness.owner, '/valuations/fmv?date=2026-10-21')).fmv)
      .toMatchObject({ valuationId: harness.id('V5'), pricePerShare: '0.95' })
    const page = await getJson<api.TransactionPage>(harness, harness.owner, '/transactions?limit=50')
    expect(page.items).toHaveLength(50)
    expect(page.items[0]!.seq).toBe(harness.acme.b.headSeq)
    const transaction = await getJson<api.TransactionDetail>(harness, harness.owner, `/transactions/${page.items[0]!.id}`)
    expect(transaction.command).toMatchObject({ type: 'terminate-stakeholder', actorKind: 'user' })
    expect((await getJson<{ items: api.ExerciseRecord[] }>(harness, harness.owner, '/exercises')).items.map((entry) => entry.grantDisplayId).sort())
      .toEqual(['OPT-1', 'OPT-15', 'OPT-17', 'OPT-23', 'OPT-3'])
    for (const path of ['/exercise-requests', '/signature-requests', '/certificates', '/legends', '/certificate-terms', '/elections-83b']) {
      expect((await getJson<{ items: unknown[] }>(harness, harness.owner, path)).items, path).toEqual([])
    }
  })

  it('labels imported records and activity with the committed spreadsheet source', async () => {
    harness = await readHarness()
    await recordCommittedImport(harness.db, harness.orgId, 'template')
    const imported = harness.acme.b.reference.commands.find((command) => command.actorKind === 'import')!
    const transaction = harness.acme.b.transactions.find((item) => item.commandId === imported.id)!
    const detail = await getJson<api.TransactionDetail>(harness, harness.owner, `/transactions/${transaction.id}`)
    expect(detail.command.actor).toBe('Imported from the spreadsheet')

    await harness.db.prepare(
      `INSERT INTO audit_events (occurred_at, org_id, actor_kind, action, target_type, target_id, result, details)
       VALUES (?, ?, 'import', 'import.committed', 'import_run', ?, 'success', '{}')`,
    ).bind(ACME_NOW, harness.orgId, crypto.randomUUID()).run()
    const dashboard = await getJson<api.DashboardResponse>(harness, harness.owner, '/dashboard')
    expect(dashboard.recentActivity[0]?.actor).toBe('Imported from the spreadsheet')
  })

  it('returns one active company and preserves full PII for console administrators', async () => {
    harness = await readHarness()
    await harness.db.prepare("UPDATE orgs SET ein = '12-3456789', version = version + 1 WHERE id = ?")
      .bind(harness.orgId).run()
    for (const identity of [harness.owner, harness.admin, harness.editor]) {
      const companies = await getJson<api.OrgList>(harness, identity, '/api/orgs')
      expect(companies.items).toHaveLength(1)
      expect(companies.items[0]).toMatchObject({ id: harness.orgId, ein: '12-3456789' })
    }
  })

  it('answers as of a known sequence before a later command', async () => {
    harness = await readHarness()
    const head = harness.acme.b.headSeq
    await commit(harness, harness.admin, 'cancel-security', {
      securityId: harness.id('WAR-1'), effectiveDate: '2026-10-21', reason: 'MUTUAL_AGREEMENT',
      documentId: await addDocument(harness.db, harness.orgId, 'OTHER'), confirmation: 'WAR-1',
    })
    const current = await getJson<api.CapTableResponse>(harness, harness.owner, '/cap-table')
    const before = await getJson<api.CapTableResponse>(harness, harness.owner, `/cap-table?asKnownAt=${head}`)
    expect(BigInt(before.metrics.fullyDiluted) - BigInt(current.metrics.fullyDiluted)).toBe(60000n)
    expect(before).toMatchObject({ asKnownAt: head, ledgerSeq: head + 1 })
  })
})

describe('the replay cache', () => {
  it('is byte bounded and evicts the least recently used', () => {
    const cache = new ByteBoundedLru<string>(100)
    expect(cache.set('a', 'A', 40)).toBe(true)
    expect(cache.set('b', 'B', 40)).toBe(true)
    expect(cache.get('a')).toBe('A')
    expect(cache.set('c', 'C', 40)).toBe(true)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.set('huge', 'H', 101)).toBe(false)
  })

  it('keeps one entry per company head and replaces it after a command', async () => {
    harness = await readHarness()
    ledgerCache().clear()
    await getJson(harness, harness.owner, '/dashboard')
    expect(ledgerCache().size).toBe(1)
    expect(ledgerCache().bytes).toBeLessThanOrEqual(LEDGER_CACHE_BYTES)
    await commit(harness, harness.admin, 'record-leave-of-absence', {
      stakeholderId: harness.id('S05'), startDate: '2026-10-01', endDate: null, returnGuaranteed: true,
    })
    await getJson(harness, harness.owner, '/dashboard')
    expect(ledgerCache().size).toBe(1)
  })
})
