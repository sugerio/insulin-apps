import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signKmsEvidence } from '../src/app/server/esign/seal/kms.ts';

const domain = new TextEncoder().encode('esign-worker-evidence-candidate-v1\0');
const shared = (bytes: Uint8Array) => { const value = new Uint8Array(new SharedArrayBuffer(bytes.length)); value.set(bytes); return value; };
const message = (input: Uint8Array) => { const result = new Uint8Array(domain.length + input.length); result.set(domain); result.set(input, domain.length); return result; };

for (const sharedPart of ['input', 'spki', 'signature'] as const) test(`rejects shared-backed ${sharedPart}`, async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const input = new Uint8Array([1]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message(input)));
  let calls = 0;
  const provider = { signDigest: async () => { calls++; return signature; } };
  if (sharedPart === 'input') await assert.rejects(() => signKmsEvidence(shared(input), spki, provider));
  if (sharedPart === 'spki') await assert.rejects(() => signKmsEvidence(input, shared(spki), provider));
  if (sharedPart === 'signature') await assert.rejects(() => signKmsEvidence(input, spki, { signDigest: async () => shared(signature) }));
  assert.equal(calls, 0);
});

for (const sharedPart of ['input', 'spki', 'signature'] as const) test(`rejects forged buffer getter on shared-backed ${sharedPart}`, async () => {
  class ForgedBuffer extends Uint8Array {
    override get buffer(): ArrayBuffer { return new ArrayBuffer(1); }
  }
  const forged = (bytes: Uint8Array) => { const view = new ForgedBuffer(new SharedArrayBuffer(bytes.length)); view.set(bytes); return view; };
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const input = new Uint8Array([1]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message(input)));
  let calls = 0;
  const provider = { signDigest: async () => { calls++; return signature; } };
  if (sharedPart === 'input') await assert.rejects(() => signKmsEvidence(forged(input), spki, provider));
  if (sharedPart === 'spki') await assert.rejects(() => signKmsEvidence(input, forged(spki), provider));
  if (sharedPart === 'signature') await assert.rejects(() => signKmsEvidence(input, spki, { signDigest: async () => forged(signature) }));
  assert.equal(calls, 0);
});

for (const part of ['input', 'spki', 'signature'] as const) test(`uses actual ${part} length and ignores forged typed-array properties`, async () => {
  class Forged extends Uint8Array {
    override get length(): number { return 9999; }
    override get byteOffset(): number { return 9999; }
    override get buffer(): ArrayBuffer { return new ArrayBuffer(1); }
    override [Symbol.iterator](): Uint8Array<ArrayBuffer>[typeof Symbol.iterator] extends () => infer T ? T : never { throw new Error('unexpected iterator'); }
  }
  const forged = (bytes: Uint8Array) => new Forged(bytes);
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const input = new Uint8Array([1]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message(input)));
  const provider = { signDigest: async () => signature };
  if (part === 'input') assert.deepEqual((await signKmsEvidence(forged(input), spki, provider)).signature, signature);
  if (part === 'spki') assert.deepEqual((await signKmsEvidence(input, forged(spki), provider)).signature, signature);
  if (part === 'signature') assert.deepEqual((await signKmsEvidence(input, spki, { signDigest: async () => forged(signature) })).signature, signature);
});

test('rejects signature over zero padding introduced by a forged input length', async () => {
  class Long extends Uint8Array { override get length(): number { return 2; } }
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message(new Uint8Array([1, 0]))));
  await assert.rejects(() => signKmsEvidence(new Long([1]), spki, { signDigest: async () => signature }));
});

test('rejects oversized true lengths even when subclass length is forged', async () => {
  class Short extends Uint8Array { override get length(): number { return 1; } }
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  let calls = 0;
  const provider = { signDigest: async () => { calls++; return new Uint8Array(64); } };
  await assert.rejects(() => signKmsEvidence(new Short(1024 * 1024 + 1), spki, provider));
  await assert.rejects(() => signKmsEvidence(new Uint8Array([1]), new Short(1025), provider));
  assert.equal(calls, 0);
});

test('snapshots ordinary input and key before async work, and enforces limits', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const input = new Uint8Array(1024 * 1024).fill(1);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message(input)));
  const promise = signKmsEvidence(input, spki, { signDigest: async () => signature });
  input.fill(2); spki.fill(0);
  assert.deepEqual((await promise).signature, signature);
  const goodSpki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  let calls = 0;
  const provider = { signDigest: async () => { calls++; return new Uint8Array(63); } };
  await assert.rejects(() => signKmsEvidence(new Uint8Array(1024 * 1024 + 1), goodSpki, provider));
  assert.equal(calls, 0);
  await assert.rejects(() => signKmsEvidence(new Uint8Array([1]), goodSpki, provider));
  assert.equal(calls, 1);
});
