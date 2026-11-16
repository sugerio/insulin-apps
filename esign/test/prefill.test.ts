// Pre-filled fields (fields.ts, prefill.ts): a template's fields nobody signs, named and labelled, whose values the
// sender gives when sending (`prefill`), or their defaults. They are drawn on the envelope's initial document before
// anyone signs, the same bytes on a retry; the envelope keeps its signers' fields only, so signing is unchanged.
// Synthetic data, in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { blobStore, MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import { assertEditorSigningFields, prefillDefinitions, validateTemplateFields } from '../src/app/server/esign/fields.ts';
import { parsePrefill, resolvePrefill, stampPrefill } from '../src/app/server/esign/prefill.ts';
import { processEnvelopeStep } from '../src/app/server/esign/envelope-completion.ts';

const SIGNERS = [
  { id: 'a', type: 'Signature', role: 'ana', page: 1, required: true, rect: { x: .05, y: .5, width: .3, height: .06 } },
  { id: 'b', type: 'Signature', role: 'marcus', page: 1, required: true, rect: { x: .55, y: .5, width: .3, height: .06 } },
];
const PREFILLED = [
  { id: 'p1', type: 'Prefill', role: '', name: 'partner.legalName', label: 'Partner legal name', required: true, page: 1, rect: { x: .05, y: .1, width: .5, height: .05 } },
  { id: 'p2', type: 'Prefill', role: '', name: 'partner.legalName', label: 'Partner legal name', required: true, page: 1, rect: { x: .05, y: .3, width: .5, height: .05 } },
  { id: 'p3', type: 'Prefill', role: '', name: 'partner.type', label: 'Partner type', required: false, default: 'Reseller', page: 1, rect: { x: .6, y: .1, width: .3, height: .05 } },
  { id: 'p4', type: 'Prefill', role: '', name: 'region', label: 'Region', required: false, page: 1, rect: { x: .6, y: .3, width: .06, height: .05 } },
];

test('the field model: pre-filled fields are nobody\'s, named alike wherever placed, and not signing fields', () => {
  const all = validateTemplateFields([...SIGNERS, ...PREFILLED], ['ana', 'marcus'], 1);
  assert.deepEqual(prefillDefinitions(all), [
    { name: 'partner.legalName', label: 'Partner legal name', required: true },
    { name: 'partner.type', label: 'Partner type', required: false, default: 'Reseller' },
    { name: 'region', label: 'Region', required: false },
  ]);
  assert.doesNotThrow(() => assertEditorSigningFields(all, ['ana', 'marcus']), 'they count toward no signer');
  for (const [why, bad] of [
    ['a signer\'s role', { ...PREFILLED[0], role: 'ana' }],
    ['no name', { ...PREFILLED[0], name: undefined }],
    ['a name with a space', { ...PREFILLED[0], name: 'legal name' }],
    ['a trailing dot', { ...PREFILLED[0], name: 'partner.' }],
    ['no label', { ...PREFILLED[0], label: '' }],
    ['a default the text renderer can\'t draw', { ...PREFILLED[0], default: 'Café' }],
  ] as const) assert.throws(() => validateTemplateFields([...SIGNERS, bad], ['ana', 'marcus'], 1), undefined, why);
  assert.throws(() => validateTemplateFields([...SIGNERS, PREFILLED[0], { ...PREFILLED[1], label: 'Another label' }], ['ana', 'marcus'], 1), /placed differently/);
  const many = Array.from({ length: 31 }, (_, i) => ({ ...PREFILLED[0], id: `n${i}`, name: `n${i}`, rect: { x: 0, y: i * .03, width: .1, height: .02 } }));
  assert.throws(() => assertEditorSigningFields(validateTemplateFields([...SIGNERS, ...many], ['ana', 'marcus'], 1), ['ana', 'marcus']), /At most 30 pre-filled/);
});

