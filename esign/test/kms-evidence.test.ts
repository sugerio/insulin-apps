import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signKmsEvidence } from '../src/app/server/esign/seal/kms.ts';

const domain = new TextEncoder().encode('esign-worker-evidence-candidate-v1\0');
const join = (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]);

test('binds a domain and exact input to a locally verified pinned P-256 key', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const input = new TextEncoder().encode('synthetic manifest');
  const message = join(domain, input);
  const expectedDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message));
  const provider = { signDigest: async (digest: Uint8Array) => { assert.deepEqual(digest, expectedDigest); return signature; } };
  const result = await signKmsEvidence(input, spki, provider);
  assert.deepEqual(result.signature, signature);
  await assert.rejects(() => signKmsEvidence(new Uint8Array([1]), spki, provider));
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const otherSpki = new Uint8Array(await crypto.subtle.exportKey('spki', other.publicKey));
  await assert.rejects(() => signKmsEvidence(input, otherSpki, { signDigest: async () => signature }));
  await assert.rejects(() => signKmsEvidence(input, spki, { signDigest: async () => new Uint8Array(64) }));
  await assert.rejects(() => signKmsEvidence(input, spki, { signDigest: async () => { throw new Error('secret'); } }), { message: 'KMS signing failed' });
});

test('rejects invalid inputs without calling provider', async () => {
  let calls = 0;
  const provider = { signDigest: async () => { calls++; return new Uint8Array(64); } };
  await assert.rejects(() => signKmsEvidence(new Uint8Array(), new Uint8Array(), provider));
  assert.equal(calls, 0);
});
