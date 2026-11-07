import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { putArtifact } from '../src/artifact-store.ts';

test('ambiguous local write is inspectable on retry but conditional creation is not retention', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['ARTIFACTS'] });
  try {
    const bucket = await mf.getR2Bucket('ARTIFACTS');
    const bytes = new TextEncoder().encode('synthetic evidence');
    const ambiguous = { put: async (...args: Parameters<typeof bucket.put>) => { await bucket.put(...args); throw new Error('response lost'); } };
    await assert.rejects(() => putArtifact(ambiguous, 'evidence/1', bytes), /response lost/);
    await assert.rejects(() => putArtifact(bucket, 'evidence/1', bytes), /already exists/);
    assert.deepEqual(new Uint8Array(await (await bucket.get('evidence/1'))!.arrayBuffer()), bytes);
    await bucket.delete('evidence/1');
    assert.equal(await bucket.get('evidence/1'), null);
  } finally { await mf.dispose(); }
});
