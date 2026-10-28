import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import {
  getJson, holderIdentity, readHarness, type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

async function seedSignatories(db: D1Database, orgId: string, now: number) {
  const insert = (
    id: string, org: string, name: string, title: string | null, capabilities: string[], active: number, pulleyId: string | null,
  ) => db.prepare(
    `INSERT INTO org_signatories (id, org_id, name, title, capabilities, active, created_at, updated_at, pulley_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, org, name, title, JSON.stringify(capabilities), active, now, now, pulleyId)
  await db.batch([
    insert('00000000-0000-4000-8000-000000000101', orgId, 'Taylor Former', null, ['safes_signatory'], 0, null),
    insert('00000000-0000-4000-8000-000000000102', orgId, 'Morgan Vale', 'Chief Executive Officer', ['options_signatory', 'certificate_primary'], 1, 'sig-1'),
  ])
}

describe('signatories', () => {
  it('lists the company signatories to an editor, active first', async () => {
    harness = await readHarness()
    await seedSignatories(harness.db, harness.orgId, Date.now())
    const body = await getJson<api.OrgSignatoryList>(harness, harness.editor, '/signatories')
    expect(body.items).toEqual([
      { id: '00000000-0000-4000-8000-000000000102', name: 'Morgan Vale', title: 'Chief Executive Officer', capabilities: ['options_signatory', 'certificate_primary'], active: true, importedFromPulley: true },
      { id: '00000000-0000-4000-8000-000000000101', name: 'Taylor Former', title: null, capabilities: ['safes_signatory'], active: false, importedFromPulley: false },
    ])
  })

  it('returns an empty list and hides admin routes from holders', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    expect(await getJson<api.OrgSignatoryList>(harness, harness.owner, '/signatories')).toEqual({ items: [] })
    expect((await harness.api('GET', harness.path('/signatories'), holderIdentity('holder@example.test'))).status).toBe(404)
  })

  it('answers 404 for another or malformed company id', async () => {
    harness = await readHarness()
    const other = '00000000-0000-4000-8000-0000000000aa'
    expect((await harness.api('GET', `/api/orgs/${other}/signatories`, harness.editor)).status).toBe(404)
    expect((await harness.api('GET', '/api/orgs/not-a-uuid/signatories', harness.editor)).status).toBe(404)
  })
})
