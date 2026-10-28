import { afterEach, describe, expect, it } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
import { uuid } from '../shared/engine/fixtures/builder.ts'
import {
  addDocument,
  getJson,
  holderIdentity,
  readHarness,
  VS1_TEMPLATE_ID,
  type ReadHarness,
} from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

async function post(suffix: string, identity: Record<string, string>, body: unknown, key = crypto.randomUUID()) {
  const path = suffix.startsWith('/api/') ? suffix : harness!.path(suffix)
  const response = await harness!.api('POST', path, identity, body, { 'Idempotency-Key': key })
  return {
    status: response.status,
    body: await response.json().catch(() => null) as Record<string, unknown> | null,
    replay: response.headers.get('Idempotent-Replay'),
  }
}

function codesOf(body: unknown): string[] {
  return ((body as { error?: { violations?: { code: string }[] } } | null)?.error?.violations ?? [])
    .map((violation) => violation.code)
}

async function report(): Promise<string> {
  return addDocument(harness!.db, harness!.orgId, 'VALUATION_REPORT')
}

function recordBody(reportDocumentId: string, extra: Record<string, unknown> = {}) {
  return {
    provider: 'Synthetic Valuations LLC', effectiveDate: '2026-10-15',
    prices: [{ stockClassId: harness!.id('class:CS'), pricePerShare: '1.1' }],
    reportDocumentId, ...extra,
  }
}

describe('recording a 409A', () => {
  it('records an immutable valuation, supersedes the earlier one and replays idempotently', async () => {
    harness = await readHarness()
    const documentId = await report()
    const key = crypto.randomUUID()
    const recorded = await post('/valuations', harness.admin, recordBody(documentId), key)
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201)
    const valuation = api.valuationSchema.parse(recorded.body)
    expect(valuation).toMatchObject({
      name: 'Oct 2026 Valuation', valuationType: '409A', provider: 'Synthetic Valuations LLC',
      effectiveDate: '2026-10-15', expirationDate: '2027-10-15', reportVersion: 'FINAL',
      prices: [{ stockClassId: harness.id('class:CS'), pricePerShare: '1.1' }],
      status: 'presumptively_valid', reportDocumentId: documentId, importedFromPulley: false,
    })
    expect(await post('/valuations', harness.admin, recordBody(documentId), key))
      .toMatchObject({ status: 201, replay: 'true', body: recorded.body })
    expect((await post('/valuations', harness.admin, recordBody(documentId, { provider: 'Other' }), key)).body)
      .toMatchObject({ error: { reason: 'idempotency_key_reused' } })
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM valuations WHERE org_id = ?').bind(harness.orgId).first('n')).toBe(6)
    expect(await harness.db.prepare('SELECT role FROM document_links WHERE valuation_id = ?').bind(valuation.id).first('role')).toBe('REPORT')
    expect(await harness.db.prepare("SELECT result FROM audit_events WHERE action = 'valuation.recorded' AND target_id = ?")
      .bind(valuation.id).first('result')).toBe('success')
    expect((await getJson<api.FmvResponse>(harness, harness.editor, '/valuations/fmv?date=2026-10-21')).fmv)
      .toMatchObject({ valuationId: valuation.id, pricePerShare: '1.1', status: 'presumptively_valid' })
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE valuation_id = ?').bind(valuation.id).first('n')).toBe(0)
  })

  it('refuses invalid valuation prices, dates, reports and references without writes', async () => {
    harness = await readHarness()
    const documentId = await report()
    const codes = async (extra: Record<string, unknown>, reportId = documentId) => {
      const result = await post('/valuations', harness!.admin, recordBody(reportId, extra))
      expect(result.status, JSON.stringify(result.body)).toBe(422)
      return codesOf(result.body)
    }
    expect(await codes({ prices: [{ stockClassId: harness.id('class:PS'), pricePerShare: '2' }] })).toEqual(['COMMON_PRICE_REQUIRED'])
    expect(await codes({
      prices: [
        { stockClassId: harness.id('class:CS'), pricePerShare: '1' },
        { stockClassId: harness.id('class:CS'), pricePerShare: '1.2' },
      ],
    })).toEqual(['DUPLICATE_CLASS_PRICE'])
    expect(await codes({ expirationDate: '2026-10-15' })).toEqual(['EXPIRATION_NOT_AFTER_EFFECTIVE'])
    expect(await codes({ effectiveDate: '2025-11-05' })).toEqual(['VALUATION_ON_DATE_EXISTS'])
    const archived = await report()
    await harness.db.prepare('UPDATE documents SET archived_at = ?, version = version + 1 WHERE id = ?')
      .bind(Date.now(), archived).run()
    expect(await codes({}, archived)).toEqual(['DOCUMENT_ARCHIVED'])
    expect((await post('/valuations', harness.admin, recordBody(documentId, {
      prices: [{ stockClassId: uuid('class:none'), pricePerShare: '1' }],
    }))).status).toBe(404)
    expect((await post('/valuations', harness.admin, recordBody(uuid('doc:none')))).status).toBe(404)
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM valuations WHERE org_id = ?').bind(harness.orgId).first('n')).toBe(5)
  })

  it('permits OWNER and ADMIN, but refuses EDITOR and holders', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const documentId = await report()
    expect((await post('/valuations', harness.editor, recordBody(documentId))).status).toBe(403)
    expect((await post('/valuations', holderIdentity('holder@example.test'), recordBody(documentId))).status).toBe(404)
    expect((await post('/valuations', harness.owner, recordBody(documentId))).status).toBe(201)
  })
})

