// The object store over D1 (blob-store.ts): documents and seals kept as chunked rows, with R2's
// create-only put, since an Insulin app has D1 and assets only. Synthetic bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { applyMigrations } from './helpers/platform.ts';
import { BLOB_CHUNK_BYTES, D1BlobStore } from '../src/app/server/esign/blob-store.ts';

async function store() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  await applyMigrations(db, { gateway: false });
  const chunks = async () => (await db.prepare('SELECT COUNT(*) AS n FROM blob_chunks').first<{ n: number }>())!.n;
  return { mf, db, chunks, artifacts: new D1BlobStore(db, 'artifacts'), mail: new D1BlobStore(db, 'test-mail') };
}

const synthetic = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251);

test('an object larger than a chunk and a batch reads back byte for byte, with its size and type', async () => {
  const { mf, artifacts, chunks } = await store();
  try {
    const bytes = synthetic(BLOB_CHUNK_BYTES * 5 + 123);
    const put = await artifacts.put('envelopes/e/d0.pdf', bytes, { httpMetadata: { contentType: 'application/pdf' } });
    assert.equal(put?.size, bytes.byteLength);
    assert.equal(await chunks(), 6);
    const object = await artifacts.get('envelopes/e/d0.pdf');
    assert.deepEqual(new Uint8Array(await object!.arrayBuffer()), bytes);
    assert.equal(object!.httpMetadata?.contentType, 'application/pdf');
    assert.equal((await artifacts.head('envelopes/e/d0.pdf'))?.size, bytes.byteLength);
    // An empty object and text both round-trip.
    await artifacts.put('empty', new Uint8Array());
    assert.equal((await (await artifacts.get('empty'))!.arrayBuffer()).byteLength, 0);
    await artifacts.put('note.json', JSON.stringify({ synthetic: true }));
    assert.deepEqual(await (await artifacts.get('note.json'))!.json(), { synthetic: true });
    assert.equal(await artifacts.get('missing'), null);
    assert.equal(await artifacts.head('missing'), null);
  } finally { await mf.dispose(); }
});

test('a create-only put never replaces what is there, and of two at once exactly one is kept', async () => {
  const { mf, artifacts, chunks } = await store();
  try {
    assert.ok(await artifacts.put('seal', 'first', { onlyIf: { etagDoesNotMatch: '*' } }));
    assert.equal(await artifacts.put('seal', 'second', { onlyIf: { etagDoesNotMatch: '*' } }), null);
    assert.equal(await (await artifacts.get('seal'))!.text(), 'first');
    const values = ['a'.repeat(BLOB_CHUNK_BYTES + 1), 'b'.repeat(BLOB_CHUNK_BYTES + 1)];
    const results = await Promise.all(values.map((value) => artifacts.put('race', value, { onlyIf: { etagDoesNotMatch: '*' } })));
    assert.equal(results.filter(Boolean).length, 1);
    const kept = await (await artifacts.get('race'))!.text();
    assert.equal(kept, values[results.findIndex(Boolean)]);
    // The loser's chunks are gone: one object of 1 chunk ('seal') and one of 2 ('race').
    assert.equal(await chunks(), 3);
  } finally { await mf.dispose(); }
});

test('an overwrite or a delete leaves no chunks behind, and buckets and prefixes keep apart', async () => {
  const { mf, artifacts, mail, chunks } = await store();
  try {
    await artifacts.put('envelopes/e/a.pdf', synthetic(BLOB_CHUNK_BYTES * 2));
    await artifacts.put('envelopes/e/a.pdf', 'smaller');
    assert.equal(await (await artifacts.get('envelopes/e/a.pdf'))!.text(), 'smaller');
    assert.equal(await chunks(), 1);
    await artifacts.put('envelopes/e/b.pdf', 'b');
    await artifacts.put('envelopes/f/c.pdf', 'c');
    await mail.put('envelopes/e/a.pdf', 'a test mail with the same key');
    assert.deepEqual((await artifacts.list({ prefix: 'envelopes/e/' })).objects.map((o) => o.key), ['envelopes/e/a.pdf', 'envelopes/e/b.pdf']);
    assert.deepEqual((await artifacts.list({ prefix: 'envelopes/', limit: 2 })).truncated, true);
    assert.equal(await (await mail.get('envelopes/e/a.pdf'))!.text(), 'a test mail with the same key');
    await artifacts.delete(['envelopes/e/a.pdf', 'envelopes/e/b.pdf', 'missing']);
    assert.equal(await artifacts.get('envelopes/e/a.pdf'), null);
    assert.ok(await mail.get('envelopes/e/a.pdf'), 'another bucket is untouched');
    assert.equal(await chunks(), 2);
  } finally { await mf.dispose(); }
});
