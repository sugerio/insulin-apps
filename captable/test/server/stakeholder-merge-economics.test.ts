import { describe, expect, it } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import { verifyOrgLedger } from '../../src/app/server/lib/ledger/verify.ts'
import { VALUATIONS, type Acme } from '../shared/engine/fixtures/acme.ts'
import { usd } from '../shared/engine/fixtures/builder.ts'
import {
  ACME_NOW,
  ADMIN_EMAIL,
  SEED_USER_ID,
  VS1_TEMPLATE_ID,
  addDocument,
  addEmail,
  commit,
  errorOf,
  getJson,
  holderName,
  ledgerHarness,
  linkAdmin,
  runCommand,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

const REASON = 'Synthetic duplicate import record'

function valuationFor(date: string): string {
  let id = VALUATIONS[0]!.id
  for (const valuation of VALUATIONS) if (valuation.effectiveDate <= date) id = valuation.id
  return id
}

/** A owns two stock lots; B fully exercised one ISO into a third stock lot. */
function realCase(acme: Acme): void {
  const { b, id, cls, plan } = acme
  b.stakeholder('S50', 'founder', { countryOfResidence: 'US' })
  b.stakeholder('S51', 'founder', { countryOfResidence: 'US' })
  b.command('seed:founder-a', (command) => {
    for (const [label, quantity] of [['CS-950', '2600000'], ['CS-951', '1650000']] as const) {
      const lot = command.security(label, {
        family: 'STOCK', subtype: 'COMMON', stakeholderId: id('S50'), stockClassId: cls.CS,
        stockPlanId: null, parentSecurityId: null,
      })
      command.tx('TX_STOCK_ISSUANCE', '2021-02-15', {
        security_id: lot, custom_id: label, stakeholder_id: id('S50'), stock_class_id: cls.CS,
        share_price: usd('0.0001'), quantity, issuance_type: 'FOUNDERS_STOCK', x_origin: 'FOUNDERS_STOCK',
      })
    }
  })
  b.command('grant:OPT-950', (command) => {
    const option = command.security('OPT-950', {
      family: 'EQUITY_COMPENSATION', subtype: 'OPTION_ISO', stakeholderId: id('S51'), stockClassId: cls.CS,
      stockPlanId: plan, parentSecurityId: null,
    })
    const terms = b.vestingTerms('vt:OPT-950', { type: 'EXPLICIT', events: [{ date: '2026-01-02', quantity: '345641' }] })
    command.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2025-11-03', {
      security_id: option, custom_id: 'OPT-950', stakeholder_id: id('S51'), stock_plan_id: plan, stock_class_id: cls.CS,
      compensation_type: 'OPTION_ISO', quantity: '345641', exercise_price: usd('0.1'), early_exercisable: false,
      vesting_terms_id: terms.id, expiration_date: '2035-11-03',
      termination_exercise_windows: [{ reason: 'VOLUNTARY_OTHER', period: 3, period_type: 'MONTHS' }],
      board_approval_date: '2025-11-03', x_definition_sha256: terms.sha,
      x_fmv: { price_per_share: usd('0.1'), valuation_id: valuationFor('2025-11-03'), source: 'IMPORTED' },
      x_exemption: { federal: 'RULE_701' },
    })
    command.tx('TX_VESTING_START', '2025-11-03', { security_id: option, x_vesting_start_date: '2025-11-03' })
  })
  b.command('exercise:OPT-950', (command) => {
    const stock = command.security('CS-952', {
      family: 'STOCK', subtype: 'COMMON', stakeholderId: id('S51'), stockClassId: cls.CS,
      stockPlanId: plan, parentSecurityId: id('OPT-950'),
    })
    command.tx('TX_EQUITY_COMPENSATION_EXERCISE', '2026-02-02', {
      security_id: id('OPT-950'), quantity: '345641', resulting_security_ids: [stock], x_exercise_price: usd('0.1'),
      x_exercise_cost: usd('34564.1'),
      x_fmv: { price_per_share: usd('0.31'), valuation_id: valuationFor('2026-02-02'), source: 'IMPORTED' },
      x_portions: [{ portion: 'ISO', quantity: '345641', security_id: stock }],
      x_lots_consumed: { iso: '345641', nso: '0' },
    })
    command.tx('TX_STOCK_ISSUANCE', '2026-02-02', {
      security_id: stock, custom_id: 'CS-952', stakeholder_id: id('S51'), stock_class_id: cls.CS,
      stock_plan_id: plan, share_price: usd('0.1'), quantity: '345641', x_origin: 'EXERCISE',
      x_source_security_id: id('OPT-950'), x_portion: 'ISO',
    })
  })
}

