import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { VS1_TEMPLATE_ID, readHarness, type ReadHarness } from '../support/read-helpers.ts'
import { validateContractResponse } from './contract-harness.ts'

const ORIGIN = 'http://app.test'
let harness: ReadHarness

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function pathFor(route: api.AnyRoute): string {
  let id: string = crypto.randomUUID()
  if (route.path.includes('/stakeholders/:id')) id = harness.id('S04')
  else if (route.path.includes('/securities/:id')) id = harness.id('OPT-1')
  else if (route.path.includes('/valuations/:id')) id = harness.id('V5')
  else if (route.path.includes('/vesting-terms/:id')) id = VS1_TEMPLATE_ID
  else if (route.path.includes('/transactions/:id')) id = harness.acme.b.transactions[0]!.id
  else if (route.path.includes('/commands/:id')) id = harness.acme.b.reference.commands[0]!.id
  const values: Record<string, string> = {
    orgId: harness.orgId,
    id,
    emailId: crypto.randomUUID(),
    linkId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    reportKey: 'cap-table',
  }
  return route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => values[name] ?? `synthetic-${name}`)
}

beforeAll(async () => { harness = await readHarness() })
afterAll(async () => { await harness.close() })

describe('contract response harness', () => {
  it('rejects unknown success keys at the root and inside arrays', async () => {
    const request = new Request(`${ORIGIN}/api/orgs/${harness.orgId}/signatories`)
    await expect(validateContractResponse(request, json({ items: [], leaked: true })))
      .rejects.toThrow(/unknown key\(s\): leaked/)
    await expect(validateContractResponse(request, json({
      items: [{ id: crypto.randomUUID(), name: 'Signer', title: null, capabilities: [], active: true, importedFromPulley: false, leaked: true }],
    }))).rejects.toThrow(/items\.0\.leaked/)
  })

  it('rejects unknown error details and requires an opt-in for internal failures', async () => {
    const unknown = new Request(`${ORIGIN}/api/not-a-route`)
    await expect(validateContractResponse(unknown, json({
      error: { code: 'not_found', message: 'Not found', sql: 'synthetic query text' },
    }, 404))).rejects.toThrow(/error\.sql/)
    const request = new Request(`${ORIGIN}/api/orgs/${harness.orgId}/signatories`)
    const internal = () => json({ error: { code: 'internal', message: 'Synthetic failure' } }, 500)
    await expect(validateContractResponse(request, internal())).rejects.toThrow(/explicit test opt-in/)
    await expect(validateContractResponse(request, internal(), { allowInternal: true })).resolves.toBeUndefined()
  })

  it('requires invalid path parameters to answer an authorization or not-found response', async () => {
    const request = new Request(`${ORIGIN}/api/orgs/not-a-uuid/signatories`)
    await expect(validateContractResponse(request, json({ id: 1 }, 200)))
      .rejects.toThrow(/invalid path parameters/)
    await expect(validateContractResponse(request, json({
      error: { code: 'not_found', message: 'Not found' },
    }, 404))).resolves.toBeUndefined()
  })

  it('validates an unknown API path as a strict not-found envelope', async () => {
    const path = '/api/not-a-route'
    const response = await harness.api('GET', path, harness.owner)
    expect(response.status).toBe(404)
    await expect(validateContractResponse(new Request(`${ORIGIN}${path}`), response)).resolves.toBeUndefined()
  })

  it.each(api.ROUTE_TABLE)('$id validates the real router response', async (route) => {
    const path = pathFor(route)
    const body = route.method === 'GET' ? undefined : {}
    const response = await harness.api(route.method, path, harness.owner, body)
    const request = new Request(`${ORIGIN}${path}`, {
      method: route.method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    await expect(validateContractResponse(request, response, { allowInternal: false })).resolves.toBeUndefined()
  }, 30_000)
})
