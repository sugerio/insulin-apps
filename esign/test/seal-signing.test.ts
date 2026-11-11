// Signing the evidence with the Worker's seal key (seal/signing.ts): which keys are accepted, the exact message
// signed, and a signature checked against the public key the seal names before it is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceMessage, isSealSigningKey, signEvidence } from '../src/app/server/esign/seal/signing.ts';
import { makeSealKey } from './helpers/seal-key.ts';

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const domain = new TextEncoder().encode('esign-worker-evidence-candidate-v1\0');

test('only a non-extractable P-256 private key that can sign is a seal key', async () => {
  const { privateKey } = await makeSealKey();
  assert.equal(isSealSigningKey(privateKey), true);
  const extractable = await crypto.subtle.generateKey(P256, true, ['sign', 'verify']);
  assert.equal(isSealSigningKey(extractable.privateKey), false, 'a key that could be read back');
  assert.equal(isSealSigningKey(extractable.publicKey), false);
  const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign', 'verify']);
  assert.equal(isSealSigningKey(p384.privateKey), false);
  const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  assert.equal(isSealSigningKey(hmac), false);
  for (const value of [undefined, null, '', 'a PKCS #8 string', {}]) assert.equal(isSealSigningKey(value), false, String(value));
});

test('signs the domain separator and the exact input, checked against the named public key', async () => {
  const { privateKey, spki } = await makeSealKey();
  const input = new TextEncoder().encode('synthetic manifest');
  assert.deepEqual(evidenceMessage(input), Uint8Array.from([...domain, ...input]));
  const pending = signEvidence(input, spki, privateKey);
  input.fill(0);
  const signature = await pending;
  assert.equal(signature.length, 64);
  const publicKey = await crypto.subtle.importKey('spki', spki, P256, false, ['verify']);
  assert.ok(await crypto.subtle.verify(ECDSA_SHA256, publicKey, signature, Uint8Array.from([...domain, ...new TextEncoder().encode('synthetic manifest')])), 'the input as it was when signing began');
});

test('a key that is not the named public key\'s pair, or an empty or oversized input, signs nothing', async () => {
  const { privateKey } = await makeSealKey();
  const other = await makeSealKey();
  await assert.rejects(signEvidence(new Uint8Array([1]), other.spki, privateKey), { message: 'Seal signing failed' });
  await assert.rejects(signEvidence(new Uint8Array(), other.spki, other.privateKey), /Invalid seal signing input/);
  await assert.rejects(signEvidence(new Uint8Array(1024 * 1024 + 1), other.spki, other.privateKey), /Invalid seal signing input/);
});
