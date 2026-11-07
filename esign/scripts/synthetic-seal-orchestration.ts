/** Fixture-only local evidence orchestration. Never consumes an envelope or caller-supplied artifact. */
import { createHash,createPublicKey,verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat,mkdtemp,open,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,dirname,join } from 'node:path';
import { loadFixedSyntheticFixture } from './synthetic-seal-fixed.ts';
import { createManifest,createUploadedManifest } from './synthetic-seal-manifest.ts';
import { publishStep } from './synthetic-seal-storage.ts';
import { fixtureTimestampNonce,makeTimestampRequest,verifyTimestampResponse } from './synthetic-seal-tsa.ts';
import { verifyDynamicSyntheticSeal,verifySyntheticSeal,verifyUploadedSeal } from './synthetic-seal-verify.ts';
import type { createSyntheticFixture } from './synthetic-seal-fixture.ts';

type Response=Record<string,unknown>;
export type Dependencies={roots:Buffer;aws:(args:string[],message?:Buffer)=>Promise<Response>;timestamp:(request:Buffer)=>Promise<Buffer>};
const marker=Buffer.from('esign fixed synthetic fixture only v1\n');
const dynamicMarker=Buffer.from('esign isolated synthetic envelope v1\n');
const uploadedMarker=Buffer.from('esign isolated uploaded envelope v1\n');
type Fixture=Awaited<ReturnType<typeof createSyntheticFixture>>;
const exact=(expected:Uint8Array)=>(actual:Buffer)=>{if(!actual.equals(expected)) throw new Error('Existing evidence conflicts');};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

export async function createSyntheticWorkspace():Promise<string> {
 const dir=await mkdtemp(join(await realpath(tmpdir()),'esign-fixed-synthetic-'));
 await publishStep(dir,'marker',marker,exact(marker));
 return dir;
}
async function checkWorkspace(dir:string,mode:'fixed'|'dynamic'|'uploaded'='fixed') {
 const parent=await realpath(tmpdir());
 const pattern=mode==='dynamic' ? /^esign-dynamic-synthetic-[a-zA-Z0-9]+$/ : mode==='uploaded' ? /^esign-uploaded-envelope-[a-zA-Z0-9]+$/ : /^esign-fixed-synthetic-[a-zA-Z0-9]+$/;
 if(dirname(dir)!==parent || !pattern.test(basename(dir))) throw new Error('Invalid workspace location');
 const stat=await lstat(dir);
 if(!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || (process.getuid && stat.uid!==process.getuid())) throw new Error('Invalid workspace permissions');
 const file=await open(join(dir,'marker'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const b=await file.readFile();exact(mode==='dynamic' ? dynamicMarker : mode==='uploaded' ? uploadedMarker : marker)(b);} finally {await file.close();}
}
async function readOptional(dir:string,name:string) {
 try {
  const file=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await file.stat();if(!stat.isFile() || stat.size>(name==='fixture' ? 48*1024*1024 : /^d[0-3]$/.test(name) ? 8*1024*1024 : 1024*1024)) throw new Error('Invalid evidence step');return await file.readFile();} finally {await file.close();}
 } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}
}
function serializeFixture(fixture:Fixture) {
 return Buffer.from(JSON.stringify({envelopeId:fixture.envelopeId,source:fixture.source,signatures:fixture.signatures,artifacts:fixture.artifacts.map((a:Uint8Array)=>Buffer.from(a).toString('base64'))}));
}

/** Internal trusted boundary: caller must obtain fixture exclusively from an isolated generated instance. */
async function createDynamicWorkspace(fixture:Fixture,uploaded:boolean) {
 validateFixture(fixture,uploaded);
 const dir=await mkdtemp(join(await realpath(tmpdir()),uploaded ? 'esign-uploaded-envelope-' : 'esign-dynamic-synthetic-'));
 const selectedMarker=uploaded ? uploadedMarker : dynamicMarker;
 await publishStep(dir,'marker',selectedMarker,exact(selectedMarker));
 const snapshot=serializeFixture(fixture);
 await publishStep(dir,'fixture',snapshot,exact(snapshot));
 return dir;
}

