// The managed seal: a KMS-style ECDSA P-256 signature over the evidence manifest, then an RFC
// 3161 timestamp over that signature. Here a local key stands in for KMS and OpenSSL for the TSA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealManifest, verifyManagedSeal, type Sealer, type SealTrust } from '../src/app/server/esign/seal/managed.ts';
import { evidenceMessage } from '../src/app/server/esign/seal/kms.ts';
import { startOpensslTsa } from './helpers/openssl-tsa.ts';

const TSA_URL = 'http://tsa.example.test/';
const MANIFEST = JSON.stringify({ format: 'esign-local-test-manifest-v1', envelopeId: 'e1', finalSha256: 'a'.repeat(64) });
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

async function setup({ withAccuracy = true } = {}) {
  const tsa = await startOpensslTsa({ withAccuracy });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const tsaCalls: Request[] = [];
  const fetcher = (async (request: Request) => {
    tsaCalls.push(request);
    if (request.url !== TSA_URL) throw new Error(`unexpected ${request.url}`);
    return new Response(await tsa.reply(new Uint8Array(await request.arrayBuffer())), { headers: { 'content-type': 'application/timestamp-reply' } });
  }) as typeof fetch;
  const trustTsa = { url: TSA_URL, roots: tsa.roots, policies: [tsa.policy], signerSpkiSha256: [tsa.signerSpkiSha256], missingAccuracyMs: 1000 };
  const sealer: Sealer = {
    keyArn: 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000',
    publicKeySpki: spki,
    signEvidence: async input => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Uint8Array.from(evidenceMessage(input)))),
    tsa: trustTsa, fetch: fetcher,
  };
  const trust: SealTrust = { publicKeySha256: [hex(await crypto.subtle.digest('SHA-256', spki))], tsa: trustTsa };
  return { tsa, sealer, trust, tsaCalls };
}

test('seals a manifest with a signature and a timestamp over it, and verifies it later', async () => {
  const { tsa, sealer, trust, tsaCalls } = await setup();
  try {
    const seal = await sealManifest(MANIFEST, sealer);
    assert.equal(seal.format, 'esign-managed-seal-v1');
    assert.equal(seal.manifest, MANIFEST);
    assert.equal(seal.signature.keyArn, sealer.keyArn);
    assert.equal(seal.signature.publicKeySha256, trust.publicKeySha256[0]);
    assert.equal(tsaCalls.length, 1);
    assert.equal(tsaCalls[0].headers.get('content-type'), 'application/timestamp-query');
    assert.ok(Math.abs(seal.timestamp.time - Date.now()) < 60_000);
    // Stored as JSON and read back.
    const stored = JSON.parse(JSON.stringify(seal));
    assert.deepEqual(await verifyManagedSeal(stored, MANIFEST, trust), { keyArn: sealer.keyArn, publicKeySha256: trust.publicKeySha256[0], timestampTime: seal.timestamp.time, tsaUrl: TSA_URL });
  } finally { await tsa.dispose(); }
});

test('a stored seal is rejected when the records, the key, the signature or the timestamp do not hold', async () => {
  const { tsa, sealer, trust } = await setup();
  try {
    const seal = await sealManifest(MANIFEST, sealer);
    const flip = (b64: string) => { const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); b[b.length - 5] ^= 1; return btoa(String.fromCharCode(...b)); };
    const cases: [string, unknown, string, SealTrust][] = [
      ['records changed since sealing', seal, MANIFEST.replace('e1', 'e2'), trust],
      ['manifest swapped inside the seal', { ...seal, manifest: MANIFEST.replace('e1', 'e2') }, MANIFEST.replace('e1', 'e2'), trust],
      ['key not trusted', seal, MANIFEST, { ...trust, publicKeySha256: ['0'.repeat(64)] }],
      ['signature altered', { ...seal, signature: { ...seal.signature, value: flip(seal.signature.value) } }, MANIFEST, trust],
      ['timestamp altered', { ...seal, timestamp: { ...seal.timestamp, response: flip(seal.timestamp.response) } }, MANIFEST, trust],
      ['timestamp for another nonce', { ...seal, timestamp: { ...seal.timestamp, nonce: '01' + '0'.repeat(30) } }, MANIFEST, trust],
      ['timestamp from another TSA', seal, MANIFEST, { ...trust, tsa: { ...trust.tsa, url: 'http://other.example.test/' } }],
      ['timestamp signer not pinned', seal, MANIFEST, { ...trust, tsa: { ...trust.tsa, signerSpkiSha256: ['0'.repeat(64)] } }],
    ];
    for (const [name, candidate, manifest, t] of cases) await assert.rejects(verifyManagedSeal(candidate as never, manifest, t), undefined, name);
  } finally { await tsa.dispose(); }
});

test('sealing stops when the key answers with a signature that does not verify', async () => {
  const { tsa, sealer, tsaCalls } = await setup();
  try {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const wrongKey = { ...sealer, signEvidence: async (input: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, other.privateKey, Uint8Array.from(evidenceMessage(input)))) };
    await assert.rejects(sealManifest(MANIFEST, wrongKey), /KMS signature rejected/);
    assert.equal(tsaCalls.length, 0, 'no timestamp is requested for a bad signature');
  } finally { await tsa.dispose(); }
});

test('tokens without an accuracy field, like DigiCert\'s, are sealed and verified with the assumed uncertainty', async () => {
  const { tsa, sealer, trust } = await setup({ withAccuracy: false });
  try {
    const seal = await sealManifest(MANIFEST, sealer);
    assert.equal((await verifyManagedSeal(seal, MANIFEST, trust)).timestampTime, seal.timestamp.time);
  } finally { await tsa.dispose(); }
});
