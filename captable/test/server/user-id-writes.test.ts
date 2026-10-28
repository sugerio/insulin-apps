import { afterEach, describe, expect, it } from 'vitest'
import { appRequest, consoleHeaders, createTestDatabase, type TestDatabase } from '../support/server-harness.ts'

let testDb: TestDatabase | undefined
afterEach(async () => { await testDb?.close(); testDb = undefined; delete process.env.SUGER_ACCESS_MODE })

async function setupAs(userId: string, organizationId: string) {
  const response = await appRequest('/api/orgs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgKey: `org-${organizationId}`, legalName: 'Writer Example, Inc.', displayName: 'Writer Example', timezone: 'UTC' }),
  }, consoleHeaders({ userId, organizationId, email: 'writer@example.test' }))
  return { status: response.status, body: await response.text() }
}

describe('writes by users with accepted opaque ids', () => {
  it('lets every accepted user id length write and treats other lengths as no user', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    testDb = await createTestDatabase()
    const results: Record<string, { status: number; body: string }> = {}
    const cases = [
      ['1 char', 'u', 401],
      ['2 chars', 'uv', 401],
      ['3 chars', 'uvw', 201],
      ['36 chars (uuid)', crypto.randomUUID(), 201],
      ['80 chars', 'u'.repeat(80), 201],
      ['81 chars', 'u'.repeat(81), 401],
      ['128 chars', 'u'.repeat(128), 401],
    ] as const
    for (const [label, userId, expected] of cases) {
      const me = await appRequest('/api/me', {}, consoleHeaders({ userId, organizationId: `org-${label.length}-${userId.length}` }))
      expect(me.status, `${label} /api/me`).toBe(expected === 201 ? 200 : 401)
      results[label] = await setupAs(userId, `org-${userId.length}`)
      console.info(`[user-id] ${label}: /api/me ${me.status}; POST /api/orgs ${results[label]!.status} ${results[label]!.body.slice(0, 120)}`)
    }
    for (const [label, , expected] of cases) expect(results[label]!.status, label).toBe(expected)
  })
})
