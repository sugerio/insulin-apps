import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentStore, DocumentTooLargeError, MAX_DOCUMENT_BYTES } from '../../src/app/server/lib/documents/store.ts'
import { documentStatement, ORG, seedCompany } from '../db/fixtures.ts'
import { appRequest, createLegacyTestDatabase, jsonRequest, type TestDatabase } from '../support/server-harness.ts'

let testDb: TestDatabase

async function setupCompany() {
  const response = await jsonRequest('/api/orgs', 'POST', {
    orgKey: 'docs', legalName: 'Docs Example, Inc.', displayName: 'Docs Example', timezone: 'UTC',
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ id: string }>
}

async function digest(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', source))]
    .map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function upload(
  orgId: string,
  filename: string,
  kind = 'OTHER',
  bytes = new TextEncoder().encode('%PDF-1.4\nsynthetic document\n%%EOF'),
) {
  return appRequest(`/api/orgs/${orgId}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': filename,
      'X-Document-Kind': kind,
      'X-Content-SHA256': await digest(bytes),
    },
    body: bytes,
  })
}

beforeEach(async () => {
  process.env.SUGER_ACCESS_MODE = 'console'
  testDb = await createLegacyTestDatabase()
})

afterEach(async () => {
  await testDb.close()
  delete process.env.SUGER_ACCESS_MODE
})

describe('D1 document bytes', () => {
  it('chunks, reconstructs and never deletes document bytes', async () => {
    const bytes = new Uint8Array(600 * 1024).map((_, index) => index % 251)
    const store = new DocumentStore(testDb.db)
    await seedCompany(testDb.db)
    await testDb.db.batch([documentStatement(testDb.db, 'document')])
    await store.put(ORG, 'document', bytes)
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM document_blobs WHERE document_id = ?').bind('document').first<number>('n')).toBe(3)
    const streamed = new Response(store.stream(ORG, 'document', bytes.byteLength))
    expect(new Uint8Array(await streamed.arrayBuffer())).toEqual(bytes)
    expect(() => store.delete()).toThrow(/cannot be deleted/)
    await expect(store.put('org', 'large', new Uint8Array(MAX_DOCUMENT_BYTES + 1))).rejects.toBeInstanceOf(DocumentTooLargeError)
  }, 60_000)

  it('writes at most two chunks per batch, pulls one chunk per read, and leaves failed staging invisible', async () => {
    const bytes = new Uint8Array(600 * 1024).map((_, index) => index % 251)
    const batchSizes: number[] = []
    const stagingEvents: string[] = []
    let blobReads = 0
    const database = {
      prepare(sql: string) {
        if (sql.startsWith('SELECT bytes FROM document_blobs')) blobReads += 1
        const prepared = testDb.db.prepare(sql)
        if (!sql.startsWith('INSERT INTO document_upload_chunks')) return prepared
        return {
          bind(...values: unknown[]) {
            stagingEvents.push(`bind:${String(values[2])}`)
            return prepared.bind(...values)
          },
        } as D1PreparedStatement
      },
      batch(statements: D1PreparedStatement[]) {
        batchSizes.push(statements.length)
        stagingEvents.push(`batch:${statements.length}`)
        return testDb.db.batch(statements)
      },
      exec(sql: string) { return testDb.db.exec(sql) },
    } as D1Database
    const store = new DocumentStore(database)
    await seedCompany(testDb.db)
    await testDb.db.batch([documentStatement(testDb.db, 'streamed')])
    await store.put(ORG, 'streamed', bytes)
    expect(batchSizes).toEqual([2, 1])

    const reader = store.stream(ORG, 'streamed', bytes.byteLength).getReader()
    expect(blobReads).toBe(0)
    expect((await reader.read()).value).toHaveLength(256 * 1024)
    expect(blobReads).toBe(1)
    expect((await reader.read()).value).toHaveLength(256 * 1024)
    expect(blobReads).toBe(2)
    expect((await reader.read()).value).toHaveLength(88 * 1024)
    expect(blobReads).toBe(3)
    expect((await reader.read()).done).toBe(true)

    const orphan = 'failed-upload'
    const orphanBytes = new Uint8Array(600 * 1024)
    await store.stage(ORG, orphan, orphanBytes, Date.now())
    expect(stagingEvents.slice(-5)).toEqual(['bind:0', 'bind:1', 'batch:2', 'bind:2', 'batch:1'])
    await expect(testDb.db.batch([
      documentStatement(testDb.db, orphan),
      ...store.finalizeStatements(ORG, orphan, orphanBytes.byteLength, Date.now()),
      testDb.db.prepare('INSERT INTO batch_assertions (ok) VALUES (0)'),
    ])).rejects.toThrow(/batch assertion failed/)
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').bind(orphan).first<number>('n')).toBe(0)
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM document_blobs WHERE document_id = ?').bind(orphan).first<number>('n')).toBe(0)
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM document_upload_chunks WHERE document_id = ?').bind(orphan).first<number>('n')).toBe(3)
  })

  it('uploads and downloads a version entirely through D1', async () => {
    const company = await setupCompany()
    const bytes = new TextEncoder().encode('%PDF-1.4\nsynthetic document\n%%EOF')
    const upload = await appRequest(`/api/orgs/${company.id}/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': 'agreement.pdf',
        'X-Document-Kind': 'GRANT_AGREEMENT',
        'X-Content-SHA256': await digest(bytes),
      },
      body: bytes,
    })
    expect(upload.status).toBe(201)
    const document = await upload.json() as { id: string }
    expect(await testDb.db.prepare('SELECT COUNT(*) AS n FROM document_blobs WHERE document_id = ?').bind(document.id).first<number>('n')).toBe(1)
    const download = await appRequest(`/api/orgs/${company.id}/documents/${document.id}/download`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
  }, 20_000)

  it('does not audit or load bytes for HEAD, and returns 404 when bytes are missing', async () => {
    const company = await setupCompany()
    const bytes = new TextEncoder().encode('%PDF-1.4\nhead request\n%%EOF')
    const uploaded = await upload(company.id, 'head.pdf', 'OTHER', bytes)
    const document = await uploaded.json() as { id: string }
    const before = await testDb.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'document.download'").first<number>('n')
    const head = await appRequest(`/api/orgs/${company.id}/documents/${document.id}/download`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    expect(await testDb.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'document.download'").first<number>('n'))
      .toBe(before)

    const missingId = crypto.randomUUID()
    await testDb.db.prepare(
      `INSERT INTO documents
       (id, org_id, filename, content_type, byte_size, sha256, kind, source, uploaded_by, created_at, updated_at)
       VALUES (?, ?, 'missing.pdf', 'application/pdf', 16, ?, 'OTHER', 'upload', ?, ?, ?)`,
    ).bind(missingId, company.id, '0'.repeat(64), 'console-user-1', Date.now(), Date.now()).run()
    expect((await appRequest(`/api/orgs/${company.id}/documents/${missingId}/download`)).status).toBe(404)
    expect((await appRequest(`/api/orgs/${company.id}/documents/${missingId}/download`, { method: 'HEAD' })).status).toBe(404)
  })

  it('lists, reads and patches metadata with optimistic versions', async () => {
    const company = await setupCompany()
    const uploaded = await upload(company.id, 'board-consent.pdf', 'BOARD_CONSENT')
    expect(uploaded.status).toBe(201)
    const document = await uploaded.json() as { id: string; version: number }
    const list = await appRequest(`/api/orgs/${company.id}/documents?kind=BOARD_CONSENT`)
    expect(await list.json()).toMatchObject({ items: [{ id: document.id, filename: 'board-consent.pdf', version: 1 }] })
    const detail = await appRequest(`/api/orgs/${company.id}/documents/${document.id}`)
    expect(await detail.json()).toMatchObject({ id: document.id, links: [], versions: [{ id: document.id }] })
    const patched = await jsonRequest(`/api/orgs/${company.id}/documents/${document.id}`, 'PATCH', {
      version: 1, filename: 'renamed-consent.pdf', description: 'Synthetic approval evidence', versionLabel: 'Final',
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({
      filename: 'renamed-consent.pdf', description: 'Synthetic approval evidence', versionLabel: 'Final', version: 2,
    })
    const stale = await jsonRequest(`/api/orgs/${company.id}/documents/${document.id}`, 'PATCH', {
      version: 1, filename: 'stale.pdf',
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict', reason: 'stale_version' } })
  })

  it('links, publishes, revokes, versions and audits a holder document', async () => {
    const company = await setupCompany()
    const stakeholderResponse = await jsonRequest(`/api/orgs/${company.id}/stakeholders`, 'POST', {
      kind: 'individual', displayName: 'Holder Example', relationship: 'employee', emails: [],
    })
    const stakeholder = await stakeholderResponse.json() as { id: string }
    const uploaded = await upload(company.id, 'grant.pdf', 'GRANT_AGREEMENT')
    const document = await uploaded.json() as { id: string; version: number }
    const linked = await jsonRequest(`/api/orgs/${company.id}/documents/${document.id}/links`, 'POST', {
      role: 'AGREEMENT', target: { type: 'stakeholder', id: stakeholder.id },
    })
    expect(linked.status).toBe(200)
    const linkBody = await linked.json() as { links: { id: string }[]; version: number }
    expect(linkBody.links).toHaveLength(1)
    const visible = await jsonRequest(`/api/orgs/${company.id}/documents/${document.id}/holder-visibility`, 'POST', {
      version: 1, visible: true,
    })
    expect(visible.status).toBe(200)
    expect(await visible.json()).toMatchObject({ holderVisible: true, visibilityScope: 'holder', version: 2 })
    const revoked = await jsonRequest(
      `/api/orgs/${company.id}/documents/${document.id}/links/${linkBody.links[0]!.id}/revoke`,
      'POST', { reason: 'Agreement replaced' },
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ holderVisible: false, version: 3 })

    const versionBytes = new TextEncoder().encode('%PDF-1.4\nreplacement\n%%EOF')
    const version = await appRequest(`/api/orgs/${company.id}/documents/${document.id}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf', 'X-Filename': 'grant-v2.pdf', 'X-Document-Kind': 'GRANT_AGREEMENT',
        'X-Content-SHA256': await digest(versionBytes),
      },
      body: versionBytes,
    })
    expect(version.status).toBe(201)
    expect(await version.json()).toMatchObject({ supersedesDocumentId: document.id })
    expect(await testDb.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'document.%'").first<number>('n'))
      .toBeGreaterThanOrEqual(5)
  })

  it('creates and updates folders while refusing invalid references and digests', async () => {
    const company = await setupCompany()
    const created = await jsonRequest(`/api/orgs/${company.id}/collections`, 'POST', { name: 'Board approvals' })
    expect(created.status).toBe(201)
    const folder = await created.json() as { id: string }
    expect(await (await appRequest(`/api/orgs/${company.id}/collections`)).json()).toMatchObject({
      items: [{ id: folder.id, name: 'Board approvals', kind: 'FOLDER', version: 1 }],
    })
    const renamed = await jsonRequest(`/api/orgs/${company.id}/collections/${folder.id}`, 'PATCH', {
      version: 1, name: 'Final board approvals',
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ name: 'Final board approvals', version: 2 })
    expect((await jsonRequest(`/api/orgs/${company.id}/collections`, 'POST', {
      name: 'Orphan', parentId: crypto.randomUUID(),
    })).status).toBe(404)

    const bytes = new TextEncoder().encode('%PDF-1.4\ndigest source\n%%EOF')
    const mismatch = await appRequest(`/api/orgs/${company.id}/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf', 'X-Filename': 'bad.pdf', 'X-Document-Kind': 'OTHER',
        'X-Content-SHA256': '0'.repeat(64),
      },
      body: bytes,
    })
    expect(mismatch.status).toBe(422)
    expect(await mismatch.json()).toMatchObject({ error: { code: 'digest_mismatch' } })
  })
})
