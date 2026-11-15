import { describe, expect, it } from 'vitest'
import type { api } from '../../src/app/shared/index.ts'
import { uuid } from '../shared/engine/fixtures/builder.ts'
import {
  ACME_NOW,
  ADMIN_EMAIL,
  OWNER_EMAIL,
  addDocument,
  addEmail,
  addStakeholder,
  commit,
  errorOf,
  getJson,
  holderName,
  ledgerHarness,
  linkAdmin,
  runCommand,
  VS1_TEMPLATE_ID,
  type LedgerHarness,
} from '../support/ledger-helpers.ts'

const REASON = 'The import created two records for one synthetic person'

async function merge(l: LedgerHarness, merged = 'S05', survivor = 'S04') {
  return commit(l, l.sa, 'merge-stakeholders', {
    mergedStakeholderId: l.id(merged),
    survivingStakeholderId: l.id(survivor),
    reason: REASON,
    confirmation: holderName(merged),
  })
}

async function blocked(l: LedgerHarness, merged: string, survivor: string, expectedType: string) {
  const run = await runCommand(l, l.sa, 'merge-stakeholders', {
    mergedStakeholderId: l.id(merged),
    survivingStakeholderId: l.id(survivor),
    reason: REASON,
    confirmation: holderName(merged),
  })
  expect(run.preview.stakeholderMerge?.blockingItems).toContainEqual(expect.objectContaining({ type: expectedType }))
  expect(run.response.status).toBe(422)
  const code = {
    same_record: 'STAKEHOLDER_MERGE_SAME_RECORD',
    archived: 'STAKEHOLDER_ARCHIVED',
    already_merged: 'STAKEHOLDER_ALREADY_MERGED',
    kind_mismatch: 'STAKEHOLDER_KIND_MISMATCH',
    termination_conflict: 'STAKEHOLDER_TERMINATION_CONFLICT',
    exercise_request: 'STAKEHOLDER_MERGE_BLOCKED',
  }[expectedType]
  expect(errorOf(run.body).violations).toContainEqual(expect.objectContaining({ code }))
  return run
}

