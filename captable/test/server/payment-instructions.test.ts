import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { getJson, readHarness, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

const DETAILS = {
  bankName: 'Example Bank',
  beneficiaryName: 'Acme Robotics, Inc.',
  beneficiaryAddress: '1 Main Street',
  accountNumber: '000111222333',
  routingNumber: '021000021',
  iban: 'GB29NWBK60161331927766',
  swift: 'EXAMPLT1',
  referenceFormat: 'Holder name and grant number',
}

describe('simple payment instruction administration', () => {
  it('starts empty, sets a current value, and exposes its updater', async () => {
    harness = await readHarness()
    expect(await getJson(harness, harness.owner, '/payment-instructions')).toBeNull()
    const response = await harness.api('POST', harness.path('/payment-instructions'), harness.admin, {
      details: DETAILS, updatedAt: null,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(api.paymentInstructionSchema.parse(await response.json())).toMatchObject({
      details: DETAILS, updatedBy: 'Admin Example', updatedAt: Date.now(),
    })
    expect(await getJson(harness, harness.editor, '/payment-instructions')).toMatchObject({
      details: { ...DETAILS, accountNumber: '••••2333', iban: '••••7766' },
    })
    expect(await harness.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment_instructions.set'").first<number>('n')).toBe(1)
  })

  it('replaces the current value and replays the same idempotent request', async () => {
    harness = await readHarness()
    const key = crypto.randomUUID()
    const first = await harness.api('POST', harness.path('/payment-instructions'), harness.owner, {
      details: DETAILS, updatedAt: null,
    }, { 'Idempotency-Key': key })
    const firstBody = await first.clone().json() as { updatedAt: number }
    const replay = await harness.api('POST', harness.path('/payment-instructions'), harness.owner, {
      details: DETAILS, updatedAt: null,
    }, { 'Idempotency-Key': key })
    expect(replay.status).toBe(200)
    expect(replay.headers.get('Idempotent-Replay')).toBe('true')
    expect(await replay.json()).toEqual(await first.json())
    const replacement = { ...DETAILS, bankName: 'Replacement Example Bank', accountNumber: '999888777666' }
    expect((await harness.api('POST', harness.path('/payment-instructions'), harness.admin, {
      details: replacement, updatedAt: firstBody.updatedAt,
    })).status).toBe(200)
    expect(await getJson(harness, harness.owner, '/payment-instructions')).toMatchObject({ details: replacement })
    const stale = await harness.api('POST', harness.path('/payment-instructions'), harness.owner, {
      details: DETAILS, updatedAt: firstBody.updatedAt,
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { reason: 'stale_version' } })
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM payment_instructions').first<number>('n')).toBe(1)
    expect(await harness.db.prepare('SELECT version FROM payment_instructions').first<number>('version')).toBe(2)
  })

  it('refuses editor writes and validates the details contract', async () => {
    harness = await readHarness()
    expect((await harness.api('POST', harness.path('/payment-instructions'), harness.editor, {
      details: DETAILS, updatedAt: null,
    })).status).toBe(403)
    const invalid = await harness.api('POST', harness.path('/payment-instructions'), harness.owner, {
      details: { ...DETAILS, routingNumber: 'not-a-routing-number' }, updatedAt: null,
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'validation_failed' } })
  })
})
