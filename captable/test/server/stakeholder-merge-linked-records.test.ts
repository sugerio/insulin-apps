import { describe, expect, it } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import { VALUATIONS, type Acme } from '../shared/engine/fixtures/acme.ts'
import { usd } from '../shared/engine/fixtures/builder.ts'
import {
  ACME_NOW,
  addDocument,
  commit,
  count,
  getJson,
  holderName,
  ledgerHarness,
  runCommand,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

const REASON = 'Synthetic duplicate import record'

function valuationFor(date: string): string {
  let id = VALUATIONS[0]!.id
  for (const valuation of VALUATIONS) if (valuation.effectiveDate <= date) id = valuation.id
  return id
}

/** Two records each hold an ISO worth $66,500 first exercisable in 2026; one identity would cross the $100K limit. */
function twoIsos(acme: Acme): void {
  const { b, id, cls, plan } = acme
  b.stakeholder('S60', 'employee', { countryOfResidence: 'US' })
  b.stakeholder('S61', 'employee', { countryOfResidence: 'US' })
  for (const [label, holder] of [['ISO-960', 'S60'], ['ISO-961', 'S61']] as const) {
    b.command(`grant:${label}`, (command) => {
      const option = command.security(label, {
        family: 'EQUITY_COMPENSATION', subtype: 'OPTION_ISO', stakeholderId: id(holder), stockClassId: cls.CS,
        stockPlanId: plan, parentSecurityId: null,
      })
      const terms = b.vestingTerms(`vt:${label}`, { type: 'EXPLICIT', events: [{ date: '2026-01-02', quantity: '70000' }] })
      command.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2025-11-03', {
        security_id: option, custom_id: label, stakeholder_id: id(holder), stock_plan_id: plan, stock_class_id: cls.CS,
        compensation_type: 'OPTION_ISO', quantity: '70000', exercise_price: usd('0.95'), early_exercisable: false,
        vesting_terms_id: terms.id, expiration_date: '2035-11-03',
        termination_exercise_windows: [{ reason: 'VOLUNTARY_OTHER', period: 3, period_type: 'MONTHS' }],
        board_approval_date: '2025-11-03', x_definition_sha256: terms.sha,
        x_fmv: { price_per_share: usd('0.95'), valuation_id: valuationFor('2025-11-03'), source: 'IMPORTED' },
        x_exemption: { federal: 'RULE_701' },
      })
      command.tx('TX_VESTING_START', '2025-11-03', { security_id: option, x_vesting_start_date: '2025-11-03' })
    })
  }
}

function mergeBody(l: LedgerHarness, merged = 'S05', survivor = 'S04') {
  const confirmation = Number(merged.slice(1)) <= 43 ? holderName(merged) : holderName(l.id(merged).slice(0, 8))
  return { mergedStakeholderId: l.id(merged), survivingStakeholderId: l.id(survivor), reason: REASON, confirmation }
}

