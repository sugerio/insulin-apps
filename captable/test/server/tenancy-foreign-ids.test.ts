import { afterEach, describe, expect, it } from 'vitest'
import { engine } from '../../src/app/shared/index.ts'
import { addDocument, readHarness, type ReadHarness } from '../support/read-helpers.ts'
import { appRequest, consoleHeaders } from '../support/server-harness.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

const SHARED_EMAIL = 'shared.holder@example.test'
const PDF = new TextEncoder().encode('%PDF-1.7\n% synthetic reviewer document\n')

function owner(organizationId: string, userId: string) {
  return consoleHeaders({
    organizationId, userId, role: 'OWNER', email: `${userId}@example.test`, name: 'Owner Example',
  })
}

async function upload(orgId: string, identity: Record<string, string>, extra: Record<string, string> = {}) {
  return appRequest(`/api/orgs/${orgId}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': 'synthetic.pdf',
      'X-Document-Kind': 'GRANT_AGREEMENT',
      'X-Content-SHA256': engine.sha256Hex(PDF),
      ...extra,
    },
    body: PDF,
  }, identity)
}

describe('cross-organization probes with real nested ids', () => {
  it('refuses every foreign nested id in both directions and keeps portals and receipts apart', async () => {
    harness = await readHarness({ emails: { S04: SHARED_EMAIL } })
    const h = harness
    const first = h.owner
    const firstOrg = h.orgId
    const multi = 'multi-org-user'
    const firstMulti = consoleHeaders({
      organizationId: 'console-org-1', userId: multi, role: 'OWNER', email: 'multi@example.test', name: 'Multi Org',
    })
    const secondMulti = consoleHeaders({
      organizationId: 'console-org-2', userId: multi, role: 'OWNER', email: 'multi@example.test', name: 'Multi Org',
    })
    const second = owner('console-org-2', 'second-owner-opaque-id')

    const created = await h.api('POST', '/api/orgs', second, {
      orgKey: 'acme-robotics', legalName: 'Second Example, Inc.', displayName: 'Second Example', timezone: 'UTC',
    })
    expect(created.status).toBe(201)
    const secondOrg = (await created.json() as { id: string }).id
    const secondHolderResponse = await h.api('POST', `/api/orgs/${secondOrg}/stakeholders`, second, {
      kind: 'individual', displayName: 'Second Holder', relationship: 'investor', emails: [{ email: SHARED_EMAIL }],
    })
    expect(secondHolderResponse.status).toBe(201)
    const secondStakeholder = (await secondHolderResponse.json() as { id: string }).id
    const secondDocResponse = await upload(secondOrg, second, {
      'X-Link-Target': 'stakeholder', 'X-Link-Id': secondStakeholder, 'X-Link-Role': 'AGREEMENT',
    })
    expect(secondDocResponse.status).toBe(201)
    const secondDoc = (await secondDocResponse.json() as { id: string }).id
    const secondCollection = (await (await h.api('POST', `/api/orgs/${secondOrg}/collections`, second, {
      name: 'Second folder',
    })).json() as { id: string }).id

    const s04 = h.acme.id('S04')
    const firstDocResponse = await upload(firstOrg, first, {
      'X-Link-Target': 'stakeholder', 'X-Link-Id': s04, 'X-Link-Role': 'AGREEMENT',
    })
    expect(firstDocResponse.status).toBe(201)
    const firstDocBody = await firstDocResponse.json() as { id: string; links: { id: string }[] }
    const firstDoc = firstDocBody.id
    const firstLink = firstDocBody.links[0]!.id
    const firstMetaDoc = await addDocument(h.db, firstOrg, 'OTHER')
    const firstCollection = (await (await h.api('POST', h.path('/collections'), first, {
      name: 'First folder',
    })).json() as { id: string }).id
    const firstSecurity = h.acme.id('OPT-1')
    const one = (sql: string) => h.db.prepare(sql).bind(firstOrg).first<string>('id')
    const firstCommand = await one('SELECT id FROM commands WHERE org_id = ? ORDER BY first_seq DESC LIMIT 1')
    const firstValuation = await one('SELECT id FROM valuations WHERE org_id = ? LIMIT 1')
    const firstClass = await one('SELECT id FROM stock_classes WHERE org_id = ? LIMIT 1')
    const firstPlan = await one('SELECT id FROM stock_plans WHERE org_id = ? LIMIT 1')
    const firstTerm = await one('SELECT id FROM vesting_terms WHERE org_id = ? LIMIT 1')
    const firstTx = await one('SELECT id FROM transactions WHERE org_id = ? LIMIT 1')
    const firstEmail = await h.db.prepare(
      'SELECT id FROM stakeholder_emails WHERE org_id = ? AND stakeholder_id = ?',
    ).bind(firstOrg, s04).first<string>('id')
    const firstAdminLink = (await (await h.api('POST', h.path('/admin-links'), first, {
      email: 'someone@example.test', stakeholderId: s04, source: 'admin',
    })).json() as { id: string }).id

    const results: { probe: string; status: number }[] = []
    async function probe(label: string, identity: Record<string, string>, method: string, path: string, body?: unknown) {
      results.push({ probe: label, status: (await h.api(method, path, identity, body)).status })
    }
    const own2 = (suffix: string) => `/api/orgs/${secondOrg}${suffix}`
    const own1 = (suffix: string) => `/api/orgs/${firstOrg}${suffix}`

    await probe('2->1 GET stakeholder', second, 'GET', own2(`/stakeholders/${s04}`))
    await probe('2->1 PATCH stakeholder', second, 'PATCH', own2(`/stakeholders/${s04}`), { version: 1, displayName: 'Probe' })
    await probe('2->1 POST stakeholder email', second, 'POST', own2(`/stakeholders/${s04}/emails`), { email: 'probe@example.test' })
    await probe('2->1 POST remove stakeholder email', second, 'POST', own2(`/stakeholders/${s04}/emails/${firstEmail}/remove`), { reason: 'probe' })
    await probe('2->1 GET holdings', second, 'GET', own2(`/stakeholders/${s04}/holdings`))
    await probe('2->1 GET holder preview', second, 'GET', own2(`/stakeholders/${s04}/preview`))
    await probe('2->1 GET holder preview security', second, 'GET', own2(`/stakeholders/${s04}/preview/securities/${firstSecurity}`))
    await probe('2->1 GET holder preview documents', second, 'GET', own2(`/stakeholders/${s04}/preview/documents`))
    await probe('2->1 GET iso split', second, 'GET', own2(`/stakeholders/${s04}/iso-split`))
    await probe('2->1 GET security', second, 'GET', own2(`/securities/${firstSecurity}`))
    await probe('2->1 GET security timeline', second, 'GET', own2(`/securities/${firstSecurity}/timeline`))
    await probe('2->1 GET termination preview', second, 'GET', `${own2(`/securities/${firstSecurity}/termination-preview`)}?terminationDate=2026-10-21&terminationType=voluntary`)
    await probe('2->1 GET command', second, 'GET', own2(`/commands/${firstCommand}`))
    await probe('2->1 GET reversal preview', second, 'GET', own2(`/commands/${firstCommand}/reversal-preview`))
    await probe('2->1 merge dry run', second, 'POST', `${own2('/commands/merge-stakeholders')}?dryRun=true`, {
      mergedStakeholderId: s04, survivingStakeholderId: secondStakeholder, reason: 'probe',
    })
    await probe('2->1 cancel-security dry run', second, 'POST', `${own2('/commands/cancel-security')}?dryRun=true`, {
      securityId: firstSecurity, effectiveDate: '2026-10-21', reason: 'HOLDER_WAIVER', documentId: firstDoc,
    })
    await probe('2->1 reverse-command', second, 'POST', own2('/commands/reverse-command'), {
      commandId: firstCommand, note: 'probe', expectedLedgerSeq: 0, expectedDiffSha256: '0'.repeat(64), confirmation: 'probe',
    })
    await probe('2->1 GET valuation', second, 'GET', own2(`/valuations/${firstValuation}`))
    await probe('2->1 POST valuation void', second, 'POST', own2(`/valuations/${firstValuation}/void`), {
      eventDate: '2026-10-21', description: 'probe',
    })
    await probe('2->1 GET stock class', second, 'GET', own2(`/stock-classes/${firstClass}`))
    await probe('2->1 GET stock plan', second, 'GET', own2(`/stock-plans/${firstPlan}`))
    await probe('2->1 GET vesting term', second, 'GET', own2(`/vesting-terms/${firstTerm}`))
    await probe('2->1 POST vesting term confirm', second, 'POST', own2(`/vesting-terms/${firstTerm}/confirm`), {})
    await probe('2->1 GET transaction', second, 'GET', own2(`/transactions/${firstTx}`))
    await probe('2->1 GET document', second, 'GET', own2(`/documents/${firstDoc}`))
    await probe('2->1 GET document (metadata only)', second, 'GET', own2(`/documents/${firstMetaDoc}`))
    await probe('2->1 PATCH document', second, 'PATCH', own2(`/documents/${firstDoc}`), { version: 1, filename: 'probe.pdf' })
    await probe('2->1 POST document link', second, 'POST', own2(`/documents/${firstDoc}/links`), {
      role: 'AGREEMENT', target: { type: 'stakeholder', id: secondStakeholder },
    })
    await probe('2->1 POST revoke document link', second, 'POST', own2(`/documents/${firstDoc}/links/${firstLink}/revoke`), { reason: 'probe' })
    await probe('2->1 POST holder visibility', second, 'POST', own2(`/documents/${firstDoc}/holder-visibility`), { version: 1, visible: true })
    await probe('2->1 GET document download', second, 'GET', own2(`/documents/${firstDoc}/download`))
    results.push({ probe: '2->1 POST new version of foreign document', status: (await appRequest(own2(`/documents/${firstDoc}/versions`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf', 'X-Filename': 'v2.pdf', 'X-Document-Kind': 'OTHER',
        'X-Content-SHA256': engine.sha256Hex(PDF),
      },
      body: PDF,
    }, second)).status })
    results.push({ probe: '2->1 upload into foreign collection', status: (await upload(secondOrg, second, {
      'X-Collection-Id': firstCollection,
    })).status })
    results.push({ probe: '2->1 upload linked to foreign stakeholder', status: (await upload(secondOrg, second, {
      'X-Link-Target': 'stakeholder', 'X-Link-Id': s04, 'X-Link-Role': 'AGREEMENT',
    })).status })
    await probe('2->1 link own document to foreign stakeholder', second, 'POST', own2(`/documents/${secondDoc}/links`), {
      role: 'AGREEMENT', target: { type: 'stakeholder', id: s04 },
    })
    await probe('2->1 PATCH own document into foreign collection', second, 'PATCH', own2(`/documents/${secondDoc}`), {
      version: 1, collectionId: firstCollection,
    })
    await probe('2->1 PATCH foreign collection', second, 'PATCH', own2(`/collections/${firstCollection}`), { version: 1, name: 'probe' })
    await probe('2->1 POST collection under foreign parent', second, 'POST', own2('/collections'), { name: 'probe', parentId: firstCollection })
    await probe('2->1 POST admin link to foreign stakeholder', second, 'POST', own2('/admin-links'), {
      email: 'probe@example.test', stakeholderId: s04, source: 'admin',
    })
    await probe('2->1 POST remove foreign admin link', second, 'POST', own2(`/admin-links/${firstAdminLink}/remove`), { reason: 'probe' })
    await probe('2->1 PATCH org with foreign portal document', second, 'PATCH', own2(''), {
      version: 1,
      settings: { portal: { howToExerciseText: null, noticeFormDocumentId: firstDoc, privacyNoticeDocumentId: null } },
    })
    await probe('2->1 stakeholder email with foreign authorizing document', second, 'POST', own2(`/stakeholders/${secondStakeholder}/emails`), {
      email: 'rep@example.test', kind: 'representative', authorizingDocumentId: firstDoc,
    })
    const filtered = await (await h.api('GET', `${own2('/documents')}?targetType=stakeholder&targetId=${s04}`, second)).json() as { items: unknown[] }
    expect(filtered.items).toEqual([])

    await probe('1->2 GET stakeholder', first, 'GET', own1(`/stakeholders/${secondStakeholder}`))
    await probe('1->2 GET document', first, 'GET', own1(`/documents/${secondDoc}`))
    await probe('1->2 GET document download', first, 'GET', own1(`/documents/${secondDoc}/download`))
    await probe('1->2 PATCH foreign collection', first, 'PATCH', own1(`/collections/${secondCollection}`), { version: 1, name: 'probe' })
    await probe('1->2 merge dry run', first, 'POST', `${own1('/commands/merge-stakeholders')}?dryRun=true`, {
      mergedStakeholderId: secondStakeholder, survivingStakeholderId: s04, reason: 'probe',
    })
    await probe('1->2 direct company read', first, 'GET', `/api/orgs/${secondOrg}`)
    await probe('1->2 verify ledger', first, 'POST', `/api/admin/orgs/${secondOrg}/verify-ledger`, {})
    expect(results.filter((row) => row.status >= 200 && row.status < 300)).toEqual([])

    const secondAudit = await (await h.api('GET', own2('/audit?limit=50'), second)).json() as { items: { orgId: string | null }[] }
    expect(secondAudit.items.every((item) => item.orgId === secondOrg)).toBe(true)
    const reportText = await (await h.api('GET', own2('/reports/audit-log'), second)).text()
    expect(reportText.includes(firstOrg) || reportText.includes(firstDoc)).toBe(false)

    const holder1 = consoleHeaders({
      organizationId: 'console-org-1', userId: 'shared-holder', role: 'VIEWER', email: SHARED_EMAIL, name: 'Shared',
    })
    const holder2 = consoleHeaders({
      organizationId: 'console-org-2', userId: 'shared-holder', role: 'VIEWER', email: SHARED_EMAIL, name: 'Shared',
    })
    const me1 = await (await h.api('GET', '/api/me', holder1)).json() as { portal: { matches: { orgId: string }[] } }
    const me2 = await (await h.api('GET', '/api/me', holder2)).json() as { portal: { matches: { orgId: string }[] } }
    expect(me1.portal.matches.every((match) => match.orgId === firstOrg)).toBe(true)
    expect(me2.portal.matches.every((match) => match.orgId === secondOrg)).toBe(true)
    for (const [identity, path, expected] of [
      [holder1, `/api/portal/documents/${firstDoc}/download`, 200],
      [holder2, `/api/portal/documents/${secondDoc}/download`, 200],
      [holder2, `/api/portal/documents/${firstDoc}/download`, 404],
      [holder1, `/api/portal/documents/${secondDoc}/download`, 404],
      [holder2, `/api/portal/orgs/${firstOrg}/documents`, 404],
      [holder2, `/api/portal/orgs/${firstOrg}/securities/${firstSecurity}`, 404],
      [holder2, `/api/portal/orgs/${firstOrg}/how-to-exercise`, 404],
    ] as const) {
      expect((await h.api('GET', path, identity)).status, path).toBe(expected)
    }

    const key = 'shared-idempotency-key-1'
    const body = { kind: 'individual', displayName: 'Receipt Probe', relationship: 'investor', emails: [] }
    const r1 = await h.api('POST', own1('/stakeholders'), firstMulti, body, { 'Idempotency-Key': key })
    const r2 = await h.api('POST', own2('/stakeholders'), secondMulti, body, { 'Idempotency-Key': key })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.headers.get('Idempotent-Replay')).toBeNull()
  }, 120_000)
})
