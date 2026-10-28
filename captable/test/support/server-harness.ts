import type { LocalD1 } from '../../src/local-d1.ts'
import { createApp } from '../../src/app/server/app.ts'
import { openMigratedDatabase } from '../db/helpers.ts'

let testDatabase: D1Database | undefined
let testNow: number | undefined
let importBatchFailure: ((batchIndex: number) => Error | null) | undefined
let importBatchPause: ((batchIndex: number) => Promise<void>) | undefined
const testApp = createApp({
  now: () => testNow ?? Date.now(),
  enforceSameOrigin: true,
  runImportBatch: async (db, statements, batchIndex) => {
    const error = importBatchFailure?.(batchIndex)
    if (error) throw error
    await importBatchPause?.(batchIndex)
    return await db.batch(statements)
  },
})

export function useAppNowForTests(now: number | undefined): void {
  testNow = now
}

export function failImportBatchForTests(failure: ((batchIndex: number) => Error | null) | undefined): void {
  importBatchFailure = failure
}

export function pauseImportBatchForTests(pause: ((batchIndex: number) => Promise<void>) | undefined): void {
  importBatchPause = pause
}

export async function handleTestAppRequest(request: Request): Promise<Response> {
  if (!testDatabase) throw new Error('Create a test database before sending an app request')
  return testApp.fetch(request, { DB: testDatabase })
}

export interface TestDatabase {
  db: LocalD1
  close: () => Promise<void>
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openMigratedDatabase()
  testDatabase = db
  return {
    db,
    close: async () => {
      testDatabase = undefined
      importBatchFailure = undefined
      importBatchPause = undefined
      db.close()
    },
  }
}

/** Compatibility helper for tests that exercise the request handler against the local D1 database. */
export const createLegacyTestDatabase = createTestDatabase

export interface ConsoleIdentity {
  userId: string
  organizationId: string
  appId: string
  role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'USER' | 'VIEWER'
  email: string
  name: string
}

export const CONSOLE_USER: ConsoleIdentity = {
  userId: 'console-user-1',
  organizationId: 'console-org-1',
  appId: 'cap-table-test',
  role: 'OWNER',
  email: 'owner@example.test',
  name: 'Owner Example',
} as const

export function consoleHeaders(overrides: Partial<ConsoleIdentity> = {}): Record<string, string> {
  const user = { ...CONSOLE_USER, ...overrides }
  return {
    'x-suger-user-id': user.userId,
    'x-suger-organization-id': user.organizationId,
    'x-suger-app-id': user.appId,
    'x-suger-app-role': user.role,
    'x-suger-user-email': user.email,
    'x-suger-user-name': user.name,
  }
}

export function appRequest(path: string, init: RequestInit = {}, identity = consoleHeaders()): Promise<Response> {
  if (!testDatabase) throw new Error('Create a test database before sending an app request')
  return appRequestWithDatabase(testDatabase, path, init, identity)
}

/** Sends through the real app with an injected D1 binding (used to force commit-boundary races). */
export async function appRequestWithDatabase(
  database: D1Database,
  path: string,
  init: RequestInit = {},
  identity = consoleHeaders(),
): Promise<Response> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(identity)) headers.set(name, value)
  headers.set('Origin', 'http://app.test')
  headers.set('Sec-Fetch-Site', 'same-origin')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID())
  }
  return await testApp.fetch(new Request(`http://app.test${path}`, { ...init, method, headers }), { DB: database })
}

export function jsonRequest(path: string, method: string, body: unknown, identity = consoleHeaders()): Promise<Response> {
  return appRequest(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, identity)
}