describe('stakeholder merge linked-record safety', () => {
  it('refuses a merge that would reclassify ISO grants across the $100K limit', async () => {
    const l = await ledgerHarness({ extend: twoIsos })
    const body = mergeBody(l, 'S61', 'S60')
    const dry = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, body)
    expect(dry.status).toBe(200)
    const preview = await dry.json() as api.CommandResult
    expect(preview.violations).toContainEqual(expect.objectContaining({ code: 'STAKEHOLDER_MERGE_NOT_NEUTRAL' }))
    expect(preview.stakeholderMerge?.blockingItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'economic_change', label: expect.stringMatching(/ISO-96[01]/) }),
    ]))
    expect((await runCommand(l, l.sa, 'merge-stakeholders', body)).response.status).toBe(422)
  })

  it("moves B's document link to A, lists the document on A's admin page, and gives it back to B on an undo", async () => {
    const l = await ledgerHarness()
    const documentId = await addDocument(l.db, l.orgId, 'OTHER')
    const linkId = crypto.randomUUID()
    await l.db.prepare(
      "INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
    ).bind(linkId, l.orgId, documentId, l.id('S05'), ACME_NOW - 30_000).run()
    const listed = async (label: string) => (await getJson<api.DocumentPage>(l, l.sa, `/documents?targetType=stakeholder&targetId=${l.id(label)}`))
      .items.map((item) => item.id)

    // Without frozen records every live link moves with the identity, recorded so an undo can move it back.
    const merged = await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    expect(await l.db.prepare('SELECT stakeholder_id FROM document_links WHERE id = ?').bind(linkId).first('stakeholder_id')).toBe(l.id('S04'))
    expect(await count(l.db, 'SELECT COUNT(*) AS n FROM stakeholder_merge_link_moves WHERE row_id = ?', linkId)).toBe(1)
    expect(await listed('S04')).toContain(documentId)
    expect(await listed('S05')).not.toContain(documentId)

    const preview = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${merged.commandId}/reversal-preview`)
    const undone = await l.api('POST', l.path('/commands/reverse-command'), l.sa, {
      commandId: merged.commandId, note: 'Synthetic undo', confirmation: holderName('S05'),
      expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256,
    })
    expect(undone.status, await undone.clone().text()).toBe(200)
    expect(await listed('S05')).toContain(documentId)
    expect(await listed('S04')).not.toContain(documentId)
  })

  it('shows a B lot under A in an expiry run after the merge', async () => {
    const l = await ledgerHarness()
    await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    const candidates = [{
      securityId: l.id('OPT-2'), displayId: 'OPT-2', reason: 'expiration', quantity: '1',
      lastExerciseDate: '2026-10-25', effectiveDate: '2026-10-26',
    }]
    const run = await l.db.prepare(
      'INSERT INTO expiry_runs (org_id, org_seq, local_date, candidates, created_at) VALUES (?, 1, ?, ?, ?) RETURNING org_seq',
    ).bind(l.orgId, '2026-10-26', JSON.stringify(candidates), ACME_NOW).first<{ org_seq: number }>()
    const survivor = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S04')}`)
    const expiry = await getJson<api.ExpiryRunDetail>(l, l.sa, `/expiry-runs/${run!.org_seq}`)
    expect(expiry.proposals).toContainEqual(expect.objectContaining({
      displayId: 'OPT-2', holder: expect.objectContaining({ stakeholderId: l.id('S04'), name: survivor.displayName }),
    }))
  })

  it("makes a document linked to A's and B's lots holder-visible after the merge", async () => {
    const l = await ledgerHarness()
    const documentId = await addDocument(l.db, l.orgId, 'OTHER')
    for (const securityId of [l.id('OPT-1'), l.id('OPT-2')]) {
      await l.db.prepare(
        "INSERT INTO document_links (id, org_id, document_id, role, security_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
      ).bind(crypto.randomUUID(), l.orgId, documentId, securityId, ACME_NOW).run()
    }
    await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    const document = await getJson<api.DocumentDetail>(l, l.sa, `/documents/${documentId}`)
    const response = await l.api('POST', l.path(`/documents/${documentId}/holder-visibility`), l.sa, {
      visible: true, version: document.version,
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await response.json() as api.DocumentDetail).holderVisible).toBe(true)
  })

  it('labels missing dependency edges with command actions, dates and lot display ids', async () => {
    const l = await ledgerHarness()
    for (const stakeholder of ['S04', 'S05'] as const) {
      await commit(l, l.rw, 'terminate-stakeholder', {
        stakeholderId: l.id(stakeholder), terminationDate: '2026-10-19', terminationType: 'voluntary',
      })
    }
    const dry = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, mergeBody(l))
    const preview = await dry.json() as api.CommandResult
    expect(dry.status).toBe(200)
    const labels = preview.stakeholderMerge?.blockingItems
      .filter((item) => item.type === 'dependency_edge').map((item) => item.label) ?? []
    expect(labels.length).toBeGreaterThan(0)
    expect(labels).toContainEqual(expect.stringMatching(/OPT-\d+.*termination \(2026-10-19\).*depends on.*vesting \(\d{4}-\d{2}-\d{2}\)/))
    for (const label of labels) expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it("shows only B's original-lot exercises on B's merged-record page", async () => {
    const l = await ledgerHarness()
    await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    const survivor = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S04')}`)
    const merged = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S05')}`)
    expect(survivor.exercises).toContainEqual(expect.objectContaining({ grantDisplayId: 'OPT-1' }))
    expect(merged.mergedInto).toMatchObject({ id: l.id('S04') })
    expect(merged.exercises).toEqual([])
  })
})
