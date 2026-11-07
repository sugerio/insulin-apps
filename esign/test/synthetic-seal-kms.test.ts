import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSyntheticFixture } from '../scripts/synthetic-seal-fixture.ts';
import { signFixtureManifest } from '../scripts/synthetic-seal-kms.ts';

const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const spki=pair.publicKey.export({type:'spki',format:'der'});
const metadata={KeyId:'test-key',KeySpec:'ECC_NIST_P256',KeyUsage:'SIGN_VERIFY',SigningAlgorithms:['ECDSA_SHA_256'],PublicKey:spki.toString('base64')};

test('fixture KMS signing sends a single SHA-256 manifest digest and verifies the returned signature',async()=>{
  const fixture=await createSyntheticFixture();let manifest='';
  const result=await signFixtureManifest(fixture,async(args,bytes)=>{
    if(args[0]==='get-public-key') return metadata;
    assert.equal(args[args.indexOf('--message-type')+1],'DIGEST');
    manifest=bytes!.toString();
    const digest=await readFile(args[args.indexOf('--message')+1].replace('fileb://',''));
    assert.deepEqual(digest,createHash('sha256').update(bytes!).digest());
    return {KeyId:'test-key',SigningAlgorithm:'ECDSA_SHA_256',Signature:sign('sha256',bytes!,pair.privateKey).toString('base64')};
  });
  assert.equal(result.manifest,manifest);
  assert.ok(verify('sha256',Buffer.from(result.manifest),pair.publicKey,result.signature));
  assert.equal(result.keyHash,createHash('sha256').update(spki).digest('hex'));
});

test('fixture KMS signing rejects mismatched key and invalid signature',async()=>{
  const fixture=await createSyntheticFixture();
  for(const response of [{KeyId:'other',SigningAlgorithm:'ECDSA_SHA_256',Signature:'AAAA'},{KeyId:'test-key',SigningAlgorithm:'ECDSA_SHA_256',Signature:'AAAA'}]) {
    await assert.rejects(signFixtureManifest(fixture,async args=>args[0]==='get-public-key'?metadata:response));
  }
  await assert.rejects(signFixtureManifest(fixture,async()=>({...metadata,KeySpec:'RSA_2048'})));
});
