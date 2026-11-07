/** Internal KMS signing primitive, not an opt-in sealing command. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManifest } from './synthetic-seal-manifest.ts';
import type { createSyntheticFixture } from './synthetic-seal-fixture.ts';

type AwsResponse=Record<string,unknown>;
type AwsCall=(args:string[],manifest?:Buffer)=>Promise<AwsResponse>;
export async function signFixtureManifest(fixture:Awaited<ReturnType<typeof createSyntheticFixture>>,aws:AwsCall) {
  const alias='alias/esign-local-test-signing',algorithm='ECDSA_SHA_256';
  const response=await aws(['get-public-key','--key-id',alias]);
  if(response.KeySpec!=='ECC_NIST_P256' || response.KeyUsage!=='SIGN_VERIFY' || !Array.isArray(response.SigningAlgorithms) || !response.SigningAlgorithms.includes(algorithm) || typeof response.KeyId!=='string' || typeof response.PublicKey!=='string') throw new Error('Unexpected key metadata');
  const spki=Buffer.from(response.PublicKey,'base64');
  const publicKey=createPublicKey({key:spki,format:'der',type:'spki'});
  if(publicKey.asymmetricKeyType!=='ec' || publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error('Unexpected key type');
  const keyHash=createHash('sha256').update(spki).digest('hex');
  const manifest=createManifest(fixture,keyHash),bytes=Buffer.from(manifest,'utf8');
  const dir=await mkdtemp(join(tmpdir(),'esign-fixture-sign-'));
  try {
    const path=join(dir,'digest');
    await writeFile(path,createHash('sha256').update(bytes).digest(),{mode:0o600,flag:'wx'});
    const signed=await aws(['sign','--key-id',alias,'--message',`fileb://${path}`,'--message-type','DIGEST','--signing-algorithm',algorithm],bytes);
    if(signed.KeyId!==response.KeyId || signed.SigningAlgorithm!==algorithm || typeof signed.Signature!=='string') throw new Error('Unexpected signature metadata');
    const signature=Buffer.from(signed.Signature,'base64');
    if(!verify('sha256',bytes,publicKey,signature)) throw new Error('Invalid KMS signature');
    return {manifest,spki,keyHash,signature};
  } finally {await rm(dir,{recursive:true,force:true});}
}
