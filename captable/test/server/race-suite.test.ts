import { describe, expect, it } from 'vitest'
import { appRequest, appRequestWithDatabase } from '../support/server-harness.ts'
import { OWNER, batchIncludesSql, batchRaceInjector, checkContract, count, openTestApp, sendApi } from '../support/ledger-helpers.ts'

/** Concurrent duplicates of a non-ledger write: one result, stored once, replayed to the other. */

const PDF = new TextEncoder().encode('%PDF-1.7\nsynthetic race record\n%%EOF\n')

async function digest(bytes = PDF): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('')
}

describe('race suite', () => {
  it('replays one result for concurrent document uploads with the same idempotency key', async () => {
    const { db } = await openTestApp()
    const created = await sendApi('POST', '/api/orgs', OWNER, {
      orgKey: 'race-example', legalName: 'Race Example, Inc.', displayName: 'Race Example', timezone: 'UTC',
    })
    expect(created.status).toBe(201)
    const orgId = (await created.json() as { id: string }).id
    const sha256 = await digest()
    expect(sha256).toBe('8ae674a352260997e8c005eedb19d96adaa05d6a3cf3b22488b3d9c04a87eca4')
    const path = `/api/orgs/${orgId}/documents`
    const upload = async (database: D1Database = db) => {
      const response = await appRequestWithDatabase(database, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf', 'X-Filename': 'Synthetic-race-record.pdf', 'X-Document-Kind': 'OTHER',
          'X-Content-SHA256': sha256, 'Idempotency-Key': 'race-upload-idempotency-key',
        },
        body: PDF.slice(),
      }, OWNER)
      await checkContract('POST', path, response)
      return response
    }
    const race = batchRaceInjector(db)
    let winner: Response | undefined
    race.arm(async () => { winner = await upload(db) }, (statements) => batchIncludesSql(statements, 'INSERT INTO documents'))
    const replay = await upload(race.binding)
    expect(race.injections()).toBe(1)
    const responses = [winner!, replay]
    expect(responses.map((response) => response.status)).toEqual([201, 201])
    expect(responses.filter((response) => response.headers.get('Idempotent-Replay') === 'true')).toHaveLength(1)
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>))
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1)
    expect(await count(db, 'SELECT COUNT(*) AS n FROM documents WHERE org_id = ?', orgId)).toBe(1)
    expect(await count(db, "SELECT COUNT(*) AS n FROM idempotency_keys WHERE route = 'POST /api/orgs/:orgId/documents'")).toBe(1)
    // The bytes were stored once, with the one document.
    expect(await count(db, 'SELECT COUNT(*) AS n FROM document_blobs WHERE org_id = ?', orgId)).toBe(1)
    const download = await appRequest(`/api/orgs/${orgId}/documents/${bodies[0]!.id}/download`, {}, OWNER)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF)
  })
})