/** The typed confirmation is the merged record's name (holders past S43 are named by their id's first eight digits). */
function mergeBody(l: LedgerHarness, merged = 'S05', survivor = 'S04') {
  const mergedName = Number(merged.slice(1)) <= 43 ? holderName(merged) : holderName(l.id(merged).slice(0, 8))
  return { mergedStakeholderId: l.id(merged), survivingStakeholderId: l.id(survivor), reason: REASON, confirmation: mergedName }
}

async function reverse(l: LedgerHarness, commandId: string, confirmation: string): Promise<Response> {
  const preview = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${commandId}/reversal-preview`)
  return l.api('POST', l.path('/commands/reverse-command'), l.sa, {
    commandId, note: 'Synthetic undo', confirmation,
    expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256,
  })
}

describe('stakeholder merge economic consistency', () => {
  it('keeps the real merge economically neutral across totals, exercises, transactions, ISO and verification', async () => {
    const l = await ledgerHarness({ extend: realCase })
    const survivor = l.id('S50')
    const merged = l.id('S51')
    await l.db.prepare(
      `INSERT INTO exercise_requests
       (id, org_id, request_number, security_id, stakeholder_id, quantity, iso_quantity, exercise_price, total_cost,
        payment_method, status, decided_at, exercise_date, completed_command_id, created_at, updated_at)
       VALUES (?, ?, 950, ?, ?, '345641', '345641', '0.1', '34564.1', 'WIRE', 'EXERCISED', ?, '2026-02-02', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), l.orgId, l.id('OPT-950'), merged, ACME_NOW,
      l.acme.b.commandIds.get('exercise:OPT-950'), ACME_NOW, ACME_NOW).run()
    const holderDocumentId = await addDocument(l.db, l.orgId, 'OTHER')
    await l.db.batch([
      l.db.prepare(
        "INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
      ).bind(crypto.randomUUID(), l.orgId, holderDocumentId, merged, ACME_NOW),
      l.db.prepare(
        "INSERT INTO document_links (id, org_id, document_id, role, security_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
      ).bind(crypto.randomUUID(), l.orgId, holderDocumentId, l.id('OPT-950'), ACME_NOW),
    ])
    await l.db.prepare('UPDATE documents SET holder_visible = 1, version = version + 1, updated_at = ? WHERE id = ?')
      .bind(ACME_NOW, holderDocumentId).run()
    const key = crypto.randomUUID()
    const run = await runCommand(l, l.sa, 'merge-stakeholders', mergeBody(l, 'S51', 'S50'), { key })
    expect(run.response.status, JSON.stringify(run.body)).toBe(200)
    const result = run.body as api.CommandResult
    expect(result.stakeholderMerge).toEqual(run.preview.stakeholderMerge)
    expect(result.diffSha256).toBe(run.preview.diffSha256)
    expect(result.violations).toEqual([])
    expect(result.stakeholderMerge?.holdings.survivorAfter).toMatchObject({
      issuedAndOutstanding: '4595641', fullyDiluted: '4595641', securityCount: 4,
    })

    const replay = await l.api('POST', l.path('/commands/merge-stakeholders'), l.sa, {
      ...mergeBody(l, 'S51', 'S50'), expectedLedgerSeq: run.preview.ledgerSeq,
      expectedDiffSha256: run.preview.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': key })
    expect(replay.status).toBe(200)
    expect((await replay.json() as api.CommandResult).commandId).toBe(result.commandId)
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE org_id = ? AND type = 'X_STAKEHOLDER_MERGE'")
      .bind(l.orgId).first<number>('n')).toBe(1)

    const detailA = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${survivor}`)
    const detailB = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${merged}`)
    expect(detailA.totals).toMatchObject({ issuedAndOutstanding: '4595641', fullyDiluted: '4595641' })
    expect(detailA.exercises).toContainEqual(expect.objectContaining({ grantDisplayId: 'OPT-950', stakeholderId: survivor }))
    expect(detailB.exercises).toContainEqual(expect.objectContaining({ grantDisplayId: 'OPT-950', stakeholderId: survivor }))
    expect(detailB.mergedInto).toMatchObject({ id: survivor })
    const exercises = await getJson<{ items: api.ExerciseRecord[] }>(l, l.sa, '/exercises')
    expect(exercises.items).toContainEqual(expect.objectContaining({ grantDisplayId: 'OPT-950', stakeholderId: survivor }))
    const requests = await getJson<{ items: api.ExerciseRequest[] }>(l, l.sa, '/exercise-requests')
    expect(requests.items).toContainEqual(expect.objectContaining({ securityId: l.id('OPT-950'), stakeholderId: survivor }))
    const transactions = await getJson<api.TransactionPage>(l, l.sa, `/transactions?stakeholderId=${survivor}&limit=100`)
    expect(transactions.items.map((item) => item.type)).toEqual(expect.arrayContaining([
      'TX_EQUITY_COMPENSATION_EXERCISE', 'X_STAKEHOLDER_MERGE',
    ]))
    const mergedHistory = await getJson<api.TransactionPage>(l, l.sa, `/transactions?stakeholderId=${merged}&limit=100`)
    expect(mergedHistory.items).toContainEqual(expect.objectContaining({ type: 'X_STAKEHOLDER_MERGE' }))
    const iso = await getJson<api.IsoSplit>(l, l.sa, `/stakeholders/${survivor}/iso-split`)
    expect(iso.years.flatMap((year) => year.lots)).toContainEqual(expect.objectContaining({ displayId: 'OPT-950' }))
    const report = await l.api('GET', l.path('/reports/exercise-history?format=json'), l.sa)
    expect(report.status).toBe(200)
    const reportText = await report.text()
    expect(reportText).toContain('OPT-950')
    expect(reportText).toContain(detailA.displayName)
    const documents = await getJson<api.PortalDocumentList>(l, l.sa, `/stakeholders/${survivor}/preview/documents`)
    expect(documents).toContainEqual(expect.objectContaining({ id: holderDocumentId, scope: 'mine' }))
    expect((await verifyOrgLedger(l.db, l.orgId, ACME_NOW)).report.ok).toBe(true)

    expect((await reverse(l, result.commandId!, holderName(merged.slice(0, 8)))).status).toBe(200)
    expect((await verifyOrgLedger(l.db, l.orgId, ACME_NOW)).report.ok).toBe(true)
  })

  it('returns economic and dependency blockers on dry run and refuses a merge that reinterprets a termination', async () => {
    const l = await ledgerHarness()
    await commit(l, l.rw, 'terminate-stakeholder', {
      stakeholderId: l.id('S04'), terminationDate: '2026-10-19', terminationType: 'voluntary',
    })
    const dry = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, mergeBody(l))
    expect(dry.status).toBe(200)
    const preview = await dry.json() as api.CommandResult
    expect(preview.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'STAKEHOLDER_MERGE_NOT_NEUTRAL', 'DEPENDENCY_EDGE_MISSING',
    ]))
    expect(preview.stakeholderMerge?.blockingItems).toContainEqual(expect.objectContaining({ type: 'economic_change' }))
    const committed = await l.api('POST', l.path('/commands/merge-stakeholders'), l.sa, {
      ...mergeBody(l), expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(committed.status).toBe(422)
    expect(await l.db.prepare('SELECT merged_into_id FROM stakeholders WHERE id = ?').bind(l.id('S05')).first('merged_into_id')).toBeNull()
    expect((await verifyOrgLedger(l.db, l.orgId, ACME_NOW)).report.ok).toBe(true)
  })

  it('rejects merged-record commands and expands self-dealing to the merge group', async () => {
    const l = await ledgerHarness()
    await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    await linkAdmin(l.db, l.orgId, ADMIN_EMAIL, l.id('S04'))
    const grant = {
      stockPlanId: l.id('plan:P1'), stakeholderId: l.id('S05'), quantity: '1000',
      board: { approvalDate: '2026-10-20', consentDocumentId: await addDocument(l.db, l.orgId, 'BOARD_CONSENT') },
      optionType: 'NSO',
      vesting: { terms: { templateId: VS1_TEMPLATE_ID }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true },
      exercisePrice: '0.95', valuationId: l.id('V5'), expirationDate: '2036-10-20', exemption: { federal: 'RULE_701' },
      executedAgreement: { documentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signedByHolderAndSignatory: true },
    }
    for (const [route, body] of [
      ['grant-equity-compensation', grant],
      ['terminate-stakeholder', { stakeholderId: l.id('S05'), terminationDate: '2026-10-20', terminationType: 'voluntary' }],
      ['record-leave-of-absence', { stakeholderId: l.id('S05'), startDate: '2026-09-01', endDate: null, returnGuaranteed: true }],
    ] as const) {
      const response = await l.api('POST', l.path(`/commands/${route}?dryRun=true`), l.rw, body)
      expect(response.status, route).toBe(403)
      expect(errorOf(await response.json()).code).toBe('self_dealing')
    }
    const unlinked = await l.api('POST', l.path('/commands/grant-equity-compensation?dryRun=true'), l.sa, grant)
    expect(unlinked.status).toBe(404)
  })

  it('hashes side-effect inputs and enforces typed confirmation', async () => {
    const l = await ledgerHarness()
    const dry = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: l.id('S05'), survivingStakeholderId: l.id('S04'), reason: REASON,
    })
    const preview = await dry.json() as api.CommandResult
    await addEmail(l.db, l.orgId, l.id('S05'), 'late.address@example.test')
    const stale = await l.api('POST', l.path('/commands/merge-stakeholders'), l.sa, {
      ...mergeBody(l), expectedLedgerSeq: preview.ledgerSeq, expectedDiffSha256: preview.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(stale.status).toBe(409)
    expect(errorOf(await stale.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })

    const rerun = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: l.id('S05'), survivingStakeholderId: l.id('S04'), reason: REASON,
    })
    const beforeLink = await rerun.json() as api.CommandResult
    const documentId = await addDocument(l.db, l.orgId, 'OTHER')
    await l.db.prepare(
      "INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
    ).bind(crypto.randomUUID(), l.orgId, documentId, l.id('S05'), ACME_NOW).run()
    const staleLink = await l.api('POST', l.path('/commands/merge-stakeholders'), l.sa, {
      ...mergeBody(l), expectedLedgerSeq: beforeLink.ledgerSeq, expectedDiffSha256: beforeLink.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(staleLink.status).toBe(409)
    expect(errorOf(await staleLink.json())).toMatchObject({ code: 'conflict', reason: 'state_changed' })

    const currentResponse = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: l.id('S05'), survivingStakeholderId: l.id('S04'), reason: REASON,
    })
    const current = await currentResponse.json() as api.CommandResult
    const wrong = await l.api('POST', l.path('/commands/merge-stakeholders'), l.sa, {
      ...mergeBody(l), confirmation: 'wrong', expectedLedgerSeq: current.ledgerSeq,
      expectedDiffSha256: current.diffSha256, acknowledge: [],
    }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(wrong.status).toBe(400)
  })

  it("keeps the survivor's row of a shared address and moves every distinct own address", async () => {
    const l = await ledgerHarness()
    const survivorEmailId = await addEmail(l.db, l.orgId, l.id('S04'), 'shared.person@example.test')
    const mergedEmailId = await addEmail(l.db, l.orgId, l.id('S05'), 'shared.person@example.test')
    const run = await runCommand(l, l.sa, 'merge-stakeholders', mergeBody(l))
    expect(run.response.status, JSON.stringify(run.body)).toBe(200)
    expect(run.preview.stakeholderMerge?.addresses).toContainEqual(expect.objectContaining({
      email: 'shared.person@example.test', action: 'deduplicate',
    }))
    const rows = await l.db.prepare(
      'SELECT id, stakeholder_id, removed_at FROM stakeholder_emails WHERE id IN (?, ?) ORDER BY id',
    ).bind(survivorEmailId, mergedEmailId).all<{ id: string; stakeholder_id: string; removed_at: number | null }>()
    expect(rows.results.find((row) => row.id === survivorEmailId)).toMatchObject({ stakeholder_id: l.id('S04'), removed_at: null })
    expect(rows.results.find((row) => row.id === mergedEmailId)!.removed_at).not.toBeNull()

    // Without sign-in address types there is no "one personal address" rule: two different own addresses both move.
    await addEmail(l.db, l.orgId, l.id('S06'), 'first@example.test')
    await addEmail(l.db, l.orgId, l.id('S07'), 'second@example.test')
    const both = await runCommand(l, l.sa, 'merge-stakeholders', mergeBody(l, 'S07', 'S06'))
    expect(both.preview.stakeholderMerge?.blockingItems).toEqual([])
    expect(both.response.status, JSON.stringify(both.body)).toBe(200)
    const survivor = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${l.id('S06')}`)
    expect(survivor.emails.map((email) => email.email).sort()).toEqual(['first@example.test', 'second@example.test'])
  })

  it("moves a merged record's address and refuses e-mail writes on the archived record", async () => {
    const l = await ledgerHarness()
    const survivorId = l.id('S04')
    const mergedId = l.id('S05')
    const movedId = await addEmail(l.db, l.orgId, mergedId, 'merged.person@example.test')
    const allowed = await runCommand(l, l.sa, 'merge-stakeholders', mergeBody(l))
    expect(allowed.response.status, JSON.stringify(allowed.body)).toBe(200)
    expect(await l.db.prepare('SELECT stakeholder_id FROM stakeholder_emails WHERE id = ?').bind(movedId).first('stakeholder_id')).toBe(survivorId)
    const survivor = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${survivorId}`)
    expect(survivor.emails).toContainEqual(expect.objectContaining({ id: movedId, email: 'merged.person@example.test' }))

    for (const [suffix, body] of [
      ['emails', { email: 'another.person@example.test', kind: 'self' }],
      [`emails/${movedId}/remove`, { reason: REASON }],
    ] as const) {
      const response = await l.api('POST', l.path(`/stakeholders/${mergedId}/${suffix}`), l.sa, body)
      expect(response.status, suffix).toBe(404)
    }
  })

  it('compares the complete termination fact and refuses merge chains', async () => {
    const l = await ledgerHarness()
    await commit(l, l.rw, 'terminate-stakeholder', {
      stakeholderId: l.id('S10'), terminationDate: '2026-10-19', terminationType: 'voluntary',
      vestingStopDate: '2026-10-18',
    })
    await commit(l, l.rw, 'terminate-stakeholder', {
      stakeholderId: l.id('S11'), terminationDate: '2026-10-19', terminationType: 'involuntary',
      vestingStopDate: '2026-10-19',
    })
    const terminations = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, mergeBody(l, 'S10', 'S11'))
    expect(terminations.status).toBe(200)
    expect((await terminations.json() as api.CommandResult).stakeholderMerge?.blockingItems)
      .toContainEqual(expect.objectContaining({ type: 'termination_conflict' }))

    await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    const chained = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: l.id('S04'), survivingStakeholderId: l.id('S06'), reason: REASON,
    })
    expect(chained.status).toBe(200)
    expect((await chained.json() as api.CommandResult).stakeholderMerge?.blockingItems)
      .toContainEqual(expect.objectContaining({ type: 'merge_chain' }))
  })

  it('reports reversal identifier collisions and asserts that the merge pointer was written', async () => {
    const l = await ledgerHarness()
    await l.db.prepare("UPDATE stakeholders SET issuer_assigned_id = 'EMP-SYN-5', version = version + 1, updated_at = ? WHERE org_id = ? AND id = ?")
      .bind(ACME_NOW, l.orgId, l.id('S05')).run()
    const result = await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    await l.db.prepare("UPDATE stakeholders SET issuer_assigned_id = 'EMP-SYN-5', version = version + 1, updated_at = ? WHERE org_id = ? AND id = ?")
      .bind(ACME_NOW, l.orgId, l.id('S04')).run()
    const collision = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${result.commandId}/reversal-preview`)
    expect(collision.blocked).toBe(true)
    expect(collision.violations).toContainEqual(expect.objectContaining({ code: 'STAKEHOLDER_UNMERGE_BLOCKED' }))
    expect((await reverse(l, result.commandId!, holderName('S05'))).status).toBe(422)

    await l.db.prepare(
      `CREATE TRIGGER synthetic_ignore_merge_pointer BEFORE UPDATE OF merged_into_id ON stakeholders
       WHEN NEW.merged_into_id IS NOT NULL BEGIN SELECT RAISE(IGNORE); END`,
    ).run()
    const attempted = await runCommand(l, l.sa, 'merge-stakeholders', mergeBody(l, 'S07', 'S06'))
    expect(attempted.response.status).not.toBe(200)
    expect(await l.db.prepare('SELECT merged_into_id FROM stakeholders WHERE id = ?').bind(l.id('S07')).first('merged_into_id')).toBeNull()
    expect(await l.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE org_id = ? AND type = 'X_STAKEHOLDER_MERGE'")
      .bind(l.orgId).first<number>('n')).toBe(1)
  })

  it('blocks undo after a later lot command and permits undo after revoking a moved live link', async () => {
    const l = await ledgerHarness()
    const merged = await commit(l, l.sa, 'merge-stakeholders', mergeBody(l))
    await commit(l, l.rw, 'cancel-security', {
      securityId: l.id('OPT-2'), effectiveDate: '2026-10-21', quantity: '1', reason: 'HOLDER_WAIVER',
      documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-2',
    })
    const blockedPreview = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${merged.commandId}/reversal-preview`)
    expect(blockedPreview.blocked).toBe(true)
    expect((await reverse(l, merged.commandId!, holderName('S05'))).status).toBe(409)

    const documentId = await addDocument(l.db, l.orgId, 'OTHER')
    const linkId = crypto.randomUUID()
    await l.db.prepare("INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)")
      .bind(linkId, l.orgId, documentId, l.id('S07'), ACME_NOW).run()
    const merge = await commit(l, l.sa, 'merge-stakeholders', mergeBody(l, 'S07', 'S06'))
    await l.db.prepare("UPDATE document_links SET revoked_at = ?, revoked_by = ?, revoke_reason = 'synthetic' WHERE id = ?")
      .bind(ACME_NOW, SEED_USER_ID, linkId).run()
    expect((await reverse(l, merge.commandId!, holderName('S07'))).status).toBe(200)
    const link = await l.db.prepare('SELECT stakeholder_id, revoked_at FROM document_links WHERE id = ?')
      .bind(linkId).first<{ stakeholder_id: string; revoked_at: number | null }>()
    expect(link?.stakeholder_id).toBe(l.id('S06'))
    expect(link?.revoked_at).not.toBeNull()
  })
})
