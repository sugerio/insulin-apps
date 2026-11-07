import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

const module = await import('../src/artifact-store.ts').catch(() => ({ putArtifact: undefined }));

test('local R2 stores an artifact only once and records its SHA-256', async () => {
  assert.equal(typeof module.putArtifact, 'function', 'artifact storage is not implemented');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', r2Buckets: ['ARTIFACTS'] });
  try {
    const bucket = await mf.getR2Bucket('ARTIFACTS');
    const bytes = new TextEncoder().encode('document');
    const result = await module.putArtifact!(bucket, 'tenant-1/artifact-1', bytes);
    assert.equal(result.sha256, '43cc23fa52b87b4cc1d02b5b114154151d6adddb17c9fddc06b027fa99e24008');
    await assert.rejects(() => module.putArtifact!(bucket, 'tenant-1/artifact-1', new TextEncoder().encode('replacement')));
    assert.equal(await (await bucket.get('tenant-1/artifact-1'))!.text(), 'document');
  } finally { await mf.dispose(); }
});

test('putArtifact hashes and writes the same snapshot when caller mutates input', async () => {
  const bytes = new TextEncoder().encode('document');
  let written = new Uint8Array();
  const bucket = { put: async (_key: string, value: Uint8Array) => { written = new Uint8Array(value); return {}; } };
  const pending = module.putArtifact!(bucket, 'synthetic/artifact', bytes);
  bytes.fill(0);
  const result = await pending;
  assert.equal(result.sha256, '43cc23fa52b87b4cc1d02b5b114154151d6adddb17c9fddc06b027fa99e24008');
  assert.equal(new TextDecoder().decode(written), 'document');
});
