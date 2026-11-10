import {applyMigrations, blobStore} from './helpers/platform.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { envelopeIdFor, initialDocumentKey, InitialDocumentConflict, storeInitialDocument } from '../src/app/server/esign/prepare.ts';

test('the envelope id is a version 8 UUID fixed by the tenant and the idempotency key', async () => {
  const id = await envelopeIdFor('tenant', 'request-1');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await envelopeIdFor('tenant', 'request-1'), id);
  assert.notEqual(await envelopeIdFor('tenant', 'request-2'), id);
  assert.notEqual(await envelopeIdFor('other', 'request-1'), id);
  // The parts are encoded, not concatenated: moving a character between them changes the id.
  assert.notEqual(await envelopeIdFor('tenant-a', 'b'), await envelopeIdFor('tenant', 'a-b'));
});

test('the initial document is the source stored once under the envelope, and a retry reuses it', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    await applyMigrations(await mf.getD1Database('DB'));
    const bucket = await blobStore(mf,'artifacts');
    const id = await envelopeIdFor('tenant', 'request-1');
    await assert.rejects(() => storeInitialDocument(bucket, 'source', id), /Source artifact missing/);
    assert.equal((await bucket.list({ prefix: 'envelopes/' })).objects.length, 0);
    await bucket.put('source', 'document');
    const results = await Promise.all([storeInitialDocument(bucket, 'source', id), storeInitialDocument(bucket, 'source', id)]);
    const expected = { id: `d0:${id}`, objectKey: initialDocumentKey(id), sha256: '43cc23fa52b87b4cc1d02b5b114154151d6adddb17c9fddc06b027fa99e24008' };
    assert.deepEqual(results, [expected, expected]);
    assert.equal(expected.objectKey, `envelopes/${id}/d0.pdf`);
    assert.deepEqual(await storeInitialDocument(bucket, 'source', id), expected);
    assert.equal((await bucket.list({ prefix: 'envelopes/' })).objects.length, 1);
    assert.equal(await (await bucket.get(expected.objectKey))!.text(), 'document');
    // Other bytes under the same envelope are refused and do not replace the stored document.
    await bucket.put('other-source', 'another document');
    await assert.rejects(() => storeInitialDocument(bucket, 'other-source', id), InitialDocumentConflict);
    assert.equal(await (await bucket.get(expected.objectKey))!.text(), 'document');
  } finally { await mf.dispose(); }
});
