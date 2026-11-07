import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runSyntheticKmsCheck, SYNTHETIC_MESSAGE } from '../scripts/kms-synthetic.ts';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const metadata = { KeyId: 'test-key', KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const signature = sign('sha256', SYNTHETIC_MESSAGE, privateKey).toString('base64');

test('synthetic KMS check verifies locally and binds both responses to the same key', async () => {
  const calls: string[][] = [];
  await runSyntheticKmsCheck(async args => {
    calls.push(args);
    if (args[0] === 'get-public-key') return metadata;
    const digestPath = args[args.indexOf('--message') + 1].replace(/^fileb:\/\//, '');
    assert.deepEqual(await readFile(digestPath), createHash('sha256').update(SYNTHETIC_MESSAGE).digest());
    return { KeyId: 'test-key', SigningAlgorithm: 'ECDSA_SHA_256', Signature: signature };
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('DIGEST'));
  assert.ok(calls.flat().includes('alias/esign-local-test-signing'));
});

test('synthetic KMS check rejects bad signatures and mismatched keys', async () => {
  for (const response of [{ KeyId: 'test-key', SigningAlgorithm: 'ECDSA_SHA_256', Signature: Buffer.from('bad').toString('base64') }, { KeyId: 'other', SigningAlgorithm: 'ECDSA_SHA_256', Signature: signature }]) {
    await assert.rejects(runSyntheticKmsCheck(async args => args[0] === 'get-public-key' ? metadata : response));
  }
});

test('synthetic KMS check rejects incompatible key metadata before signing', async () => {
  let count = 0;
  await assert.rejects(runSyntheticKmsCheck(async () => { count++; return { ...metadata, KeySpec: 'RSA_2048' }; }));
  assert.equal(count, 1);
});