describe('merge-stakeholders', () => {
  it('previews and commits the identity fact, moves external rows, hides B and can unmerge while leaving e-mails on A', async () => {
    const l = await ledgerHarness()
    const mergedId = l.id('S05')
    const survivorId = l.id('S04')
    await addEmail(l.db, l.orgId, survivorId, 'shared@example.test')
    await addEmail(l.db, l.orgId, mergedId, 'shared@example.test')
    await addEmail(l.db, l.orgId, mergedId, 'synthetic.founder@example.test')
    const adminLinkId = await linkAdmin(l.db, l.orgId, ADMIN_EMAIL, mergedId)
    const documentId = await addDocument(l.db, l.orgId, 'OTHER')
    const documentLinkId = crypto.randomUUID()
    await l.db.prepare(
      "INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
    ).bind(documentLinkId, l.orgId, documentId, mergedId, ACME_NOW).run()
    const securityDocumentId = await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT')
    await l.db.prepare(
      "INSERT INTO document_links (id, org_id, document_id, role, security_id, created_at) VALUES (?, ?, ?, 'AGREEMENT', ?, ?)",
    ).bind(crypto.randomUUID(), l.orgId, securityDocumentId, l.id('OPT-2'), ACME_NOW).run()
    await l.db.prepare(
      "INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_at) VALUES (?, ?, ?, 'EVIDENCE', ?, ?)",
    ).bind(crypto.randomUUID(), l.orgId, securityDocumentId, mergedId, ACME_NOW).run()
    await l.db.prepare('UPDATE documents SET holder_visible = 1, version = version + 1, updated_at = ? WHERE org_id = ? AND id = ?')
      .bind(ACME_NOW, l.orgId, securityDocumentId).run()

    const beforeA = await getJson<api.StakeholderHoldings>(l, l.sa, `/stakeholders/${survivorId}/holdings`)
    const beforeB = await getJson<api.StakeholderHoldings>(l, l.sa, `/stakeholders/${mergedId}/holdings`)
    const dry = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: mergedId, survivingStakeholderId: survivorId, reason: REASON,
    })
    expect(dry.status).toBe(200)
    const shown = await dry.json() as api.CommandResult
    expect(shown.stakeholderMerge).toMatchObject({
      merged: { id: mergedId }, survivor: { id: survivorId }, confirmation: holderName('S05'), blockingItems: [],
      holdings: {
        survivorBefore: { securityCount: beforeA.items.length },
        mergedBefore: { securityCount: beforeB.items.length },
        survivorAfter: { securityCount: beforeA.items.length + beforeB.items.length },
      },
    })
    expect(shown.stakeholderMerge?.addresses).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'synthetic.founder@example.test', action: 'move' }),
      expect.objectContaining({ email: 'shared@example.test', action: 'deduplicate' }),
    ]))

    const result = await merge(l)
    expect(result.transactions).toEqual([expect.objectContaining({ type: 'X_STAKEHOLDER_MERGE' })])
    const row = await l.db.prepare(
      'SELECT archived_at, merged_into_id, merged_by_command_id FROM stakeholders WHERE id = ?',
    ).bind(mergedId).first<{ archived_at: number | null; merged_into_id: string | null; merged_by_command_id: string | null }>()
    expect(row).toMatchObject({ merged_into_id: survivorId, merged_by_command_id: result.commandId })
    expect(row?.archived_at).not.toBeNull()
    const liveEmails = await l.db.prepare(
      "SELECT stakeholder_id, email FROM stakeholder_emails WHERE org_id = ? AND removed_at IS NULL AND email IN ('shared@example.test', 'synthetic.founder@example.test') ORDER BY email",
    ).bind(l.orgId).all<{ stakeholder_id: string; email: string }>()
    expect(liveEmails.results).toEqual([
      { stakeholder_id: survivorId, email: 'shared@example.test' },
      { stakeholder_id: survivorId, email: 'synthetic.founder@example.test' },
    ])
    expect(await l.db.prepare('SELECT stakeholder_id FROM admin_stakeholder_links WHERE id = ?').bind(adminLinkId).first('stakeholder_id')).toBe(survivorId)
    expect(await l.db.prepare('SELECT stakeholder_id FROM document_links WHERE id = ?').bind(documentLinkId).first('stakeholder_id')).toBe(survivorId)

    const list = await getJson<api.StakeholderList>(l, l.sa, '/stakeholders')
    expect(list.items.some((item) => item.id === mergedId)).toBe(false)
    const mergedDetail = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${mergedId}`)
    expect(mergedDetail.mergedInto).toMatchObject({ id: survivorId, commandId: result.commandId })
    const survivorDetail = await getJson<api.StakeholderDetail>(l, l.sa, `/stakeholders/${survivorId}`)
    expect(survivorDetail.mergedRecords).toContainEqual(expect.objectContaining({ id: mergedId }))
    const after = await getJson<api.StakeholderHoldings>(l, l.sa, `/stakeholders/${survivorId}/holdings`)
    expect(after.items).toHaveLength(beforeA.items.length + beforeB.items.length)
    expect(new Set(after.items.map((item) => item.id))).toEqual(new Set([...beforeA.items, ...beforeB.items].map((item) => item.id)))
    const portalDocuments = await getJson<api.PortalDocumentList>(l, l.sa, `/stakeholders/${survivorId}/preview/documents`)
    expect(portalDocuments).toContainEqual(expect.objectContaining({ id: securityDocumentId, scope: 'mine' }))

    // The B-linked admin link now protects B's holdings through the canonical A identity.
    const selfDeal = await l.api('POST', l.path('/commands/cancel-security?dryRun=true'), l.rw, {
      securityId: l.id('OPT-2'), effectiveDate: '2026-10-21', quantity: '1', reason: 'MUTUAL_AGREEMENT',
      documentId: await addDocument(l.db, l.orgId, 'OTHER'), confirmation: 'OPT-2',
    })
    expect(selfDeal.status).toBe(403)
    expect(errorOf(await selfDeal.json()).code).toBe('self_dealing')

    const reversalPreview = await getJson<api.ReversalPreview>(l, l.sa, `/commands/${result.commandId}/reversal-preview`)
    expect(reversalPreview).toMatchObject({ commandType: 'merge-stakeholders', blocked: false })
    const reversed = await l.api('POST', l.path('/commands/reverse-command'), l.sa, {
      commandId: result.commandId,
      note: 'The records were not duplicates',
      confirmation: holderName('S05'),
      expectedLedgerSeq: reversalPreview.ledgerSeq,
      expectedDiffSha256: reversalPreview.diffSha256,
    })
    expect(reversed.status, JSON.stringify(await reversed.clone().json())).toBe(200)
    expect(await l.db.prepare('SELECT archived_at FROM stakeholders WHERE id = ?').bind(mergedId).first('archived_at')).toBeNull()
    expect(await l.db.prepare('SELECT stakeholder_id FROM admin_stakeholder_links WHERE id = ?').bind(adminLinkId).first('stakeholder_id')).toBe(mergedId)
    expect(await l.db.prepare('SELECT stakeholder_id FROM document_links WHERE id = ?').bind(documentLinkId).first('stakeholder_id')).toBe(mergedId)
    const emailOwners = await l.db.prepare(
      "SELECT DISTINCT stakeholder_id FROM stakeholder_emails WHERE org_id = ? AND removed_at IS NULL AND email IN ('shared@example.test', 'synthetic.founder@example.test')",
    ).bind(l.orgId).all<{ stakeholder_id: string }>()
    expect(emailOwners.results).toEqual([{ stakeholder_id: survivorId }])
    const restoredB = await getJson<api.StakeholderHoldings>(l, l.sa, `/stakeholders/${mergedId}/holdings`)
    expect(restoredB.items.map((item) => item.id).sort()).toEqual(beforeB.items.map((item) => item.id).sort())
  })

  it('refuses the record, lifecycle, kind, termination and open-workflow guards', async () => {
    const l = await ledgerHarness()
    await blocked(l, 'S04', 'S04', 'same_record')

    await l.db.prepare('UPDATE stakeholders SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .bind(ACME_NOW, ACME_NOW, l.id('S05')).run()
    await blocked(l, 'S05', 'S06', 'archived')

    await l.db.prepare(
      'UPDATE stakeholders SET archived_at = ?, merged_into_id = ?, merged_at = ?, version = version + 1, updated_at = ? WHERE id = ?',
    ).bind(ACME_NOW, l.id('S08'), ACME_NOW, ACME_NOW, l.id('S07')).run()
    await blocked(l, 'S07', 'S06', 'already_merged')

    await blocked(l, 'S31', 'S04', 'kind_mismatch')

    await commit(l, l.rw, 'terminate-stakeholder', {
      stakeholderId: l.id('S10'), terminationDate: '2026-10-19', terminationType: 'voluntary',
    })
    await commit(l, l.rw, 'terminate-stakeholder', {
      stakeholderId: l.id('S11'), terminationDate: '2026-10-20', terminationType: 'voluntary',
    })
    await blocked(l, 'S10', 'S11', 'termination_conflict')

    const openSecurity = await l.db.prepare('SELECT id, stakeholder_id FROM securities WHERE org_id = ? AND stakeholder_id = ? LIMIT 1')
      .bind(l.orgId, l.id('S06')).first<{ id: string; stakeholder_id: string }>()
    expect(openSecurity).not.toBeNull()
    await l.db.prepare(
      `INSERT INTO exercise_requests
       (id, org_id, request_number, security_id, stakeholder_id, quantity, iso_quantity, exercise_price, total_cost,
        payment_method, status, decided_at, created_at, updated_at)
       VALUES (?, ?, 999, ?, ?, '1', '1', '0.1', '0.1', 'WIRE', 'AWAITING_PAYMENT', ?, ?, ?)`,
    ).bind(uuid('merge-open-exercise'), l.orgId, openSecurity!.id, l.id('S06'), ACME_NOW, ACME_NOW, ACME_NOW).run()
    await l.db.prepare(
      `INSERT INTO signature_requests (id, org_id, security_id, signer_role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'HOLDER', 'PENDING', ?, ?)`,
    ).bind(uuid('merge-open-signature'), l.orgId, openSecurity!.id, ACME_NOW, ACME_NOW).run()
    await l.db.prepare(
      `INSERT INTO scheduled_terminations
       (id, org_id, stakeholder_id, termination_date, termination_type, vesting_stop_date, request, request_sha256,
        status, version, created_at, updated_at)
       VALUES (?, ?, ?, '2026-11-01', 'voluntary', '2026-11-01', '{}', ?, 'SCHEDULED', 1, ?, ?)`,
    ).bind(uuid('merge-scheduled-termination'), l.orgId, l.id('S06'), 'ab'.repeat(32), ACME_NOW, ACME_NOW).run()
    const open = await blocked(l, 'S06', 'S04', 'exercise_request')
    expect(open.preview.stakeholderMerge?.blockingItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'scheduled_termination' }),
    ]))
    // Pulley's signature rows are immutable evidence: never a blocker.
    expect(open.preview.stakeholderMerge?.blockingItems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'signature_request' }),
    ]))
  })

  it('merges a record whose securities carry pending Pulley signature evidence, leaving the evidence untouched', async () => {
    const l = await ledgerHarness()
    const security = (await l.db.prepare('SELECT id FROM securities WHERE org_id = ? AND stakeholder_id = ? ORDER BY id LIMIT 1')
      .bind(l.orgId, l.id('S05')).first<{ id: string }>())!
    await l.db.prepare(
      `INSERT INTO signature_requests (id, org_id, security_id, signer_role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'APPROVER', 'PENDING', ?, ?)`,
    ).bind(uuid('merge-pulley-signature'), l.orgId, security.id, ACME_NOW, ACME_NOW).run()
    await merge(l)
    expect(await l.db.prepare('SELECT merged_into_id FROM stakeholders WHERE id = ?').bind(l.id('S05')).first<string>('merged_into_id')).toBe(l.id('S04'))
    const row = await l.db.prepare('SELECT security_id, status FROM signature_requests WHERE id = ?')
      .bind(uuid('merge-pulley-signature')).first<{ security_id: string; status: string }>()
    expect(row).toEqual({ security_id: security.id, status: 'PENDING' })
  })

  it('allows only write administrators and blocks an actor linked to either record', async () => {
    const l = await ledgerHarness()
    const body = { mergedStakeholderId: l.id('S05'), survivingStakeholderId: l.id('S04'), reason: REASON }
    expect((await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.ro, body)).status).toBe(403)
    expect((await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.rw, body)).status).toBe(200)
    await linkAdmin(l.db, l.orgId, OWNER_EMAIL, l.id('S05'))
    const mergedActor = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, body)
    expect(mergedActor.status).toBe(403)
    expect(errorOf(await mergedActor.json()).code).toBe('self_dealing')

    await linkAdmin(l.db, l.orgId, OWNER_EMAIL, l.id('S07'))
    const survivorActor = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: l.id('S06'), survivingStakeholderId: l.id('S07'), reason: REASON,
    })
    expect(survivorActor.status).toBe(403)
    expect(errorOf(await survivorActor.json()).code).toBe('self_dealing')
  })
})

describe('rehires keep two records', () => {
  /** A former employee terminated on 2026-03-31 and another record for the same person. */
  async function formerAndOther(l: LedgerHarness, former: string, other: string, relationship: 'employee' | 'officer' | 'investor', hireDate: string | null) {
    await addStakeholder(l.db, l.orgId, former, 'employee')
    await addStakeholder(l.db, l.orgId, other, relationship)
    if (hireDate !== null) {
      await l.db.prepare('UPDATE stakeholders SET hire_date = ?, version = version + 1, updated_at = ? WHERE id = ?').bind(hireDate, ACME_NOW, l.id(other)).run()
    }
    await commit(l, l.rw, 'terminate-stakeholder', { stakeholderId: l.id(former), terminationDate: '2026-03-31', terminationType: 'voluntary' })
  }

  async function mergePreview(l: LedgerHarness, merged: string, survivor: string): Promise<api.CommandResult> {
    const dry = await l.api('POST', l.path('/commands/merge-stakeholders?dryRun=true'), l.sa, {
      mergedStakeholderId: l.id(merged), survivingStakeholderId: l.id(survivor), reason: REASON, confirmation: holderName(merged),
    })
    expect(dry.status).toBe(200)
    return await dry.json() as api.CommandResult
  }

  const rehireCodes = (preview: api.CommandResult) => preview.violations.filter((item) => item.code === 'STAKEHOLDER_MERGE_REHIRE')

  async function scheduleLeaving(l: LedgerHarness, label: string, date: string) {
    await l.db.prepare(
      `INSERT INTO scheduled_terminations
       (id, org_id, stakeholder_id, termination_date, termination_type, vesting_stop_date, request, request_sha256, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'voluntary', ?, '{}', ?, 'SCHEDULED', 1, ?, ?)`,
    ).bind(crypto.randomUUID(), l.orgId, l.id(label), date, date, 'ab'.repeat(32), ACME_NOW, ACME_NOW).run()
  }

  it('refuses to merge a rehire holding a grant issued after the termination, in either direction', async () => {
    const l = await ledgerHarness()
    await formerAndOther(l, 'S60', 'S61', 'employee', null)
    await commit(l, l.rw, 'grant-equity-compensation', {
      stockPlanId: l.id('plan:P1'), stakeholderId: l.id('S61'), quantity: '1000',
      board: { approvalDate: '2026-10-20', consentDocumentId: await addDocument(l.db, l.orgId, 'BOARD_CONSENT') },
      optionType: 'NSO', exercisePrice: '0.95', valuationId: l.id('V5'), expirationDate: '2036-10-20', exemption: { federal: 'RULE_701' },
      vesting: { terms: { templateId: VS1_TEMPLATE_ID }, vestingStartDate: '2026-10-20', earlyExercisable: false, accelerationTerms: { kind: 'NONE' }, matchesSignedAgreement: true },
      displayId: 'OPT-61', executedAgreement: { documentId: await addDocument(l.db, l.orgId, 'GRANT_AGREEMENT'), signedByHolderAndSignatory: true },
    })
    for (const [merged, survivor] of [['S61', 'S60'], ['S60', 'S61']] as const) {
      const preview = await mergePreview(l, merged, survivor)
      expect(rehireCodes(preview), `${merged} into ${survivor}`).toEqual([expect.objectContaining({ message: expect.stringContaining('holds OPT-61, issued on 2026-10-20') })])
      expect(preview.stakeholderMerge?.blockingItems).toContainEqual(expect.objectContaining({ type: 'rehire', id: l.id('S61') }))
    }
    const refused = await runCommand(l, l.sa, 'merge-stakeholders', { mergedStakeholderId: l.id('S61'), survivingStakeholderId: l.id('S60'), reason: REASON, confirmation: holderName('S61') })
    expect(refused.response.status).toBe(422)
    expect(await l.db.prepare('SELECT merged_into_id FROM stakeholders WHERE id = ?').bind(l.id('S61')).first('merged_into_id')).toBeNull()
  })

  it('refuses a rehire hired after the termination without new equity, also while a new departure is scheduled', async () => {
    const l = await ledgerHarness()
    await formerAndOther(l, 'S62', 'S63', 'officer', '2026-09-01')
    for (const [merged, survivor] of [['S63', 'S62'], ['S62', 'S63']] as const) {
      expect(rehireCodes(await mergePreview(l, merged, survivor)), `${merged} into ${survivor}`).toEqual([expect.objectContaining({ message: expect.stringContaining('was hired on 2026-09-01') })])
    }
    // The rehire is leaving again: a scheduled termination isn't recorded yet, so the old one is still the only one.
    await scheduleLeaving(l, 'S63', '2026-11-30')
    expect(rehireCodes(await mergePreview(l, 'S62', 'S63'))).toHaveLength(1)
  })

  it('still merges a genuine duplicate of a former employee, and never calls a scheduled departure a termination', async () => {
    const l = await ledgerHarness()
    // Hired before the termination: the same employment, recorded twice.
    await formerAndOther(l, 'S64', 'S65', 'employee', '2025-01-06')
    expect(rehireCodes(await mergePreview(l, 'S65', 'S64'))).toEqual([])
    await commit(l, l.sa, 'merge-stakeholders', { mergedStakeholderId: l.id('S65'), survivingStakeholderId: l.id('S64'), reason: REASON, confirmation: holderName('S65') })
    expect(await l.db.prepare('SELECT merged_into_id FROM stakeholders WHERE id = ?').bind(l.id('S65')).first('merged_into_id')).toBe(l.id('S64'))
    // Neither record terminated: one only scheduled to leave, the other hired later, is no rehire.
    await addStakeholder(l.db, l.orgId, 'S66', 'employee')
    await addStakeholder(l.db, l.orgId, 'S67', 'employee')
    await l.db.prepare("UPDATE stakeholders SET hire_date = '2026-10-01', version = version + 1, updated_at = ? WHERE id = ?").bind(ACME_NOW, l.id('S67')).run()
    await scheduleLeaving(l, 'S66', '2026-12-31')
    expect(rehireCodes(await mergePreview(l, 'S67', 'S66'))).toEqual([])
  })
})
