import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { managedEvidenceFromEnv } from '../src/app/server/esign/seal/config.ts';
import { evidenceMessage } from '../src/app/server/esign/seal/kms.ts';
import { DIGICERT_TSA_SIGNERS, DIGICERT_TSA_URL } from '../src/app/server/esign/seal/tsa.ts';
import { LONG_TERM_KEY_ID, TEMPORARY_KEY_ID, syntheticKeyId } from './helpers/synthetic-aws.ts';

const ARN = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000';
const ROLE = 'arn:aws:iam::123456789012:role/esign-dev-signer';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ type: 'spki', format: 'der' });
const env = { KMS_KEY_ARN: ARN, KMS_PUBLIC_KEY: spki.toString('base64'), AWS_ROLE_ARN: ROLE, AWS_ACCESS_KEY_ID: LONG_TERM_KEY_ID, AWS_SECRET_ACCESS_KEY: 'synthetic-secret' };

test('without KMS_KEY_ARN there is no managed seal; an incomplete KMS_TSA setup is refused', async () => {
  assert.equal(await managedEvidenceFromEnv({}), null);
  assert.equal(await managedEvidenceFromEnv({ ...env, KMS_KEY_ARN: '' }), null);
  for (const missing of ['KMS_PUBLIC_KEY', 'AWS_ROLE_ARN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const)
    await assert.rejects(managedEvidenceFromEnv({ ...env, [missing]: '' }), /not fully configured/, missing);
  await assert.rejects(managedEvidenceFromEnv({ ...env, TSA_SIGNER_SPKI_SHA256: 'nope' }), /Invalid SHA-256 list/);
});

test('trust pins this key and DigiCert, plus any listed earlier keys and signers', async () => {
  const earlier = 'b'.repeat(64), rotated = 'c'.repeat(64);
  const config = (await managedEvidenceFromEnv({ ...env, KMS_TRUSTED_KEY_SHA256: earlier, TSA_SIGNER_SPKI_SHA256: rotated }))!;
  assert.deepEqual(config.trust.publicKeySha256, [createHash('sha256').update(spki).digest('hex'), earlier]);
  assert.equal(config.trust.tsa.url, DIGICERT_TSA_URL);
  assert.deepEqual(config.trust.tsa.signerSpkiSha256, [...DIGICERT_TSA_SIGNERS, rotated]);
});

test('signing assumes the role through STS once, then signs with KMS and checks the signature against the pinned key', async () => {
  const input = new TextEncoder().encode('synthetic manifest');
  const calls: string[] = [];
  const fetcher = (async (request: Request) => {
    const url = new URL(request.url);
    calls.push(url.hostname);
    if (url.hostname === 'sts.us-west-2.amazonaws.com') return new Response(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${TEMPORARY_KEY_ID}</AccessKeyId><SecretAccessKey>t</SecretAccessKey><SessionToken>s</SessionToken><Expiration>${new Date(Date.now() + 3600_000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`);
    if (url.hostname === 'kms.us-west-2.amazonaws.com') {
      assert.match(request.headers.get('authorization') ?? '', new RegExp(`Credential=${TEMPORARY_KEY_ID}/`), 'KMS is called with the assumed-role credentials');
      return new Response(JSON.stringify({ KeyId: ARN, SigningAlgorithm: 'ECDSA_SHA_256', Signature: sign('sha256', evidenceMessage(input), privateKey).toString('base64') }), { headers: { 'content-type': 'application/x-amz-json-1.1' } });
    }
    throw new Error(`unexpected ${request.url}`);
  }) as typeof fetch;
  const config = (await managedEvidenceFromEnv({ ...env, AWS_ACCESS_KEY_ID: syntheticKeyId('AKIA', 1) }, fetcher))!;
  for (let i = 0; i < 2; i++) assert.equal((await config.sealer.signEvidence(input)).length, 64);
  assert.deepEqual(calls, ['sts.us-west-2.amazonaws.com', 'kms.us-west-2.amazonaws.com', 'kms.us-west-2.amazonaws.com']);
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' });
  const mismatched = (await managedEvidenceFromEnv({ ...env, AWS_ACCESS_KEY_ID: syntheticKeyId('AKIA', 2), KMS_PUBLIC_KEY: other.toString('base64') }, fetcher))!;
  await assert.rejects(mismatched.sealer.signEvidence(input), 'a signature that does not match the pinned key is refused');
});
