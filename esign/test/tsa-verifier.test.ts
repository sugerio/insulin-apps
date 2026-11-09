import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash as sha} from 'node:crypto';
import {timestampQuery} from '../src/seal/tsa.ts';
const verifier=await import('../src/seal/tsa.ts').catch(()=>({}));
const run=(args:string[],cwd:string)=>execFileSync('openssl',args,{cwd,stdio:'pipe'});

test('Worker RFC3161 verifier binds synthetic response to imprint, nonce, signer, root and explicit policy',async()=>{
 assert.equal(typeof verifier.verifyRfc3161Timestamp,'function');
 const dir=await mkdtemp(join(tmpdir(),'esign-worker-tsa-'));
 try{
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],dir);
  run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Synthetic TSA'],dir);
  await writeFile(join(dir,'extensions.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
  run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','extensions.cnf','-out','tsa.pem'],dir);
  run(['x509','-in','root.pem','-outform','DER','-out','root.der'],dir);
  await writeFile(join(dir,'serial'),'01\n');await writeFile(join(dir,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\naccuracy=secs:1\nordering=no\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n');
  const input=Buffer.from('synthetic signature'),nonce=Buffer.from('0102030405060708090a0b0c0d0e0f10','hex');await writeFile(join(dir,'query'),Buffer.from(timestampQuery(sha('sha256').update(input).digest(),nonce)));await new Promise(resolve=>setTimeout(resolve,2100));run(['ts','-reply','-config','tsa.cnf','-queryfile','query','-out','response'],dir);
  const response=await readFile(join(dir,'response')),root=await readFile(join(dir,'root.der'));
  const {X509Certificate,createHash}=await import('node:crypto');const signerCert=new X509Certificate(await readFile(join(dir,'tsa.pem')));const signerPin=createHash('sha256').update(signerCert.publicKey.export({format:'der',type:'spki'})).digest('hex');
  const policy={roots:[root],now:Date.now(),maxAgeMs:60000,maxFutureSkewMs:5000,allowedPolicies:['1.2.3.4'],allowedSignerSpkiSha256:[signerPin],checkRevocation:async()=>true};
  const verify=(bytes:Uint8Array=response,p=policy,data:Uint8Array=input,n:Uint8Array=nonce)=>verifier.verifyRfc3161Timestamp!(bytes,data,n,p);
  const result=await verify();assert.equal(result.status,'VERIFIED');
  await assert.rejects(()=>verify(response,{...policy,now:result.time,maxFutureSkewMs:0}),'TSA accuracy must fit the allowed time window');
  await writeFile(join(dir,'no-usage.cnf'),'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=critical,timeStamping\n');run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','2','-days','1','-extfile','no-usage.cnf','-out','tsa-no-usage.pem'],dir);
  const tsaConfig=await readFile(join(dir,'tsa.cnf'),'utf8');await writeFile(join(dir,'tsa-no-usage.cnf'),tsaConfig.replace('signer_cert=tsa.pem','signer_cert=tsa-no-usage.pem'));await new Promise(resolve=>setTimeout(resolve,2100));run(['ts','-reply','-config','tsa-no-usage.cnf','-queryfile','query','-out','no-usage-response'],dir);
  const noUsage=await readFile(join(dir,'no-usage-response'));await assert.rejects(()=>verify(noUsage),'TSA signer without keyUsage must be rejected');
  // These fixtures preserve valid signatures; changing unsigned bytes alone would not exercise these checks.
  const asn1=await import('asn1js'),{TimeStampResp,SignedData}=await import('pkijs');
  const privateKey=await crypto.subtle.importKey('pkcs8',new Uint8Array((await import('node:crypto')).createPrivateKey(await readFile(join(dir,'tsa.key'))).export({format:'der',type:'pkcs8'})),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const signedVariant=async(kind:'two-digests'|'wrong-digest-type'|'unsorted')=>{
   const timestamp=TimeStampResp.fromBER(Uint8Array.from(response)),signed=new SignedData({schema:timestamp.timeStampToken!.content}),attrs=signed.signerInfos[0].signedAttrs!;
   const digest=attrs.attributes.find(a=>a.type==='1.2.840.113549.1.9.4')!;
   if(kind==='two-digests')digest.values.push(new asn1.OctetString({valueHex:digest.values[0].valueBlock.valueHexView.slice().buffer}));
   if(kind==='wrong-digest-type')digest.values[0]=new asn1.BitString({valueHex:digest.values[0].valueBlock.valueHexView.slice().buffer});
   attrs.attributes.sort((a,b)=>Buffer.compare(Buffer.from(a.toSchema().toBER(false)),Buffer.from(b.toSchema().toBER(false))));
   if(kind==='unsorted')attrs.attributes.reverse();
   attrs.encodedValue=new ArrayBuffer(0);await signed.sign(privateKey,0,'SHA-256');timestamp.timeStampToken!.content=signed.toSchema(true);
   const encoded=new Uint8Array(timestamp.toSchema().toBER(false)),roundtrip=TimeStampResp.fromBER(encoded),check=new SignedData({schema:roundtrip.timeStampToken!.content});
   assert.equal(await check.verify({signer:0,data:Uint8Array.from(input).buffer}),true,`${kind} retains a cryptographically valid CMS signature`);
   return encoded;
  };
  const doubleDigest=await signedVariant('two-digests'),wrongDigestType=await signedVariant('wrong-digest-type'),unsorted=await signedVariant('unsorted');
  await writeFile(join(dir,'unknown-critical.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n1.2.3.4.999=critical,DER:05:00\n');
  run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','3','-days','1','-extfile','unknown-critical.cnf','-out','tsa-unknown.pem'],dir);
  await writeFile(join(dir,'tsa-unknown.cnf'),tsaConfig.replace('signer_cert=tsa.pem','signer_cert=tsa-unknown.pem'));await new Promise(resolve=>setTimeout(resolve,2100));run(['ts','-reply','-config','tsa-unknown.cnf','-queryfile','query','-out','unknown-response'],dir);
  const unknown=await readFile(join(dir,'unknown-response'));
  const unknownToken=TimeStampResp.fromBER(Uint8Array.from(unknown));const unknownSigned=new SignedData({schema:unknownToken.timeStampToken!.content});assert.equal(await unknownSigned.verify({signer:0,data:Uint8Array.from(input).buffer}),true,'unknown-critical signer response has a valid CMS signature');
  const unknownPolicy={...policy,now:Date.now()};
  const negatives=[['unknown critical signer',()=>verify(unknown,unknownPolicy)],['multiple messageDigest values',()=>verify(doubleDigest)],['non-octet messageDigest',()=>verify(wrongDigestType)],['unsorted signedAttrs',()=>verify(unsorted)]] as const;
  const outcomes=await Promise.all(negatives.map(async([name,check])=>{try{await check();return `${name}: ACCEPTED`;}catch{return `${name}: rejected`;}}));
  assert.deepEqual(outcomes,negatives.map(([name])=>`${name}: rejected`));
  await assert.rejects(()=>verify(unknown,unknownPolicy),/Unsupported critical certificate extension/);
  for(const variant of [doubleDigest,wrongDigestType])await assert.rejects(()=>verify(variant),/Invalid CMS message digest attribute/);
  await assert.rejects(()=>verify(unsorted),/Unsorted DER set/);
  // Exercise the complete validated path, including an intermediate and the selected trust anchor.
  run(['req','-newkey','rsa:2048','-nodes','-keyout','intermediate.key','-out','intermediate.csr','-subj','/CN=Synthetic Intermediate'],dir);
  await writeFile(join(dir,'ca-good.cnf'),'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  await writeFile(join(dir,'ca-bad.cnf'),'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.3.4.999=critical,DER:05:00\n');
  for(const [name,serial,ext] of [['good','10','ca-good.cnf'],['bad','11','ca-bad.cnf']])run(['x509','-req','-in','intermediate.csr','-CA','root.pem','-CAkey','root.key','-set_serial',serial,'-days','1','-extfile',ext,'-out',`intermediate-${name}.pem`],dir);
  for(const [name,serial] of [['good','20'],['bad','21']])run(['x509','-req','-in','tsa.csr','-CA',`intermediate-${name}.pem`,'-CAkey','intermediate.key','-set_serial',serial,'-days','1','-extfile','extensions.cnf','-out',`tsa-intermediate-${name}.pem`],dir);
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','critical-root.key','-out','critical-root.pem','-subj','/CN=Synthetic Critical Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-addext','1.2.3.4.999=critical,DER:05:00'],dir);
  run(['x509','-req','-in','tsa.csr','-CA','critical-root.pem','-CAkey','critical-root.key','-set_serial','30','-days','1','-extfile','extensions.cnf','-out','tsa-critical-root.pem'],dir);
  run(['x509','-in','critical-root.pem','-outform','DER','-out','critical-root.der'],dir);
  for(const name of ['good','bad'])await writeFile(join(dir,`tsa-intermediate-${name}.cnf`),tsaConfig.replace('signer_cert=tsa.pem',`signer_cert=tsa-intermediate-${name}.pem\ncerts=intermediate-${name}.pem`));
  await writeFile(join(dir,'tsa-critical-root.cnf'),tsaConfig.replace('signer_cert=tsa.pem','signer_cert=tsa-critical-root.pem'));
  await new Promise(resolve=>setTimeout(resolve,2100));
  for(const name of ['intermediate-good','intermediate-bad','critical-root'])run(['ts','-reply','-config',`tsa-${name}.cnf`,'-queryfile','query','-out',`response-${name}`],dir);
  const goodIntermediate=await readFile(join(dir,'response-intermediate-good')),badIntermediate=await readFile(join(dir,'response-intermediate-bad')),badRoot=await readFile(join(dir,'response-critical-root')),criticalRoot=await readFile(join(dir,'critical-root.der'));
  let pathLength=0;const chainPolicy={...policy,now:Date.now(),checkRevocation:async(chain:Uint8Array[])=>{pathLength=chain.length;return true;}};
  assert.equal((await verify(goodIntermediate,chainPolicy)).status,'VERIFIED');assert.equal(pathLength,3,'test must exercise an intermediate, not a direct root');
  // Re-sign a signer and an intermediate with duplicated non-critical extensions.
  // Use a harmless private OID so rejection cannot be explained by the existing KU/EKU checks.
  const {Certificate,Extension}=await import('pkijs');
  const rootPrivate=await crypto.subtle.importKey('pkcs8',new Uint8Array((await import('node:crypto')).createPrivateKey(await readFile(join(dir,'root.key'))).export({format:'der',type:'pkcs8'})),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const rootCertificate=Certificate.fromBER(Uint8Array.from(root));
  const makeDuplicate=async(original:Uint8Array,duplicate:'signer'|'intermediate')=>{
   const timestamp=TimeStampResp.fromBER(Uint8Array.from(original)),signed=new SignedData({schema:timestamp.timeStampToken!.content});
   const signer=signed.certificates!.find((c:any)=>c instanceof Certificate&&c.extensions?.some((e:any)=>e.extnID==='2.5.29.37')) as InstanceType<typeof Certificate>;
   const target=duplicate==='signer'?signer:signed.certificates!.find((c:any)=>c instanceof Certificate&&c.subject.isEqual(signer.issuer)) as InstanceType<typeof Certificate>;
   assert.ok(target,`fixture has ${duplicate} certificate`);
   for(let i=0;i<2;i++)target.extensions!.push(new Extension({extnID:'1.2.3.4.500',critical:false,extnValue:new Uint8Array([5,0]).buffer}));
   await target.sign(rootPrivate,'SHA-256');assert.equal(await target.verify(rootCertificate),true,`${duplicate} certificate retains a valid issuer signature`);
   if(duplicate==='signer'){
    const attrs=signed.signerInfos[0].signedAttrs!,ess=attrs.attributes.find(a=>a.type==='1.2.840.113549.1.9.16.2.47')!;
    const certHash=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(signer.toSchema().toBER(false))));
    (ess.values[0] as any).valueBlock.value[0].valueBlock.value[0].valueBlock.value[0]=new asn1.OctetString({valueHex:certHash.buffer});
    attrs.attributes.sort((a,b)=>Buffer.compare(Buffer.from(a.toSchema().toBER(false)),Buffer.from(b.toSchema().toBER(false))));attrs.encodedValue=new ArrayBuffer(0);await signed.sign(privateKey,0,'SHA-256');
   }
   timestamp.timeStampToken!.content=signed.toSchema(true);const encoded=new Uint8Array(timestamp.toSchema().toBER(false));
   const roundtrip=TimeStampResp.fromBER(encoded),check=new SignedData({schema:roundtrip.timeStampToken!.content});
   const valid=await check.verify({signer:0,data:Uint8Array.from(input).buffer,checkChain:true,passedWhenNotRevValues:true,trustedCerts:[rootCertificate],extendedMode:true});
   assert.equal(valid.signatureVerified,true,`${duplicate} fixture retains a valid CMS signature and PKI.js chain`);assert.equal(valid.signerCertificateVerified,true);
   return encoded;
  };
  const duplicateSigner=await makeDuplicate(response,'signer'),duplicateIntermediate=await makeDuplicate(goodIntermediate,'intermediate');
  pathLength=0;await assert.rejects(()=>verify(duplicateSigner,chainPolicy),/Duplicate certificate extension/);assert.equal(pathLength,0,'duplicate signer must not reach revocation');
  pathLength=0;await assert.rejects(()=>verify(duplicateIntermediate,chainPolicy),/Duplicate certificate extension/);assert.equal(pathLength,0,'duplicate intermediate must not reach revocation');
  pathLength=0;await assert.rejects(()=>verify(badIntermediate,chainPolicy),/critical/i,'unknown critical intermediate extension is rejected');assert.equal(pathLength,0,'invalid path must not reach revocation approval');
  pathLength=0;await assert.rejects(()=>verify(badRoot,{...chainPolicy,roots:[criticalRoot]}),/critical/i,'unknown critical root extension is rejected');assert.equal(pathLength,0,'invalid root must not reach revocation approval');
  const {build}=await import('esbuild'),{Miniflare}=await import('miniflare');
  const workerNegatives=[unknown,doubleDigest,wrongDigestType,unsorted,badIntermediate,badRoot,duplicateSigner,duplicateIntermediate].map(b=>Buffer.from(b).toString('base64'));
  const source=`import {verifyRfc3161Timestamp} from './src/seal/tsa.ts'; const dec=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)); export default {async fetch(){try{const policy={roots:[dec('${root.toString('base64')}')],now:Date.now(),maxAgeMs:60000,maxFutureSkewMs:5000,allowedPolicies:['1.2.3.4'],allowedSignerSpkiSha256:['${signerPin}'],checkRevocation:async()=>true};const verify=(bytes,p=policy)=>verifyRfc3161Timestamp(dec(bytes),dec('${input.toString('base64')}'),dec('${nonce.toString('base64')}'),p);const r=await verify('${response.toString('base64')}');const negatives=${JSON.stringify(workerNegatives)};let rejected=0;for(let i=0;i<negatives.length;i++){try{await verify(negatives[i],i===5?{...policy,roots:[dec('${criticalRoot.toString('base64')}')]}:policy);}catch{rejected++;}}return Response.json({status:r.status,rejected});}catch(e){return new Response(String(e),{status:500});}}}`;
  const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-01-01'});
  try{const workerResponse=await mf.dispatchFetch('https://local.test/');const text=await workerResponse.text();assert.equal(workerResponse.status,200,text);assert.deepEqual(JSON.parse(text),{status:'VERIFIED',rejected:8});}finally{await mf.dispose();}
  await assert.rejects(()=>verify(response,{...policy,checkRevocation:undefined} as any));
  await assert.rejects(()=>verify(response,{...policy,checkRevocation:async()=>false}));
  await assert.rejects(()=>verify(response,{...policy,roots:[]}));
  await assert.rejects(()=>verify(response,{...policy,allowedPolicies:['1.2.3.5']}));
  await assert.rejects(()=>verify(response,{...policy,allowedSignerSpkiSha256:['0'.repeat(64)]}));
  await assert.rejects(()=>verify(response,{...policy,now:Date.now()+120000}));
  await assert.rejects(()=>verify(response,policy,Buffer.from('changed')));
  await assert.rejects(()=>verify(response,policy,input,Buffer.alloc(16,7)));
  await assert.rejects(()=>verify(Buffer.concat([response,Buffer.from('x')])));
  const lengthBytes=response[1]&0x7f;assert.ok(response[1]&0x80);const indefinite=Buffer.concat([Buffer.from([0x30,0x80]),response.subarray(2+lengthBytes),Buffer.from([0,0])]);await assert.rejects(()=>verify(indefinite),'indefinite BER must not be accepted as DER');
  await assert.rejects(()=>verify(new Uint8Array(65537)));
  const badStatus=Buffer.from(response),pos=badStatus.indexOf(Buffer.from('3003020100','hex'));assert.ok(pos>=0);badStatus[pos+4]=2;await assert.rejects(()=>verify(badStatus));
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','other.key','-out','other.pem','-subj','/CN=Other Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE'],dir);run(['x509','-in','other.pem','-outform','DER','-out','other.der'],dir);
  const otherRoot=await readFile(join(dir,'other.der'));await assert.rejects(()=>verify(response,{...policy,roots:[otherRoot]}));
  const altered=Buffer.from(response);altered[altered.length-1]^=1;await assert.rejects(()=>verify(altered));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a real DigiCert timestamp verifies against the pinned root, signer and policy', async () => {
  const {readFile}=await import('node:fs/promises');
  const trust=await import('../src/seal/tsa.ts');
  const dir='test/fixtures/digicert-tsa-2026-11-06/';
  const [response,input,nonce]=await Promise.all(['response.der','input.bin','nonce.bin'].map(async f=>new Uint8Array(await readFile(dir+f))));
  const policy={roots:trust.digicertRoots(),now:Date.parse('2026-11-06T16:05:43Z'),maxAgeMs:300000,maxFutureSkewMs:300000,allowedPolicies:[trust.DIGICERT_TSA_POLICY],allowedSignerSpkiSha256:trust.DIGICERT_TSA_SIGNERS,missingAccuracyMs:trust.DIGICERT_MISSING_ACCURACY_MS,checkRevocation:async()=>true};
  const result=await verifier.verifyRfc3161Timestamp!(response,input,nonce,policy);
  assert.equal(result.time,Date.parse('2026-11-06T16:05:43Z'));
  await assert.rejects(()=>verifier.verifyRfc3161Timestamp!(response,input,nonce,{...policy,missingAccuracyMs:undefined}),/accuracy/,'without missingAccuracyMs a token lacking accuracy is refused');
  const other=Uint8Array.from(input);other[0]^=1;
  await assert.rejects(()=>verifier.verifyRfc3161Timestamp!(response,other,nonce,policy),undefined,'another input');
  await assert.rejects(()=>verifier.verifyRfc3161Timestamp!(response,input,nonce,{...policy,allowedSignerSpkiSha256:['0'.repeat(64)]}),/Unauthorized TSA signer/);
});
