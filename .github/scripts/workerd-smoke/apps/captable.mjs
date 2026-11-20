// Cap Table's workerd smoke checks (smoke.mjs --app captable): the main paths with synthetic data, one organization
// kept apart from another, a template import, a document upload and download, and the holder view.
import { createHash, randomUUID } from 'node:crypto'
import { strToU8, unzipSync, zipSync } from 'fflate'

const AS_OF = '2026-10-27'

/** The harness waits for this path to answer this status before the checks start. */
export const ready = { path: '/api/health', status: 200 }

function identity(
  role = 'OWNER',
  email = 'owner@example.test',
  userId = `smoke-${role.toLowerCase()}`,
  organizationId = 'smoke-console-org',
) {
  return {
    'x-suger-user-id': userId,
    'x-suger-organization-id': organizationId,
    'x-suger-app-id': 'captable-workerd-smoke',
    'x-suger-app-role': role,
    'x-suger-user-email': email,
    'x-suger-user-name': 'Smoke Test User',
  }
}

function sameOriginHeaders(base, headers = {}) {
  return { ...identity(), Origin: base, 'Sec-Fetch-Site': 'same-origin', ...headers }
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function column(index) {
  let value = index + 1
  let letters = ''
  while (value > 0) {
    value -= 1
    letters = String.fromCharCode(65 + value % 26) + letters
    value = Math.floor(value / 26)
  }
  return letters
}

function rowXml(row, values) {
  const cells = values.map((value, index) => value === '' ? ''
    : `<c r="${column(index)}${row}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')
  return `<row r="${row}">${cells}</row>`
}

/** Fill the app-generated workbook so the smoke always exercises the public template format. */
function syntheticTemplate(blank) {
  const archive = unzipSync(blank)
  const rows = new Map([
    [2, ['Smoke Example, Inc.', AS_OF, 'USD']],
    [3, ['holder_1', 'Smoke Holder', 'Individual', 'Founder', 'smoke.holder@example.test', '', '']],
    [4, ['common', 'Common Stock', 'Common', '1000', '', '0.01']],
    [6, ['CS-1', 'holder_1', 'common', '', '100', '2024-01-02', '0.01']],
  ])
  for (const [sheet, values] of rows) {
    const name = `xl/worksheets/sheet${sheet}.xml`
    const current = new TextDecoder().decode(archive[name])
    if (!current.includes('</sheetData>')) throw new Error(`Generated workbook is missing ${name}`)
    archive[name] = strToU8(current.replace('</sheetData>', `${rowXml(2, values)}</sheetData>`))
  }
  return zipSync(archive, { level: 6 })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function multipartTemplate(bytes, commit = false) {
  const form = new FormData()
  if (!commit) form.set('source', 'template')
  form.set('asOfDate', AS_OF)
  form.set('timezone', 'America/New_York')
  form.set('jurisdiction', 'US-NY')
  form.set('fiscalYearEnd', '09-30')
  form.set('files', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'smoke-cap-table.xlsx')
  return form
}

export default async function checks({ base, response, json }) {
  await response(base, '/api/health', {}, 200, 'health')
  await response(base, '/api/me', {}, 401, 'missing console identity')
  const owner = sameOriginHeaders(base)
  const setupMe = await json(base, '/api/me', { headers: owner }, 200, 'owner setup state')
  if (setupMe.company !== null) throw new Error('owner setup state: expected no company')
  await response(base, '/companies/deep-link', {}, 200, 'SPA deep link')
  await response(base, '/api/__suger/version', { headers: owner }, 200, 'runtime version')
  await response(base, '/api/__suger/app-builder/data', {}, 404, 'app builder data panel closed without identity')
  await response(base, '/api/__suger/app-builder/data', { headers: owner }, 404, 'app builder data panel closed with identity')

  await response(base, '/api/orgs', {
    method: 'POST',
    headers: sameOriginHeaders('https://outside.example.test', {
      Origin: 'https://outside.example.test', 'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
    }),
    body: JSON.stringify({ orgKey: 'should-not-exist', legalName: 'Blocked, Inc.', displayName: 'Blocked', timezone: 'UTC' }),
  }, 403, 'cross-origin write refused')

  const placeholder = await json(base, '/api/orgs', {
    method: 'POST', headers: sameOriginHeaders(base, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ orgKey: 'smoke-example', legalName: 'Smoke Placeholder, Inc.', displayName: 'Smoke Placeholder',
      timezone: 'America/New_York', jurisdiction: 'US-NY', currency: 'USD', fiscalYearEnd: '09-30' }),
  }, 201, 'empty company setup')
  await response(base, `/api/orgs/${placeholder.id}/dashboard`, { headers: owner }, 200, 'empty dashboard')
  await response(base, `/api/admin/orgs/${placeholder.id}/verify-ledger`, {
    method: 'POST', headers: sameOriginHeaders(base, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), body: '{}',
  }, 200, 'empty ledger verification')
  await response(base, `/api/orgs/${placeholder.id}/process-due`, { method: 'POST', headers: owner }, 200, 'empty process-due')

  const blank = await response(base, '/api/import/template', { headers: owner }, 200, 'template download')
  const workbook = syntheticTemplate(blank.body)
  const preview = await json(base, '/api/import/preview', {
    method: 'POST', headers: owner, body: multipartTemplate(workbook),
  }, 201, 'template import preview')
  if (!preview.preview.canImport || preview.preview.problems.some((problem) => problem.severity === 'error')) {
    throw new Error(`template import preview was not ready: ${JSON.stringify(preview.preview.problems)}`)
  }
  if (preview.preview.counts.stakeholders !== 1 || preview.preview.counts.securities !== 1) {
    throw new Error(`template import preview had wrong counts: ${JSON.stringify(preview.preview.counts)}`)
  }
  const secondIdentity = identity('OWNER', 'second.owner@example.test', 'smoke-second-owner', 'smoke-console-org-2')
  const secondOwner = sameOriginHeaders(base, secondIdentity)
  const secondSetup = await json(base, '/api/me', { headers: secondOwner }, 200, 'second organization setup state')
  if (secondSetup.company !== null) throw new Error('second organization setup state: expected no company')
  await response(base, `/api/orgs/${placeholder.id}/dashboard`, { headers: secondOwner }, 404, 'second organization cannot read first dashboard')
  await response(base, `/api/import/runs/${preview.runId}/commit`, {
    method: 'POST',
    headers: sameOriginHeaders(base, { ...secondIdentity, 'Idempotency-Key': randomUUID() }),
    body: multipartTemplate(workbook, true),
  }, 404, 'second organization cannot commit first import')
  await response(base, `/api/import/runs/${preview.runId}`, {
    headers: secondOwner,
  }, 404, 'second organization cannot read first import')
  const secondCompany = await json(base, '/api/orgs', {
    method: 'POST',
    headers: sameOriginHeaders(base, {
      ...secondIdentity, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
    }),
    body: JSON.stringify({ orgKey: 'smoke-example', legalName: 'Second Smoke Example, Inc.', displayName: 'Second Smoke Example',
      timezone: 'UTC', jurisdiction: 'US-DE', currency: 'USD', fiscalYearEnd: '12-31' }),
  }, 201, 'second organization company setup')
  await response(base, `/api/orgs/${secondCompany.id}/dashboard`, { headers: secondOwner }, 200, 'second organization dashboard')
  await response(base, `/api/admin/orgs/${placeholder.id}/verify-ledger`, {
    method: 'POST',
    headers: sameOriginHeaders(base, { ...secondIdentity, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: '{}',
  }, 404, 'second organization cannot verify first ledger')
  const imported = await json(base, `/api/import/runs/${preview.runId}/commit`, {
    method: 'POST', headers: sameOriginHeaders(base, { 'Idempotency-Key': randomUUID() }), body: multipartTemplate(workbook, true),
  }, 200, 'template import commit')
  await response(base, `/api/orgs/${imported.orgId}/cap-table?asOf=${AS_OF}`, { headers: owner }, 200, 'cap table after import')
  await response(base, `/api/orgs/${imported.orgId}/dashboard`, { headers: owner }, 200, 'dashboard after import')
  await response(base, `/api/orgs/${imported.orgId}/dashboard`, { headers: secondOwner }, 404, 'second organization remains isolated')
  await response(base, `/api/orgs/${secondCompany.id}/dashboard`, { headers: owner }, 404, 'first organization remains isolated')
  const holderHeaders = sameOriginHeaders(base, identity('USER', 'smoke.holder@example.test', 'smoke-holder'))
  const holderOverview = await json(base, '/api/portal/overview', { headers: holderHeaders }, 200, 'matching holder view')
  const secondHolderHeaders = sameOriginHeaders(base, identity(
    'USER', 'smoke.holder@example.test', 'smoke-holder', 'smoke-console-org-2',
  ))
  await response(base, '/api/portal/overview', { headers: secondHolderHeaders }, 404, 'second organization holder remains isolated')
  await response(base, `/api/admin/orgs/${imported.orgId}/verify-ledger`, {
    method: 'POST', headers: sameOriginHeaders(base, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), body: '{}',
  }, 200, 'imported ledger verification')

  const secondPreview = await json(base, '/api/import/preview', {
    method: 'POST', headers: owner, body: multipartTemplate(workbook),
  }, 201, 'second import preview')
  await response(base, `/api/import/runs/${secondPreview.runId}/commit`, {
    method: 'POST', headers: sameOriginHeaders(base, { 'Idempotency-Key': randomUUID() }), body: multipartTemplate(workbook, true),
  }, 409, 'second import refused')

  const documentBytes = new Uint8Array(1_600_000)
  for (let index = 0; index < documentBytes.length; index += 1) documentBytes[index] = index % 251
  documentBytes.set(new TextEncoder().encode('%PDF-1.7\n% synthetic workerd smoke\n'))
  const uploaded = await json(base, `/api/orgs/${imported.orgId}/documents`, {
    method: 'POST',
    headers: sameOriginHeaders(base, {
      'Content-Type': 'application/pdf', 'X-Filename': 'synthetic-smoke.pdf', 'X-Document-Kind': 'GRANT_AGREEMENT',
      'X-Content-SHA256': sha256(documentBytes), 'Idempotency-Key': randomUUID(),
      'X-Link-Target': 'stakeholder', 'X-Link-Id': holderOverview.holdings[0].stakeholderId, 'X-Link-Role': 'AGREEMENT',
    }),
    body: documentBytes,
  }, 201, 'chunked document upload')
  await response(base, `/api/orgs/${imported.orgId}/documents/${uploaded.id}/holder-visibility`, {
    method: 'POST',
    headers: sameOriginHeaders(base, { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ version: 1, visible: true }),
  }, 200, 'holder document visibility')
  const editor = sameOriginHeaders(base, identity('EDITOR', 'editor@example.test', 'smoke-editor'))
  const downloaded = await response(base, `/api/orgs/${imported.orgId}/documents/${uploaded.id}/download`, { headers: editor }, 200, 'EDITOR document download')
  if (sha256(downloaded.body) !== sha256(documentBytes)) throw new Error('Document download bytes differed from the upload')
  await response(base, `/api/portal/documents/${uploaded.id}/download`, {
    headers: holderHeaders,
  }, 200, 'matching holder document download')
  await response(base, `/api/portal/documents/${uploaded.id}/download`, {
    headers: secondHolderHeaders,
  }, 404, 'second organization cannot download first holder document')
  const viewer = sameOriginHeaders(base, identity('VIEWER', 'unmatched@example.test', 'smoke-viewer'))
  await response(base, '/api/portal/overview', { headers: viewer }, 404, 'unmatched VIEWER refused')
}
