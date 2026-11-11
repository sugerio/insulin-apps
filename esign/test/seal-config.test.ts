// Which seal completes envelopes (seal/config.ts): the managed seal with the Worker's seal key and the keys the code
// trusts, nothing without the binding, and an error, not a fallback, for a binding or key list that can't seal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managedEvidenceFromEnv, sealTrustFromEnv } from '../src/app/server/esign/seal/config.ts';
import { DIGICERT_TSA_SIGNERS, DIGICERT_TSA_URL } from '../src/app/server/esign/seal/tsa.ts';
import { makeSealKey } from './helpers/seal-key.ts';

const seal = await makeSealKey();
const env = { SEAL_KEY: seal.privateKey, SEAL_KEYS: [seal.entry] };

test('without the seal key binding there is no managed seal', async () => {
  assert.equal(await managedEvidenceFromEnv({}), null);
  assert.equal(await managedEvidenceFromEnv({ SEAL_KEYS: [seal.entry] }), null);
});

test('a binding that is not a usable seal key, or no current key in keys.ts, is refused', async () => {
  const extractable = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).privateKey;
  for (const SEAL_KEY of ['a PKCS #8 string', extractable, {}])
    await assert.rejects(managedEvidenceFromEnv({ ...env, SEAL_KEY }), /ESIGN_SEAL_KEY is not a non-extractable ECDSA P-256 signing key/);
  await assert.rejects(managedEvidenceFromEnv({ ...env, SEAL_KEYS: [] }), /No current seal key/);
  await assert.rejects(managedEvidenceFromEnv({ ...env, SEAL_KEYS: [{ ...seal.entry, until: new Date().toISOString() }] }), /No current seal key/);
  await assert.rejects(managedEvidenceFromEnv({ ...env, TSA_SIGNER_SPKI_SHA256: 'nope' }), /Invalid SHA-256 list/);
});

test('the sealer signs with the current key; trust is keys.ts and DigiCert, plus any extra signer pins', async () => {
  const rotated = 'c'.repeat(64);
  const retired = await makeSealKey({ from: Date.now() - 7_200_000, until: Date.now() - 3_600_000 });
  const keys = [retired.entry, seal.entry];
  const config = (await managedEvidenceFromEnv({ ...env, SEAL_KEYS: keys, TSA_SIGNER_SPKI_SHA256: rotated }))!;
  assert.equal(config.sealer.keyId, seal.entry.id);
  assert.deepEqual(config.sealer.publicKeySpki, seal.spki);
  const input = new TextEncoder().encode('synthetic manifest');
  assert.equal((await config.sealer.signEvidence(input)).length, 64);
  assert.deepEqual(config.trust.keys, keys);
  assert.equal(config.trust.tsa.url, DIGICERT_TSA_URL);
  assert.deepEqual(config.trust.tsa.signerSpkiSha256, [...DIGICERT_TSA_SIGNERS, rotated]);
  assert.deepEqual(sealTrustFromEnv({ SEAL_KEYS: keys, TSA_SIGNER_SPKI_SHA256: rotated }), config.trust, 'verifying needs no private key');
  // The binding holds another key than keys.ts names: nothing is signed.
  const other = await makeSealKey();
  const mismatched = (await managedEvidenceFromEnv({ ...env, SEAL_KEY: other.privateKey }))!;
  await assert.rejects(mismatched.sealer.signEvidence(input), { message: 'Seal signing failed' });
});
