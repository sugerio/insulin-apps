/** Independent offline verification; neither AWS nor the TSA is contacted. */
import { createHash,createPublicKey,verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFixedSyntheticFixture } from './synthetic-seal-fixed.ts';
import { createManifest,verifyManifest,verifyUploadedManifest } from './synthetic-seal-manifest.ts';
import { fixtureTimestampNonce,verifyTimestampResponse } from './synthetic-seal-tsa.ts';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function verifySeal(dir:string,expectedKeyHash:string,roots:Buffer,mode:'fixed'|'dynamic'|'uploaded') {
  if(!/^[0-9a-f]{64}$/.test(expectedKeyHash) || !roots.length) throw new Error('Expected key fingerprint and roots required');
  async function read(name:string) {
    const file=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const stat=await file.stat();if(!stat.isFile() || stat.size>(mode==='uploaded' && /^d[0-3]$/.test(name) ? 8*1024*1024 : 1024*1024)) throw new Error('Invalid evidence file');return await file.readFile();}
    finally {await file.close();}
  }
  const fixture=mode==='fixed' ? await loadFixedSyntheticFixture() : null;
  const artifacts=await Promise.all([0,1,2,3].map(i=>read(`d${i}`)));
  if(fixture) for(let i=0;i<4;i++) if(!artifacts[i].equals(fixture.artifacts[i])) throw new Error('Fixture artifact mismatch');
  const [manifest,spki,signature,nonce,request,response]=await Promise.all(['manifest','spki','signature','nonce','request','response'].map(read));
  if(hash(spki)!==expectedKeyHash) throw new Error('Unexpected public key');
  const key=createPublicKey({key:spki,format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error('Unexpected key type');
  if(fixture && !manifest.equals(Buffer.from(createManifest(fixture,expectedKeyHash)))) throw new Error('Unexpected manifest');
  if(mode==='uploaded') verifyUploadedManifest(manifest.toString('utf8'),artifacts,expectedKeyHash);
  else verifyManifest(manifest.toString('utf8'),artifacts,expectedKeyHash);
  if(!verify('sha256',manifest,key,signature)) throw new Error('Invalid KMS signature');
  if(!nonce.equals(fixtureTimestampNonce(signature))) throw new Error('Invalid fixture nonce');
  await verifyTimestampResponse(signature,nonce,request,response,roots);
  const {stdout}=await promisify(execFile)('openssl',['version'],{timeout:15000,maxBuffer:4096});
  return {envelopeId:(JSON.parse(manifest.toString('utf8')) as {envelopeId:string}).envelopeId,verifiedAt:new Date().toISOString(),opensslVersion:stdout.trim(),keyHash:expectedKeyHash,trustBundleSha256:hash(roots),revocation:'not checked',license:'not verified',...(mode==='uploaded' ? {syntheticProvenance:'not established' as const} : {})};
}

/** Verifies cryptographic evidence, not the synthetic provenance of an arbitrary envelope. */
export async function verifyDynamicSyntheticSeal(dir:string,expectedKeyHash:string,roots:Buffer) {
  return verifySeal(dir,expectedKeyHash,roots,'dynamic');
}

export async function verifySyntheticSeal(dir:string,expectedKeyHash:string,roots:Buffer) {
  return verifySeal(dir,expectedKeyHash,roots,'fixed');
}

/** Uploaded evidence does not establish the provenance or nature of the PDF. */
export async function verifyUploadedSeal(dir:string,expectedKeyHash:string,roots:Buffer) {
  return verifySeal(dir,expectedKeyHash,roots,'uploaded');
}
