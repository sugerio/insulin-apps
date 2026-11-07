import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadFixedSyntheticFixture} from '../scripts/synthetic-seal-fixed.ts';
import {createManifest,createUploadedManifest} from '../scripts/synthetic-seal-manifest.ts';
import {fixtureTimestampNonce,makeTimestampRequest} from '../scripts/synthetic-seal-tsa.ts';
import {verifySyntheticSeal,verifyUploadedSeal} from '../scripts/synthetic-seal-verify.ts';
const run=(args:string[],cwd:string)=>execFileSync('openssl',args,{cwd,stdio:'pipe'});
test('independent verifier validates complete fixture and rejects altered evidence and wrong trust',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'esign-verify-test-'));
 try {
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],dir);
  run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Synthetic TSA'],dir);
  await writeFile(join(dir,'ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
  run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','ext','-out','tsa.pem'],dir);
  await writeFile(join(dir,'serial'),'01\n');await writeFile(join(dir,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\n');
  const fixture=await loadFixedSyntheticFixture(),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({type:'spki',format:'der'}),fingerprint=createHash('sha256').update(spki).digest('hex');
  const manifest=Buffer.from(createManifest(fixture,fingerprint)),signature=sign('sha256',manifest,pair.privateKey),nonce=fixtureTimestampNonce(signature),request=makeTimestampRequest(signature,nonce);
  const data:Record<string,Uint8Array>={manifest,spki,signature,nonce,request};
  fixture.artifacts.forEach((a,i)=>{data[`d${i}`]=a;});
  for(const [name,bytes] of Object.entries(data)) await writeFile(join(dir,name),bytes);
  run(['ts','-reply','-config','tsa.cnf','-queryfile','request','-out','response'],dir);
  const roots=await readFile(join(dir,'root.pem'));
  await verifySyntheticSeal(dir,fingerprint,roots);
  for(const name of ['d0','d1','d2','d3','manifest','spki','signature','nonce','request','response']) {
   const original=await readFile(join(dir,name));const altered=Buffer.from(original);altered[Math.floor(altered.length/2)]^=1;await writeFile(join(dir,name),altered);
   await assert.rejects(verifySyntheticSeal(dir,fingerprint,roots),undefined,`${name} tamper`);
   await writeFile(join(dir,name),original);
  }
  await assert.rejects(verifySyntheticSeal(dir,'f'.repeat(64),roots));
  await assert.rejects(verifySyntheticSeal(dir,fingerprint,Buffer.from('invalid root')));
  const uploaded=Buffer.from(createUploadedManifest(fixture,fingerprint)),uploadedSignature=sign('sha256',uploaded,pair.privateKey),uploadedNonce=fixtureTimestampNonce(uploadedSignature);
  await writeFile(join(dir,'manifest'),uploaded);await writeFile(join(dir,'signature'),uploadedSignature);
  await writeFile(join(dir,'nonce'),uploadedNonce);await writeFile(join(dir,'request'),makeTimestampRequest(uploadedSignature,uploadedNonce));
  run(['ts','-reply','-config','tsa.cnf','-queryfile','request','-out','response'],dir);
  const result=await verifyUploadedSeal(dir,fingerprint,roots);
  assert.equal(result.envelopeId,fixture.envelopeId);
  assert.equal(result.syntheticProvenance,'not established');
  await assert.rejects(verifySyntheticSeal(dir,fingerprint,roots));
  const altered=Buffer.from(fixture.artifacts[3]);altered[0]^=1;await writeFile(join(dir,'d3'),altered);
  await assert.rejects(verifyUploadedSeal(dir,fingerprint,roots));
 } finally {await rm(dir,{recursive:true,force:true});}
});