describe('material events, review and voids', () => {
  it('flags a material event and removes the valuation from FMV', async () => {
    harness = await readHarness()
    const valuation = api.valuationSchema.parse((await post(
      '/valuations', harness.admin, recordBody(await report()),
    )).body)
    const evidence = await addDocument(harness.db, harness.orgId, 'OTHER')
    const flagged = await post('/valuations/material-events', harness.admin, {
      eventDate: '2026-10-18', description: 'Term sheet signed', documentId: evidence,
    })
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(200)
    expect(flagged.body).toMatchObject({
      id: valuation.id, status: 'review_required', presumptivelyValidUntil: null,
      events: [{ kind: 'MATERIAL_EVENT', eventDate: '2026-10-18', description: 'Term sheet signed', documentId: evidence }],
    })
    expect((await getJson<api.FmvResponse>(harness, harness.editor, '/valuations/fmv?date=2026-10-21')).fmv).toBeNull()
    expect((await getJson<api.DashboardResponse>(harness, harness.editor, '/dashboard')).needsAttention
      .find((item) => item.kind === 'VALUATION_STATUS')?.count).toBe(1)
    expect(codesOf((await post('/valuations/material-events', harness.admin, {
      eventDate: '2026-10-19', description: 'Again',
    })).body)).toEqual(['NO_PRESUMPTIVELY_VALID_409A'])
  })

  it('clears a review with written confirmation and allows a later same-day flag', async () => {
    harness = await readHarness()
    const valuation = api.valuationSchema.parse((await post(
      '/valuations', harness.admin, recordBody(await report()),
    )).body)
    await post('/valuations/material-events', harness.admin, { eventDate: '2026-10-18', description: 'Term sheet signed' })
    const letter = await addDocument(harness.db, harness.orgId, 'COUNSEL_MEMO')
    const clear = { eventDate: '2026-10-19', description: 'Provider confirms the valuation holds', documentId: letter }
    const cleared = await post(`/valuations/${valuation.id}/review-cleared`, harness.owner, clear)
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(cleared.body).toMatchObject({
      status: 'presumptively_valid', events: [{ kind: 'MATERIAL_EVENT' }, { kind: 'REVIEW_CLEARED', documentId: letter }],
    })
    expect(codesOf((await post(`/valuations/${valuation.id}/review-cleared`, harness.owner, clear)).body))
      .toEqual(['NO_REVIEW_REQUIRED'])
    const again = await post('/valuations/material-events', harness.admin, {
      eventDate: '2026-10-19', description: 'Secondary sale',
    })
    expect(again.body).toMatchObject({ status: 'review_required' })
  })

  it('reverses a material-event flag once with typed confirmation', async () => {
    harness = await readHarness()
    const valuation = api.valuationSchema.parse((await post(
      '/valuations', harness.admin, recordBody(await report()),
    )).body)
    const flagged = api.valuationSchema.parse((await post('/valuations/material-events', harness.admin, {
      eventDate: '2026-10-18', description: 'Flagged in error',
    })).body)
    const event = flagged.events[0]!
    const path = `/valuations/${valuation.id}/events/${event.id}/reverse`
    expect((await post(path, harness.owner, { note: 'Not material', confirmation: 'Wrong' })).status).toBe(400)
    const reversed = await post(path, harness.owner, { note: 'Not material', confirmation: valuation.name })
    expect(reversed.status).toBe(200)
    expect(reversed.body).toMatchObject({
      status: 'presumptively_valid',
      events: [{ kind: 'MATERIAL_EVENT' }, { kind: 'EVENT_REVERSED', reversesEventId: event.id }],
    })
    expect((await post(path, harness.owner, { note: 'Again', confirmation: valuation.name })).body)
      .toMatchObject({ error: { code: 'conflict', reason: 'state_changed' } })
  })

  it('voids a valuation and brings the earlier 409A back into force', async () => {
    harness = await readHarness()
    const valuation = api.valuationSchema.parse((await post(
      '/valuations', harness.admin, recordBody(await report()),
    )).body)
    const voided = await post(`/valuations/${valuation.id}/void`, harness.owner, {
      eventDate: '2026-10-20', description: 'Recorded in error',
    })
    expect(voided.status, JSON.stringify(voided.body)).toBe(200)
    expect(voided.body).toMatchObject({ status: 'voided' })
    expect((await getJson<api.FmvResponse>(harness, harness.editor, '/valuations/fmv?date=2026-10-21')).fmv)
      .toMatchObject({ valuationId: harness.id('V5'), pricePerShare: '0.95' })
  })
})

