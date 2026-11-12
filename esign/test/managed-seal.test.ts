// The managed seal: an ECDSA P-256 signature with the seal key over the evidence manifest, then an
// RFC 3161 timestamp over that signature, verified against the keys trusted at that time. OpenSSL plays the TSA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealManifest, verifyManagedSeal, type Sealer, type SealTrust } from '../src/app/server/esign/seal/managed.ts';
import { signEvidence } from '../src/app/server/esign/seal/signing.ts';
import { makeSealKey } from './helpers/seal-key.ts';
import { startOpensslTsa } from './helpers/openssl-tsa.ts';

const TSA_URL = 'http://tsa.example.test/';
const MANIFEST = JSON.stringify({ format: 'esign-local-test-manifest-v1', envelopeId: 'e1', finalSha256: 'a'.repeat(64) });

async function setup({ withAccuracy = true } = {}) {
  const tsa = await startOpensslTsa({ withAccuracy });
  const key = await makeSealKey();
  const tsaCalls: Request[] = [];
  const fetcher = (async (request: Request) => {
    tsaCalls.push(request);
    if (request.url !== TSA_URL) throw new Error(`unexpected ${request.url}`);
    return new Response(await tsa.reply(new Uint8Array(await request.arrayBuffer())), { headers: { 'content-type': 'application/timestamp-reply' } });
  }) as typeof fetch;
  const trustTsa = { url: TSA_URL, roots: tsa.roots, policies: [tsa.policy], issuerSpkiSha256: [tsa.issuerSpkiSha256], missingAccuracyMs: 1000 };
  const sealer: Sealer = {
    keyId: key.entry.id,
    publicKeySpki: key.spki,
    signEvidence: input => signEvidence(input, key.spki, key.privateKey),
    tsa: trustTsa, fetch: fetcher,
  };
  const trust: SealTrust = { keys: [key.entry], tsa: trustTsa };
  return { tsa, sealer, trust, tsaCalls, key };
}

test('seals a manifest with a signature and a timestamp over it, and verifies it later', async () => {
  const { tsa, sealer, trust, tsaCalls } = await setup();
  try {
    const seal = await sealManifest(MANIFEST, sealer);
    assert.equal(seal.format, 'esign-managed-seal-v2');
    assert.equal(seal.manifest, MANIFEST);
    assert.equal(seal.signature.keyId, sealer.keyId);
    assert.equal(seal.signature.publicKey, trust.keys[0].spki);
    assert.equal(tsaCalls.length, 1);
    assert.equal(tsaCalls[0].headers.get('content-type'), 'application/timestamp-query');
    assert.ok(Math.abs(seal.timestamp.time - Date.now()) < 60_000);
    // Stored as JSON and read back.
    const stored = JSON.parse(JSON.stringify(seal));
    assert.deepEqual(await verifyManagedSeal(stored, MANIFEST, trust), { keyId: sealer.keyId, timestampTime: seal.timestamp.time, tsaUrl: TSA_URL });
  } finally { await tsa.dispose(); }
});

test('a stored seal is rejected when the records, the key, the signature or the timestamp do not hold', async () => {
  const { tsa, sealer, trust, key } = await setup();
  try {
    const seal = await sealManifest(MANIFEST, sealer);
    const at = (offset: number) => new Date(seal.timestamp.time + offset).toISOString();
    const flip = (b64: string) => { const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); b[b.length - 5] ^= 1; return btoa(String.fromCharCode(...b)); };
    const cases: [string, unknown, string, SealTrust][] = [
      ['records changed since sealing', seal, MANIFEST.replace('e1', 'e2'), trust],
      ['manifest swapped inside the seal', { ...seal, manifest: MANIFEST.replace('e1', 'e2') }, MANIFEST.replace('e1', 'e2'), trust],
      ['key not trusted', seal, MANIFEST, { ...trust, keys: [] }],
      ['key listed under another fingerprint', seal, MANIFEST, { ...trust, keys: [{ ...key.entry, id: '0'.repeat(64) }] }],
      ['key retired before the timestamp', seal, MANIFEST, { ...trust, keys: [{ ...key.entry, from: at(-120_000), until: at(-60_000) }] }],
      ['key in use only after the timestamp', seal, MANIFEST, { ...trust, keys: [{ ...key.entry, from: at(60_000) }] }],
      ['seal names another key', { ...seal, signature: { ...seal.signature, keyId: '0'.repeat(64) } }, MANIFEST, trust],
      ['signature altered', { ...seal, signature: { ...seal.signature, value: flip(seal.signature.value) } }, MANIFEST, trust],
      ['timestamp altered', { ...seal, timestamp: { ...seal.timestamp, response: flip(seal.timestamp.response) } }, MANIFEST, trust],
      ['timestamp for another nonce', { ...seal, timestamp: { ...seal.timestamp, nonce: '01' + '0'.repeat(30) } }, MANIFEST, trust],
      ['timestamp from another TSA', seal, MANIFEST, { ...trust, tsa: { ...trust.tsa, url: 'http://other.example.test/' } }],
      ['timestamp issuer not pinned', seal, MANIFEST, { ...trust, tsa: { ...trust.tsa, issuerSpkiSha256: ['0'.repeat(64)] } }],
    ];
    for (const [name, candidate, manifest, t] of cases) await assert.rejects(verifyManagedSeal(candidate as never, manifest, t), undefined, name);
  } finally { await tsa.dispose(); }
});

test('sealing stops when the key answers with a signature that does not verify', async () => {
  const { tsa, sealer, tsaCalls } = await setup();
  try {
    const other = await makeSealKey();
    const wrongKey = { ...sealer, signEvidence: (input: Uint8Array) => signEvidence(input, other.spki, other.privateKey) };
    await assert.rejects(sealManifest(MANIFEST, wrongKey), /Seal signature rejected/);
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