test('the values: as given or by default; unknown names, undrawable values and missing required ones are refused', () => {
  const definitions = prefillDefinitions(validateTemplateFields([...SIGNERS, ...PREFILLED], ['ana', 'marcus'], 1));
  assert.deepEqual(resolvePrefill(definitions, { 'partner.legalName': 'Kestrel Systems Ltd' }), { values: [
    { name: 'partner.legalName', label: 'Partner legal name', value: 'Kestrel Systems Ltd' },
    { name: 'partner.type', label: 'Partner type', value: 'Reseller' },
    { name: 'region', label: 'Region', value: '' },
  ] });
  assert.deepEqual(resolvePrefill(definitions, null), { error: 'prefill_missing', fields: ['partner.legalName'] });
  assert.deepEqual(resolvePrefill(definitions, { 'partner.legalName': 'Kestrel', nope: 'x' }), { error: 'unknown_prefill', fields: ['nope'] });
  assert.deepEqual(resolvePrefill(definitions, { 'partner.legalName': '凯斯特' }), { error: 'invalid_prefill', fields: ['partner.legalName'] });
  assert.deepEqual(resolvePrefill(definitions, { 'partner.legalName': ' padded ' }), { error: 'invalid_prefill', fields: ['partner.legalName'] });
  for (const bad of [[], 'x', { a: 1 }]) assert.equal(parsePrefill(bad), 'invalid');
  assert.equal(parsePrefill(undefined), null);
});

test('drawn the same every time: the same values give the same bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const source = await pdf.save();
  const fields = validateTemplateFields([...SIGNERS, ...PREFILLED], ['ana', 'marcus'], 1);
  const values = [{ name: 'partner.legalName', label: 'Partner legal name', value: 'Kestrel Systems Ltd' }];
  const one = await stampPrefill(source, fields, values), two = await stampPrefill(source, fields, values);
  assert.deepEqual(Buffer.from(one), Buffer.from(two));
  assert.notDeepEqual(Buffer.from(one), Buffer.from(source));
  assert.equal(await stampPrefill(source, fields, []), source, 'nothing to draw: the source itself');
});