describe('confirming an imported vesting template', () => {
  it('records the confirmation once on an imported template', async () => {
    harness = await readHarness()
    const template = uuid('template:imported')
    const definition = {
      type: 'SCHEDULE', totalMonths: 48, frequency: 'MONTHLY',
      cliff: { months: 12, quantityRule: 'RATABLE' }, dayRule: 'SAME_DAY_CLAMPED',
    }
    await harness.db.prepare(
      `INSERT INTO vesting_terms
       (id, org_id, name, is_template, definition, definition_sha256, algorithm_version, created_at, pulley_id)
       VALUES (?, ?, 'Imported 4-year monthly', 1, ?, ?, 1, ?, 'syn-template-1')`,
    ).bind(
      template, harness.orgId, engine.canonicalJson(definition), engine.definitionSha256(definition as never),
      Date.now(),
    ).run()
    const path = `/vesting-terms/${template}/confirm`
    expect((await post(path, harness.editor, {})).status).toBe(403)
    const key = crypto.randomUUID()
    const confirmed = await post(path, harness.owner, {}, key)
    expect(confirmed.status).toBe(200)
    expect(api.vestingTermsSchema.parse(confirmed.body)).toMatchObject({
      id: template, isTemplate: true, importedFromPulley: true, confirmedBy: 'Owner Example', confirmedAt: Date.now(),
    })
    expect(await post(path, harness.owner, {}, key)).toMatchObject({ status: 200, replay: 'true' })
    expect(codesOf((await post(`/vesting-terms/${VS1_TEMPLATE_ID}/confirm`, harness.owner, {})).body))
      .toEqual(['NOT_AN_IMPORTED_TEMPLATE'])
  })
})
