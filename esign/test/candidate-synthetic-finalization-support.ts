import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
import {createCandidateSyntheticTsaTestFinalizer} from '../src/synchronous-positioned-v3-tsa-test.ts';

export async function exerciseCandidateSyntheticFinalization(db:D1Database,bucket:R2Bucket,token:string,keyHash:string,d2:string){
 const dir=await mkdtemp(join(tmpdir(),'candidate-synthetic-'));
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});
 try{
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Synthetic TSA']);
  await writeFile(join(dir,'ext.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
  run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','ext.cnf','-out','tsa.pem']);run(['x509','-in','root.pem','-outform','DER','-out','root.der']);
  await writeFile(join(dir,'serial'),'01\n');await writeFile(join(dir,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\naccuracy=secs:1\nordering=no\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n');
  await new Promise(r=>setTimeout(r,2100));
  const cert=new X509Certificate(await readFile(join(dir,'tsa.pem'))),pin=createHash('sha256').update(cert.publicKey.export({format:'der',type:'spki'})).digest('hex');let calls=0;
  const transport={endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],timeoutMs:5000,authorizeSynthetic:async()=>true,fetch:async(req:Request)=>{calls++;await writeFile(join(dir,'query.tsq'),new Uint8Array(await req.arrayBuffer()));run(['ts','-reply','-config','tsa.cnf','-queryfile','query.tsq','-out','response.tsr']);return new Response(new Uint8Array(await readFile(join(dir,'response.tsr'))),{headers:{'content-type':'application/timestamp-reply'}});}};
  const policy={roots:[await readFile(join(dir,'root.der'))],now:Date.now(),maxAgeMs:60000,maxFutureSkewMs:60000,allowedPolicies:['1.2.3.4'],allowedSignerSpkiSha256:[pin],checkRevocation:async()=>true};
  let trustedNow=policy.now;
  const finalize=createCandidateSyntheticTsaTestFinalizer({clock:()=>trustedNow,sealKey:new TextEncoder().encode('local-test-seal-key-at-least-32-bytes'),transport,policy});
  const request={tenantId:'a',envelopeId:'e',authorization:`Bearer ${token}`};
  const invoke=(database=db,objects=bucket)=>finalize(database,objects,request);
  await assert.rejects(()=>finalize(db,bucket,{...request,tenantId:'b'}));
  const historical=await db.prepare('SELECT session_hash,consented_at FROM signature_records WHERE sequence=1').first<{session_hash:string;consented_at:number}>();
  await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,?)').bind(historical!.session_hash,historical!.consented_at).run();await assert.rejects(()=>invoke(),'revocation at signing is ambiguous');await db.prepare('DELETE FROM recipient_session_revocations').run();
  await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,?)').bind(historical!.session_hash,historical!.consented_at+1).run();
  const sources=(await db.prepare("SELECT object_key FROM artifacts WHERE envelope_id='e' UNION ALL SELECT o.object_key FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id JOIN signature_records r ON r.id=j.signature_id WHERE r.envelope_id='e' AND r.sequence=1").all<{object_key:string}>()).results;
  for(const objectKey of [...sources.map(x=>x.object_key),d2]){const original=await (await bucket.get(objectKey))!.arrayBuffer();await bucket.put(objectKey,'tampered');await assert.rejects(()=>invoke(),`tampered ${objectKey}`);await bucket.put(objectKey,original);}
  const failedBucket=new Proxy(bucket,{get(target,k){if(k==='put')return async()=>{throw new Error('synthetic R2 failure');};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});await assert.rejects(()=>invoke(db,failedBucket));
  await db.exec("CREATE TRIGGER synthetic_race AFTER UPDATE OF status ON envelopes WHEN NEW.status='SYNTHETIC_TSA_TEST_COMPLETED' BEGIN UPDATE signature_events SET event_hash='changed' WHERE sequence=1; END");await assert.rejects(()=>invoke(),'changed chain must roll back completion');await db.exec('DROP TRIGGER synthetic_race');assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='e'").first<{status:string}>())!.status,'FINALIZING');
  await db.exec(`CREATE TRIGGER historical_revoke AFTER UPDATE OF status ON envelopes WHEN NEW.status='SYNTHETIC_TSA_TEST_COMPLETED' BEGIN UPDATE recipient_session_revocations SET revoked_at=${historical!.consented_at} WHERE token_hash='${historical!.session_hash}'; END`);await assert.rejects(()=>invoke(),'ambiguous historical revocation in commit rolls back');await db.exec('DROP TRIGGER historical_revoke');assert.equal((await db.prepare('SELECT revoked_at FROM recipient_session_revocations WHERE token_hash=?').bind(historical!.session_hash).first<{revoked_at:number}>())!.revoked_at,historical!.consented_at+1);
  await db.exec(`CREATE TRIGGER synthetic_revoke AFTER UPDATE OF status ON envelopes WHEN NEW.status='SYNTHETIC_TSA_TEST_COMPLETED' BEGIN UPDATE api_keys SET revoked_at=1 WHERE key_hash='${keyHash}'; END`);await assert.rejects(()=>invoke(),'management revocation in final batch rolls back');await db.exec('DROP TRIGGER synthetic_revoke');assert.equal((await db.prepare('SELECT revoked_at FROM api_keys WHERE key_hash=?').bind(keyHash).first<{revoked_at:number|null}>())!.revoked_at,null);
  const commitFailureDb=new Proxy(db,{get(target,k){if(k==='batch')return async(statements:D1PreparedStatement[])=>{if(statements.length>=9)throw new Error('synthetic final D1 failure');return target.batch(statements);};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});await assert.rejects(()=>invoke(commitFailureDb));assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='e'").first<{status:string}>())!.status,'FINALIZING');
  const objectKey='envelopes/e/synthetic-tsa-test.json';const saved=await (await bucket.get(objectKey))!.arrayBuffer();const callsAfterFailure=calls;
  trustedNow=policy.now+1000;const validWindowAlteration=JSON.parse(new TextDecoder().decode(saved));validWindowAlteration.testPolicy.now=policy.now+1;await bucket.put(objectKey,JSON.stringify(validWindowAlteration));await assert.rejects(()=>invoke(),'precommit issuance must be anchored');await bucket.put(objectKey,saved);
  trustedNow=policy.now+120000;await assert.rejects(()=>invoke(),'same finalizer must use current trusted time');trustedNow=policy.now;
  const laterPolicy={...policy,now:policy.now+1000};
  const restarted=createCandidateSyntheticTsaTestFinalizer({clock:()=>laterPolicy.now,sealKey:new TextEncoder().encode('local-test-seal-key-at-least-32-bytes'),transport,policy:laterPolicy});
  const retry=()=>restarted(db,bucket,request);
  for(const changed of [{...laterPolicy,roots:[new Uint8Array([1])]}, {...laterPolicy,allowedSignerSpkiSha256:['0'.repeat(64)]}, {...laterPolicy,allowedPolicies:['1.2.3.5']}, {...laterPolicy,maxAgeMs:laterPolicy.maxAgeMs+1}, {...laterPolicy,checkRevocation:async()=>false}, {...laterPolicy,now:policy.now+120000}]){
   await assert.rejects(()=>createCandidateSyntheticTsaTestFinalizer({clock:()=>changed.now,sealKey:new TextEncoder().encode('local-test-seal-key-at-least-32-bytes'),transport,policy:changed})(db,bucket,request));
  }
  const altered=JSON.parse(new TextDecoder().decode(saved));altered.testPolicy.now=policy.now+120000;await bucket.put(objectKey,JSON.stringify(altered));await assert.rejects(retry);await bucket.put(objectKey,saved);
  assert.deepEqual(await retry(),{mode:'LOCAL_TEST_ONLY',status:'SYNTHETIC_TSA_TEST_COMPLETED'});assert.deepEqual(new Uint8Array(await (await bucket.get(objectKey))!.arrayBuffer()),new Uint8Array(saved));assert.equal(calls,callsAfterFailure);
  const changedProvenance=JSON.parse(new TextDecoder().decode(saved));changedProvenance.testPolicy.now=policy.now+1;await bucket.put(objectKey,JSON.stringify(changedProvenance));await assert.rejects(retry,'committed evidence hash protects issuance provenance');await bucket.put(objectKey,saved);
  await db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id='e'").run();await db.prepare("DELETE FROM synthetic_tsa_test_evidence WHERE envelope_id='e'").run();
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(keyHash).run();await assert.rejects(()=>invoke());await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(keyHash).run();
  const failedDb=new Proxy(db,{get(target,k){if(k==='batch')return async()=>{throw new Error('synthetic D1 failure');};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});await assert.rejects(()=>invoke(failedDb));
  let lost=false;const lostDb=new Proxy(db,{get(target,k){if(k==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);const status=await target.prepare("SELECT status FROM envelopes WHERE id='e'").first<{status:string}>();if(!lost&&status?.status==='SYNTHETIC_TSA_TEST_COMPLETED'){lost=true;throw new Error('synthetic lost commit response');}return result;};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});await assert.rejects(()=>invoke(lostDb));assert.equal(lost,true);
  assert.deepEqual(await invoke(),{mode:'LOCAL_TEST_ONLY',status:'SYNTHETIC_TSA_TEST_COMPLETED'});const before=calls;assert.deepEqual(await invoke(),{mode:'LOCAL_TEST_ONLY',status:'SYNTHETIC_TSA_TEST_COMPLETED'});assert.equal(calls,before);
  const evidence=(await db.prepare("SELECT object_key FROM synthetic_tsa_test_evidence WHERE envelope_id='e'").first<{object_key:string}>())!.object_key;const evidenceBytes=await (await bucket.get(evidence))!.arrayBuffer();await bucket.put(evidence,'tampered');await assert.rejects(()=>invoke());await bucket.put(evidence,evidenceBytes);
  await db.prepare('DELETE FROM recipient_session_revocations').run();await db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id='e'").run();await db.prepare("DELETE FROM synthetic_tsa_test_evidence WHERE envelope_id='e'").run();
 }finally{await rm(dir,{recursive:true,force:true});}
}
