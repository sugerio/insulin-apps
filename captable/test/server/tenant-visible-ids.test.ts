import { afterEach, describe, expect, it } from 'vitest'
import { upsertExpiryRun } from '../../src/app/server/lib/ledger/daily.ts'
import { appRequest, consoleHeaders, createTestDatabase, type TestDatabase } from '../support/server-harness.ts'

let testDb: TestDatabase | undefined
afterEach(async () => { await testDb?.close(); testDb = undefined; delete process.env.SUGER_ACCESS_MODE })

const A = consoleHeaders({
  organizationId: 'console-org-a', userId: 'opaque-user-a', email: 'a@example.test', name: 'A',
})
const B = consoleHeaders({
  organizationId: 'console-org-b', userId: 'opaque-user-b', email: 'b@example.test', name: 'B',
})

async function company(identity: Record<string, string>, orgKey: string): Promise<string> {
  const response = await appRequest('/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgKey, legalName: 'Counter Example, Inc.', displayName: 'Counter Example', timezone: 'UTC',
    }),
  }, identity)
  expect(response.status).toBe(201)
  return (await response.json() as { id: string }).id
}

async function folder(identity: Record<string, string>, orgId: string, name: string) {
  const response = await appRequest(`/api/orgs/${orgId}/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, identity)
  expect(response.status).toBe(201)
}

describe('tenant-visible numeric ids', () => {
  it("does not let another organization's audited actions create gaps", async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    const orgA = await company(A, 'counter-a')
    const orgB = await company(B, 'counter-b')
    await folder(B, orgB, 'before')
    for (let index = 0; index < 5; index += 1) await folder(A, orgA, `a-${index}`)
    await folder(B, orgB, 'after')
    const response = await appRequest(`/api/orgs/${orgB}/audit?limit=10&actorId=opaque-user-b`, {}, B)
    expect(response.status).toBe(200)
    const page = await response.json() as {
      items: { id: number; action: string; actor: { userId: string | null } }[];
    }
    expect(page.items.every((item) => item.actor.userId === 'opaque-user-b')).toBe(true)
    const ids = page.items.filter((item) => item.action === 'document.collection.create')
      .map((item) => item.id).sort((x, y) => x - y)
    expect(ids[1]! - ids[0]!).toBe(1)
  })

  it("does not let another organization's expiry runs advance public run ids", async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    const orgA = await company(A, 'expiry-a')
    const orgB = await company(B, 'expiry-b')
    await upsertExpiryRun(testDb.db, orgB, '2026-10-20', '[]', 1)
    for (let day = 20; day < 25; day += 1) {
      await upsertExpiryRun(testDb.db, orgA, `2026-09-${day}`, '[]', day)
    }
    await upsertExpiryRun(testDb.db, orgB, '2026-10-21', '[]', 2)

    const list = await (await appRequest(`/api/orgs/${orgB}/expiry-runs`, {}, B)).json() as {
      items: { runId: number }[];
    }
    expect(list.items.map((item) => item.runId)).toEqual([2])
    expect((await appRequest(`/api/orgs/${orgB}/expiry-runs/1`, {}, B)).status).toBe(200)
    expect((await appRequest(`/api/orgs/${orgB}/expiry-runs/2`, {}, B)).status).toBe(200)
    expect((await appRequest(`/api/orgs/${orgB}/expiry-runs/3`, {}, B)).status).toBe(404)
  })
})