test('sent with values: drawn on the document signers see; the envelope keeps its signers\' fields; signing is unchanged', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB'), bucket = await blobStore(mf, 'artifacts'), mail = await blobStore(mf, 'test-mail');
    for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) await db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map((s) => db.prepare(s)));
    const key = 'local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz', origin = 'https://host.example.com', hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('hex');
    await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('a')"), db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(hash)]);
    const env = { DB: db, ARTIFACTS: bucket, TEST_MAIL: mail, SIGNING_PAGE_ORIGINS: origin, OTP_KEY: 'local-test-pepper-at-least-32-bytes', TEST_SEAL_KEY: 'local-test-seal-key-at-least-32-bytes' };
    const req = (path: string, init: RequestInit = {}) => app.fetch(new Request('http://localhost' + path, init), env), mgmt = { authorization: `Bearer ${key}` };
    const post = (body: unknown, headers: Record<string, string>) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
    const source = await pdf.save();
    const form = new FormData(); form.set('file', new File([source], 'synthetic.pdf')); form.set('roles', '["ana","marcus"]');
    const template = await (await req('/api/templates', { method: 'POST', headers: mgmt, body: form })).json() as { id: string };
    await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify([...SIGNERS, ...PREFILLED]), template.id).run();
    // The template says what to give.
    const read = await (await req(`/api/templates/${template.id}`, { headers: mgmt })).json() as { prefill: unknown; positionedFieldsSupported: boolean; fields: { type: string; name?: string }[] };
    assert.equal(read.positionedFieldsSupported, true);
    assert.deepEqual(read.prefill, [{ name: 'partner.legalName', label: 'Partner legal name', required: true }, { name: 'partner.type', label: 'Partner type', required: false, default: 'Reseller' }, { name: 'region', label: 'Region', required: false }]);
    assert.equal(read.fields.filter((f) => f.type === 'Prefill' && f.name === 'partner.legalName').length, 2);
    const listed = (await (await req('/api/templates', { headers: mgmt })).json() as { templates: { prefill: unknown[] }[] }).templates[0]!;
    assert.equal(listed.prefill.length, 3);
    const recipients = [{ role: 'ana', name: 'Ana', email: 'ana@example.com' }, { role: 'marcus', name: 'Marcus', email: 'marcus@example.com' }];
    const send = (prefill: unknown, k = crypto.randomUUID()) => req('/api/envelopes', post({ templateId: template.id, recipients, ...(prefill === undefined ? {} : { prefill }) }, { ...mgmt, 'idempotency-key': k }));
    // Refused before anything is made.
    assert.deepEqual(await (await send(undefined)).json(), { error: 'prefill_missing', fields: ['partner.legalName'] });
    assert.deepEqual(await (await send({ 'partner.legalName': 'Kestrel', unknown: 'x' })).json(), { error: 'unknown_prefill', fields: ['unknown'] });
    assert.deepEqual(await (await send({ 'partner.legalName': 'Kestrel', region: 'Asia Pacific and Japan' })).json(), { error: 'prefill_too_long', fields: ['region'] });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first<{ n: number }>())!.n, 0);
    // Sent: the document has the values; the envelope its signers' fields; a retry the very same document.
    const k = 'prefill-1', prefill = { 'partner.legalName': 'Kestrel Systems Ltd' };
    const created = await send(prefill, k);
    assert.equal(created.status, 201, await created.clone().text());
    const { id } = await created.json() as { id: string };
    assert.equal((await send(prefill, k)).status, 201, 'a retry is the same envelope');
    const row = (await db.prepare('SELECT fields_json FROM envelopes WHERE id=?').bind(id).first<{ fields_json: string }>())!;
    assert.deepEqual(JSON.parse(row.fields_json), SIGNERS);
    const shown = await (await req(`/api/envelopes/${id}`, { headers: mgmt })).json() as { prefill: unknown; tasks: { id: string; recipientEmail: string }[] };
    assert.deepEqual(shown.prefill, [{ name: 'partner.legalName', label: 'Partner legal name', value: 'Kestrel Systems Ltd' }, { name: 'partner.type', label: 'Partner type', value: 'Reseller' }]);
    const d0 = (await db.prepare("SELECT object_key, sha256 FROM artifacts WHERE envelope_id=? AND id LIKE 'd0:%'").bind(id).first<{ object_key: string; sha256: string }>())!;
    const stored = new Uint8Array(await (await bucket.get(d0.object_key))!.arrayBuffer());
    const expected = await stampPrefill(source, validateTemplateFields([...SIGNERS, ...PREFILLED], ['ana', 'marcus'], 1), [{ name: 'partner.legalName', label: 'Partner legal name', value: 'Kestrel Systems Ltd' }, { name: 'partner.type', label: 'Partner type', value: 'Reseller' }]);
    assert.deepEqual(Buffer.from(stored), Buffer.from(expected), 'the values drawn, as drawn again');
    const xobjects = (await PDFDocument.load(stored)).getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    assert.equal(xobjects.keys().length, 3, 'drawn where placed: the legal name twice, the type once, the empty region not at all');
    assert.equal(new Set(xobjects.values().map(String)).size, 2, 'one image per value');
    // Each signer signs as before: their own fields only, on the document with the values.
    for (let i = 0; i < 2; i++) {
      const task = shown.tasks[i]!;
      const view = await (await req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`, post({ signedInEmail: task.recipientEmail, origin }, mgmt))).json() as { code: string };
      const session = await (await req('/api/public/page-sessions/exchange', post({ code: view.code }, { origin }))).json() as { token: string }, h = { origin, 'x-esign-session': session.token };
      const sent = await (await req('/api/public/signing/otp', post({}, h))).json() as { messageId: string }, message = await (await mail.get(`test-mail/${sent.messageId}.json`))!.json() as { otp: string };
      assert.equal((await req('/api/public/signing/otp/verify', post({ otp: message.otp }, h))).status, 204);
      const current = await (await req('/api/public/signing/current', { headers: h })).json() as { id: string; sha256: string; fields: unknown[] };
      assert.deepEqual(current.fields, [SIGNERS[i]]);
      if (!i) assert.equal(current.sha256, d0.sha256, 'the first signer signs the document with the values');
      const fieldId = SIGNERS[i]!.id, text = i ? 'MARCUS' : 'ANA';
      const preview = await req('/api/public/signing/preview', post({ fieldId, text }, h));
      assert.equal(preview.status, 200);
      const signed = await req('/api/public/signing/sign', post({ artifactId: current.id, artifactHash: current.sha256, consent: true, signatures: { [fieldId]: text }, signaturePreviews: { [fieldId]: preview.headers.get('X-Signature-Preview') } }, h));
      assert.equal(signed.status, 202, await signed.clone().text());
      assert.equal(await processEnvelopeStep(env.DB, env.ARTIFACTS, 'a', id), 'processed');
    }
  } finally { await mf.dispose(); }
});
