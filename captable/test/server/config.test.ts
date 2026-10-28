import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestConfig } from '../../src/app/server/lib/config.ts'
import {
  consoleHeaders, createLegacyTestDatabase, handleTestAppRequest, type TestDatabase,
} from '../support/server-harness.ts'

let testDb: TestDatabase
beforeEach(async () => {
  process.env.SUGER_ACCESS_MODE = 'console'
  testDb = await createLegacyTestDatabase()
})
afterEach(async () => {
  await testDb.close()
  delete process.env.SUGER_ACCESS_MODE
})

describe('Insulin runtime configuration', () => {
  it('derives the same-origin boundary from each request and keeps the portal enabled', () => {
    expect(requestConfig(new Request('https://first.example.test/api/me'))).toEqual({
      origin: 'https://first.example.test', portalEnabled: true,
    })
    expect(requestConfig(new Request('http://localhost:5173/api/me'))).toEqual({
      origin: 'http://localhost:5173', portalEnabled: true,
    })
  })

  it('ignores unrelated environment values', async () => {
    Object.assign(process.env, {
      EXAMPLE_UNUSED_SETTING: 'invalid',
      PORTAL_ENABLED: 'false',
    })
    const headers = new Headers(consoleHeaders())
    headers.set('Origin', 'http://app.test')
    headers.set('Sec-Fetch-Site', 'same-origin')
    const response = await handleTestAppRequest(new Request('http://app.test/api/me', { headers }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ consoleRole: 'OWNER', preview: false })
    for (const key of ['EXAMPLE_UNUSED_SETTING', 'PORTAL_ENABLED']) {
      delete process.env[key]
    }
  })

  it('keeps health independent of console identity and operational configuration', async () => {
    const response = await handleTestAppRequest(new Request('http://app.test/api/health'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, service: 'cap-table' })
  })
})