function validateFixture(fixture:Fixture,uploaded:boolean) {
 if(uploaded && fixture.artifacts.some((a:Uint8Array)=>a.length>8*1024*1024))throw new Error('Uploaded evidence artifact too large');
 (uploaded ? createUploadedManifest : createManifest)(fixture,'0'.repeat(64));
}
export async function bindDynamicSyntheticWorkspace(instanceDir:string,fixture:Fixture) {return bindWorkspace(instanceDir,fixture,false);}
export async function bindUploadedWorkspace(instanceDir:string,fixture:Fixture) {return bindWorkspace(instanceDir,fixture,true);}
async function bindWorkspace(instanceDir:string,fixture:Fixture,uploaded:boolean) {
 const expected=serializeFixture(fixture);
 const validate=async(bytes:Buffer)=>{
  const dir=bytes.toString('utf8');
  await checkWorkspace(dir,uploaded ? 'uploaded' : 'dynamic');
  const actual=await readOptional(dir,'fixture');
  if(!actual || !actual.equals(expected))throw new Error('Existing evidence conflicts');
 };
 const existing=await readOptional(instanceDir,'seal-workspace');
 if(existing) {await validate(existing);return (await publishStep(instanceDir,'seal-workspace',existing,validate)).toString('utf8');}
 const candidate=await createDynamicWorkspace(fixture,uploaded);
 const winner=(await publishStep(instanceDir,'seal-workspace',Buffer.from(candidate),validate)).toString('utf8');
 if(winner!==candidate)await rm(candidate,{recursive:true,force:true});
 return winner;
}

export async function sealDynamicSyntheticWorkspace(dir:string,expected:Fixture,deps:Dependencies) {return sealDynamicWorkspace(dir,expected,deps,false);}
export async function sealUploadedWorkspace(dir:string,expected:Fixture,deps:Dependencies) {return sealDynamicWorkspace(dir,expected,deps,true);}
const uploadedCompleteMarker=Buffer.from('verified uploaded local test seal v1\n');
export async function markUploadedComplete(dir:string) {
 await publishStep(dir,'verified-complete',uploadedCompleteMarker,exact(uploadedCompleteMarker));
}
/** If a workspace exists, require its snapshot and any published artifacts to agree. */
export async function checkExistingUploadedWorkspace(instanceDir:string,fixture:Fixture) {
 const pointer=await readOptional(instanceDir,'seal-workspace');
 if(!pointer)return;
 const workspace=pointer.toString('utf8');await checkWorkspace(workspace,'uploaded');
 const snapshot=await readOptional(workspace,'fixture');if(!snapshot)throw new Error('Missing fixture');
 if(!snapshot.equals(serializeFixture(fixture)))throw new Error('Fixture mismatch');
 const complete=await readOptional(workspace,'verified-complete');
 if(complete)exact(uploadedCompleteMarker)(complete);
 for(let i=0;i<4;i++) {
  const published=await readOptional(workspace,`d${i}`);
  if((complete && !published) || (published && !published.equals(Buffer.from(fixture.artifacts[i]))))throw new Error('Artifact mismatch');
 }
}

export async function uploadedSealStatus(instanceDir:string,fixture:()=>Promise<Fixture>,roots:Buffer) {
 const pointer=await readOptional(instanceDir,'seal-workspace');
 if(!pointer)return {sealStatus:'NOT_SEALED' as const};
 const workspace=pointer.toString('utf8');
 await checkWorkspace(workspace,'uploaded');
 const marker=await readOptional(workspace,'verified-complete');
 if(!marker)throw new Error('Incomplete upload evidence');
 exact(uploadedCompleteMarker)(marker);
 const current=await fixture(),snapshot=await readOptional(workspace,'fixture');
 if(!snapshot || !snapshot.equals(serializeFixture(current)))throw new Error('Existing evidence conflicts');
 const spki=await readOptional(workspace,'spki');if(!spki)throw new Error('Missing public key');
 await verifyUploadedSeal(workspace,sha(spki),roots);
 return {sealStatus:'SEALED_LOCAL_TEST' as const,workspace};
}

