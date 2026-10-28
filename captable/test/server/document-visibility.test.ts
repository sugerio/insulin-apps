import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { DocumentStore } from '../../src/app/server/lib/documents/store.ts'
import {
  addDocument, getJson, holderIdentity, readHarness, SEED_USER_ID, type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

async function link(documentId: string, stakeholderId: string) {
  await harness!.db.prepare(
    `INSERT INTO document_links (id, org_id, document_id, role, stakeholder_id, created_by, created_at)
     VALUES (?, ?, ?, 'AGREEMENT', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), harness!.orgId, documentId, stakeholderId, SEED_USER_ID, Date.now()).run()
}

async function visibleDocument(kind: api.DocumentKind, stakeholderId?: string) {
  const id = await addDocument(harness!.db, harness!.orgId, kind, { holderVisible: true })
  const seed = new TextEncoder().encode(`synthetic document ${id}`)
  const bytes = new Uint8Array(2048)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed[index % seed.length]!
  await new DocumentStore(harness!.db).put(harness!.orgId, id, bytes)
  if (stakeholderId) await link(id, stakeholderId)
  else await harness!.db.prepare(
    'UPDATE documents SET holder_published_at = ?, holder_published_by = ?, updated_at = ?, version = version + 1 WHERE id = ?',
  ).bind(Date.now(), SEED_USER_ID, Date.now(), id).run()
  return { id, bytes }
}

describe('holder document visibility', () => {
  it('lists one-holder documents and published company resources, never another holder documents', async () => {
    harness = await readHarness({ emails: { S04: 'first@example.test', S05: 'second@example.test' } })
    const mine = await visibleDocument('GRANT_AGREEMENT', harness.id('S04'))
    const theirs = await visibleDocument('GRANT_AGREEMENT', harness.id('S05'))
    const company = await visibleDocument('PLAN_DOCUMENT')
    const first = await getJson<api.PortalDocumentList>(
      harness, holderIdentity('first@example.test'), `/api/portal/orgs/${harness.orgId}/documents`,
    )
    expect(first.map((document) => [document.id, document.scope]).sort()).toEqual([
      [company.id, 'company'], [mine.id, 'mine'],
    ].sort())
    expect(first.map((document) => document.id)).not.toContain(theirs.id)
    expect(await getJson(harness, harness.editor, `/stakeholders/${harness.id('S04')}/preview/documents`)).toEqual(first)
  })

  it('excludes hidden, archived, unpublished and multi-holder documents', async () => {
    harness = await readHarness({ emails: { S04: 'first@example.test' } })
    const hidden = await addDocument(harness.db, harness.orgId, 'OTHER')
    const archived = await visibleDocument('OTHER', harness.id('S04'))
    await harness.db.prepare(
      'UPDATE documents SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    ).bind(Date.now(), Date.now(), archived.id).run()
    const unpublished = await addDocument(harness.db, harness.orgId, 'OTHER', { holderVisible: true })
    const multiple = { id: await addDocument(harness.db, harness.orgId, 'GRANT_AGREEMENT') }
    await link(multiple.id, harness.id('S04'))
    await link(multiple.id, harness.id('S05'))
    const listed = await getJson<api.PortalDocumentList>(
      harness, holderIdentity('first@example.test'), `/api/portal/orgs/${harness.orgId}/documents`,
    )
    for (const id of [hidden, archived.id, unpublished, multiple.id]) {
      expect(listed.map((document) => document.id)).not.toContain(id)
    }
  })

  it('never exposes reconciliation reports or import archives to holders', async () => {
    harness = await readHarness({ emails: { S04: 'first@example.test' } })
    const report = await visibleDocument('RECONCILIATION_REPORT', harness.id('S04'))
    const archive = await visibleDocument('IMPORT_ARCHIVE')
    const holder = holderIdentity('first@example.test')
    const listed = await getJson<api.PortalDocumentList>(
      harness, holder, `/api/portal/orgs/${harness.orgId}/documents`,
    )
    expect(listed.map((document) => document.id)).not.toEqual(expect.arrayContaining([report.id, archive.id]))
    expect((await harness.api('GET', `/api/portal/documents/${report.id}/download`, holder)).status).toBe(404)
    expect((await harness.api('GET', `/api/portal/documents/${archive.id}/download`, holder)).status).toBe(404)
  })

  it('downloads only visible documents and audits a successful delivery', async () => {
    harness = await readHarness({ emails: { S04: 'first@example.test', S05: 'second@example.test' } })
    const mine = await visibleDocument('GRANT_AGREEMENT', harness.id('S04'))
    const theirs = await visibleDocument('GRANT_AGREEMENT', harness.id('S05'))
    const holder = holderIdentity('first@example.test')
    const download = await harness.api('GET', `/api/portal/documents/${mine.id}/download`, holder)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(mine.bytes)
    expect((await harness.api('GET', `/api/portal/documents/${theirs.id}/download`, holder)).status).toBe(404)
    expect(await harness.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'document.download'").first<number>('n')).toBe(1)
  })

  it('blocks a second holder link or publish transition through the API invariant', async () => {
    harness = await readHarness()
    const document = await visibleDocument('GRANT_AGREEMENT', harness.id('S04'))
    const response = await harness.api('POST', harness.path(`/documents/${document.id}/links`), harness.owner, {
      role: 'AGREEMENT', target: { type: 'stakeholder', id: harness.id('S05') },
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { code: 'invariant_violation', violations: [{ code: 'MULTIPLE_HOLDERS' }] },
    })
  })
})