async function sealDynamicWorkspace(dir:string,expected:Fixture,deps:Dependencies,uploaded:boolean) {
 await checkWorkspace(dir,uploaded ? 'uploaded' : 'dynamic');
 const snapshot=await readOptional(dir,'fixture');if(!snapshot)throw new Error('Synthetic fixture missing');
 if(!snapshot.equals(serializeFixture(expected)))throw new Error('Existing evidence conflicts');
 const parsed=JSON.parse(snapshot.toString('utf8')) as Omit<Fixture,'artifacts'> & {artifacts:string[]};
 if(!Array.isArray(parsed.artifacts) || parsed.artifacts.some(a=>typeof a!=='string')) throw new Error('Invalid synthetic fixture');
 const fixture={...parsed,artifacts:parsed.artifacts.map(a=>new Uint8Array(Buffer.from(a,'base64')))};
 if(!snapshot.equals(serializeFixture(fixture))) throw new Error('Invalid synthetic fixture');
 validateFixture(fixture,uploaded);
 return sealWorkspace(dir,deps,fixture,uploaded ? 'uploaded' : 'dynamic');
}

export async function sealSyntheticWorkspace(dir:string,deps:Dependencies) {
 await checkWorkspace(dir);
 return sealWorkspace(dir,deps,await loadFixedSyntheticFixture(),'fixed');
}

async function sealWorkspace(dir:string,deps:Dependencies,fixture:Fixture,mode:'fixed'|'dynamic'|'uploaded') {
 for(let i=0;i<4;i++) await publishStep(dir,`d${i}`,Buffer.from(fixture.artifacts[i]),exact(fixture.artifacts[i]));
 const metadata=await deps.aws(['get-public-key','--key-id','alias/esign-local-test-signing']);
 if(metadata.KeySpec!=='ECC_NIST_P256' || metadata.KeyUsage!=='SIGN_VERIFY' || !Array.isArray(metadata.SigningAlgorithms) || !metadata.SigningAlgorithms.includes('ECDSA_SHA_256') || typeof metadata.KeyId!=='string' || typeof metadata.PublicKey!=='string') throw new Error('Unexpected KMS metadata');
 const spki=Buffer.from(metadata.PublicKey,'base64'),key=createPublicKey({key:spki,format:'der',type:'spki'});
 if(key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error('Unexpected KMS public key');
 await publishStep(dir,'spki',spki,exact(spki));
 const keyHash=sha(spki),manifest=Buffer.from((mode==='uploaded' ? createUploadedManifest : createManifest)(fixture,keyHash));
 await publishStep(dir,'manifest',manifest,exact(manifest));
 const checkSignature=(s:Buffer)=>{if(!verify('sha256',manifest,key,s)) throw new Error('Invalid signature');};
 let signature:Buffer|null=await readOptional(dir,'signature');
 if(signature) checkSignature(signature);
 else {
  const temporary=await mkdtemp(join(tmpdir(),'esign-kms-digest-'));
  try {
   const file=join(temporary,'digest');await writeFile(file,createHash('sha256').update(manifest).digest(),{mode:0o600,flag:'wx'});
   const signed=await deps.aws(['sign','--key-id','alias/esign-local-test-signing','--message',`fileb://${file}`,'--message-type','DIGEST','--signing-algorithm','ECDSA_SHA_256'],manifest);
   if(signed.KeyId!==metadata.KeyId || signed.SigningAlgorithm!=='ECDSA_SHA_256' || typeof signed.Signature!=='string') throw new Error('Unexpected KMS signature metadata');
   signature=await publishStep(dir,'signature',Buffer.from(signed.Signature,'base64'),checkSignature);
  } finally {await rm(temporary,{recursive:true,force:true});}
 }
 // Derivation binds resumed requests to the authenticated, nondeterministic KMS signature.
 // A caller cannot substitute arbitrary bytes into the public TSA request through the workspace.
 const expectedNonce=fixtureTimestampNonce(signature);
 const nonce=await publishStep(dir,'nonce',expectedNonce,exact(expectedNonce));
 const query=makeTimestampRequest(signature,nonce);
 await publishStep(dir,'request',query,exact(query));
 let response:Buffer|null=await readOptional(dir,'response');
 if(response) await verifyTimestampResponse(signature,nonce,query,response,deps.roots);
 else {
  const candidate=await deps.timestamp(query);
  response=await publishStep(dir,'response',candidate,b=>verifyTimestampResponse(signature!,nonce,query,b,deps.roots));
 }
 return mode==='uploaded' ? await verifyUploadedSeal(dir,keyHash,deps.roots) : mode==='dynamic' ? await verifyDynamicSyntheticSeal(dir,keyHash,deps.roots) : await verifySyntheticSeal(dir,keyHash,deps.roots);
}
