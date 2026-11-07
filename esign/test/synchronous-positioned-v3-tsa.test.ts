import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {Hono} from 'hono';
import {makeTimestampRequest} from '../scripts/synthetic-seal-tsa.ts';
import {issueRecipientCode,exchangeRecipientCode,sendRecipientOtp,verifyRecipientOtp} from '../src/page-authorization.ts';
import {renderTypedSignature} from '../src/typed-signature-image.ts';
import {renderPositionedV3Text} from '../src/positioned-v3-text-render.ts';
import {signatureGeometry} from '../src/positioned-signature-geometry.ts';
import {positionedV3TextGeometry} from '../src/positioned-v3-text-fit.ts';
import {signaturePreviewHash} from '../src/positioned-signature-preview.ts';
const module=await import('../src/synchronous-positioned-v3-tsa-test.ts').catch(()=>({}));
const hash=async(b:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(b))).toString('hex');

test('isolated v3 two-signer TSA test completion fails closed and recovers partial writes',async()=>{
 assert.equal(typeof module.createSyntheticTsaV3TestSigner,'function');
 assert.equal(typeof module.createSyntheticTsaV3TestRecovery,'function','authorized recovery is missing');
 const dir=await mkdtemp(join(tmpdir(),'esign-v3-tsa-'));
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Synthetic Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
 run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Synthetic TSA']);
 await writeFile(join(dir,'ext.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
 run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','ext.cnf','-out','tsa.pem']);run(['x509','-in','root.pem','-outform','DER','-out','root.der']);
 await writeFile(join(dir,'serial'),'01\n');await writeFile(join(dir,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\naccuracy=secs:1\nordering=no\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n');
 await new Promise(r=>setTimeout(r,2100));
 const root=await readFile(join(dir,'root.der')),cert=new X509Certificate(await readFile(join(dir,'tsa.pem'))),pin=createHash('sha256').update(cert.publicKey.export({format:'der',type:'spki'})).digest('hex');let mode:'timeout'|'invalid'|'good'='timeout',tsaCalls=0;
 const transport={endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],timeoutMs:5000,authorizeSynthetic:async()=>true,fetch:async(req:Request)=>{tsaCalls++;if(mode==='timeout')return await new Promise<Response>(()=>{});if(mode==='invalid')return new Response(new Uint8Array([48,0]),{headers:{'content-type':'application/timestamp-reply'}});await writeFile(join(dir,'query.tsq'),new Uint8Array(await req.arrayBuffer()));run(['ts','-reply','-config','tsa.cnf','-queryfile','query.tsq','-out','response.tsr']);return new Response(new Uint8Array(await readFile(join(dir,'response.tsr'))),{headers:{'content-type':'application/timestamp-reply'}});}};
 const policy={roots:[root],now:Date.now(),maxAgeMs:60000,maxFutureSkewMs:60000,allowedPolicies:['1.2.3.4'],allowedSignerSpkiSha256:[pin],checkRevocation:async()=>true};
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
   const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
  }
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save(),h0=await hash(bytes);await bucket.put('d0.pdf',bytes);
  const roles=['ana','bob']; const fields=['ana','bob'].flatMap((role,i)=>[{id:`sig-${role}`,type:'Signature',role,page:1,required:true,rect:{x:.05,y:i?.6:.1,width:.25,height:.08}},{id:`date-${role}`,type:'Date signed',role,page:1,required:true,rect:{x:.4,y:i?.6:.1,width:.4,height:.08}},{id:`title-${role}`,type:'Title',role,page:1,required:true,rect:{x:.05,y:i?.8:.3,width:.4,height:.08}}]);
  const rolesJson=JSON.stringify(roles),fieldsJson=JSON.stringify(fields),origin='https://host.example.com';
  await db.batch([db.prepare("INSERT INTO tenants VALUES ('tenant')"),db.prepare("INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at,fields_json) VALUES ('tpl','tenant','src',?,1,?)").bind(rolesJson,fieldsJson),db.prepare("INSERT INTO envelopes VALUES ('env','tenant','tpl','IN_PROGRESS',1)"),db.prepare("INSERT INTO tasks VALUES ('ana','env','ana','Ana','ana@example.com',1,'ACTIVE')"),db.prepare("INSERT INTO tasks VALUES ('bob','env','bob','Bob','bob@example.com',2,'PENDING')"),db.prepare("INSERT INTO artifacts VALUES ('d0','env','d0.pdf',?)").bind(h0),db.prepare("INSERT INTO tenant_page_origins VALUES ('tenant',?)").bind(origin)]);
  const managementKey='d'.repeat(64),otherKey='synthetic_other_tenant_key_1234567890abcdef',revokedKey='synthetic_revoked_key_1234567890abcdef';
  await db.batch([db.prepare("INSERT INTO tenants VALUES ('other')"),...[[managementKey,'tenant',null],[otherKey,'other',null],[revokedKey,'tenant',1]].map(([key,tenant,revoked])=>db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,?)').bind(createHash('sha256').update(key as string).digest('hex'),tenant,revoked))]);
  let artifactId='d0',artifactHash=h0;const sealKey=new TextEncoder().encode('local-test-seal-key-at-least-32-bytes');const signDirect=module.createSyntheticTsaV3TestSigner!({sealKey,transport,policy,clock:()=>policy.now}),recoverDirect=module.createSyntheticTsaV3TestRecovery!({sealKey,transport,policy,clock:()=>policy.now});
  const recover=async(db:D1Database,bucket:R2Bucket,authorization=`Bearer ${managementKey}`,tenantId='tenant',envelopeId='env')=>recoverDirect(db,bucket,{tenantId,envelopeId,authorization});
  let lastCommand:any;
  const sign=async(db:D1Database,bucket:R2Bucket,cmd:any)=>{const app=new Hono();app.post('/synthetic-test/sign',async c=>{try{return c.json(await signDirect(db,bucket,await c.req.json()));}catch{return c.json({error:'synthetic_test_unavailable'},503);}});const response=await app.fetch(new Request('https://local.test/synthetic-test/sign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(cmd)}));if(!response.ok)throw new Error('Synthetic test unavailable');return response.json() as Promise<{mode:string;signatureId:string;status:string}>;};
  for(const [index,role] of roles.entries()){
   const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'tenant',envelopeId:'env',taskId:role,origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1),pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');let otp='';
   await sendRecipientOtp(db,token,origin,now+2,pepper,async(_email,value)=>{otp=value;});assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),true);
   const sig=fields.find(f=>f.id===`sig-${role}`)!,title=fields.find(f=>f.id===`title-${role}`)!,dateField=fields.find(f=>f.id===`date-${role}`)!;
   const name=role.toUpperCase(),titleText='Director',date=new Date(now+4).toISOString().slice(0,10),sigImage=await renderTypedSignature(name),titleImage=await renderPositionedV3Text(titleText),dateImage=await renderPositionedV3Text(date),previewId=crypto.randomUUID();
   const signaturePreviews={[sig.id]:await signaturePreviewHash(artifactHash,rolesJson,fieldsJson,sig.id,name,await hash(sigImage),signatureGeometry(pdf.getPage(0),sig,sigImage))};
   const textPreviews={[title.id]:await signaturePreviewHash(artifactHash,rolesJson,fieldsJson,title.id,titleText,await hash(titleImage),positionedV3TextGeometry(pdf.getPage(0),title,titleImage))};
   await db.prepare('INSERT INTO positioned_v3_date_previews(session_hash,field_id,preview_id,date_text,image_sha256,artifact_id,artifact_sha256,roles_json,fields_json,expires_at,geometry_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(await hash(new TextEncoder().encode(token)),dateField.id,previewId,date,await hash(dateImage),artifactId,artifactHash,rolesJson,fieldsJson,now+300000,JSON.stringify(positionedV3TextGeometry(pdf.getPage(0),dateField,dateImage))).run();
   const cmd={token,origin,now:now+4,artifactId,artifactHash,consent:true,values:{[sig.id]:name,[title.id]:titleText},datePreviewIds:{[dateField.id]:previewId},signaturePreviews,textPreviews,idempotencyKey:`synthetic-${role}-key`};
   lastCommand=cmd;
   await assert.rejects(()=>sign(db,bucket,{...cmd,token:managementKey}),'management key cannot sign');
   if(index===0){
    const tokenHash=await hash(new TextEncoder().encode(token));const beforeKeys=(await bucket.list({prefix:'envelopes/env/'})).objects.map(o=>o.key).sort();
    const otpBefore=await db.prepare('SELECT task_id,session_hash,verified_at FROM recipient_otp_verifications WHERE task_id=?').bind(role).first();
    for(const [owner,revoked] of [['tenant',null],['tenant',1],['other',null]] as const){
     await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,?)').bind(tokenHash,owner,revoked).run();
     await assert.rejects(()=>sign(db,bucket,cmd),`API-key collision owner=${owner} revoked=${revoked} must not sign`);
     assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_jobs').first())!.n,0);
     assert.deepEqual((await bucket.list({prefix:'envelopes/env/'})).objects.map(o=>o.key).sort(),beforeKeys,'pre-existing collision must not write objects');
     assert.deepEqual(await db.prepare('SELECT task_id,session_hash,verified_at FROM recipient_otp_verifications WHERE task_id=?').bind(role).first(),otpBefore,'OTP evidence remains unchanged');
     await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(tokenHash).run();
    }
    for(const revoked of [null,1] as const){
     let inserted=false;const beforeRace=(await bucket.list({prefix:'envelopes/env/'})).objects.map(o=>o.key).sort();
     const raceDb=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!inserted){inserted=true;await target.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,NULL)').bind(tokenHash,'other').run();if(revoked!==null)await target.prepare('UPDATE api_keys SET revoked_at=? WHERE key_hash=?').bind(revoked,tokenHash).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
     await assert.rejects(()=>sign(raceDb,bucket,cmd),'new or newly-revoked colliding key must fail at commit');assert.equal(inserted,true);
     assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_jobs').first())!.n,0);
     assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key LIKE 'local-v3-sign:%'").first())!.n,0);
     const afterRace=(await bucket.list({prefix:'envelopes/env/'})).objects.map(o=>o.key).sort();assert.ok(afterRace.length>beforeRace.length,'rejected cross-store race leaves candidate images; do not delete them');
     assert.deepEqual(await db.prepare('SELECT task_id,session_hash,verified_at FROM recipient_otp_verifications WHERE task_id=?').bind(role).first(),otpBefore);
     await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(tokenHash).run();
    }
   }
   if(index===1){await assert.rejects(()=>sign(db,bucket,{...cmd,idempotencyKey:'synthetic-ana-key'}));assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,1);}
   let lose=true;const unreliable=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(lose&&args[0].includes('/signed:')){lose=false;throw new Error('PDF response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   if(index===0){
    const attempts=await Promise.allSettled([sign(db,unreliable,cmd),sign(db,unreliable,cmd)]);
    assert.ok(attempts.some(x=>x.status==='rejected'),'lost output response must surface');
    assert.equal(lose,false);
   }else{
    let lostCommit=true;
    const ambiguousDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(lostCommit){lostCommit=false;throw new Error('commit response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>sign(ambiguousDb,unreliable,cmd));
    assert.equal(lostCommit,false);
   }
   assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,index+1);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key LIKE 'local-v3-sign:%'").first())!.n,index+1);
   if(index===1){
    const tokenHash=await hash(new TextEncoder().encode(cmd.token));const oldExpiry=(await db.prepare('SELECT expires_at FROM recipient_page_sessions WHERE token_hash=?').bind(tokenHash).first<{expires_at:number}>())!.expires_at;let expiredDuringWrite=false;
    const expireBucket=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(args[0].includes('/signed:')&&!expiredDuringWrite){expiredDuringWrite=true;await db.prepare('UPDATE recipient_page_sessions SET expires_at=0 WHERE token_hash=?').bind(tokenHash).run();}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>sign(db,expireBucket,cmd),'a session expiring before PDF commit must not advance the job');assert.equal(expiredDuringWrite,true);assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signature_jobs WHERE status='PENDING'").first())!.n,1);
    await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE token_hash=?').bind(oldExpiry,tokenHash).run();await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE token_hash=?').bind(cmd.now+1,tokenHash).run();
    assert.ok(Date.now()>cmd.now+1,'synthetic session is actually expired');const beforeExpiredSign=tsaCalls;
    await assert.rejects(()=>sign(db,bucket,cmd),'expired signing session must not authorize recovery');
    assert.equal(tsaCalls,beforeExpiredSign,'expired signing replay must not call TSA');assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signature_jobs WHERE status='PENDING'").first())!.n,1,'expired signing replay must not process the pending job');
    const beforeUnauthorized=tsaCalls;
    await assert.rejects(()=>recover(db,bucket,`Bearer ${cmd.token}`),'signing token is not a management recovery key');
    await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(tokenHash,'tenant').run();await assert.rejects(()=>recover(db,bucket,`Bearer ${cmd.token}`),'even a colliding management key cannot turn a signing token into recovery authority');await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(tokenHash).run();
    await assert.rejects(()=>recover(db,bucket,`Bearer ${otherKey}`),'cross-tenant management key');
    await assert.rejects(()=>recover(db,bucket,`Bearer ${revokedKey}`),'revoked management key');
    await assert.rejects(()=>recover(db,bucket,`Bearer ${managementKey}`,'other'),'management key cannot select another tenant');
    await assert.rejects(()=>recover(db,bucket,`Bearer ${managementKey}`,'tenant','missing'),'unknown envelope');
    assert.equal(tsaCalls,beforeUnauthorized);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,2);
    await db.prepare("UPDATE tasks SET role='other' WHERE id='ana'").run();await assert.rejects(()=>recover(db,bucket),'a mismatched predecessor role cannot be recovered');assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signature_jobs WHERE status='PENDING'").first())!.n,1);await db.prepare("UPDATE tasks SET role='ana' WHERE id='ana'").run();
    const priorEvent=await db.prepare('SELECT signature_id,event_hash FROM signature_events WHERE sequence=1').first<{signature_id:string;event_hash:string}>();let changedPrior=false;
    const changePriorBucket=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(args[0].includes('/signed:')&&!changedPrior){changedPrior=true;await db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind('0'.repeat(64),priorEvent!.signature_id).run();}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(db,changePriorBucket),'predecessor event changed before PDF commit');assert.equal(changedPrior,true);assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signature_jobs WHERE status='PENDING'").first())!.n,1);await db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(priorEvent!.event_hash,priorEvent!.signature_id).run();
    let expiredDuringProcessing=false;const expireEnvelopeBucket=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(args[0].includes('/signed:')&&!expiredDuringProcessing){expiredDuringProcessing=true;await db.prepare("UPDATE envelopes SET status='EXPIRED' WHERE id='env'").run();}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(db,expireEnvelopeBucket),'expired envelope cannot commit a pending PDF');assert.equal(expiredDuringProcessing,true);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'EXPIRED');assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signature_jobs WHERE status='PENDING'").first())!.n,1);await db.prepare("UPDATE envelopes SET status='IN_PROGRESS' WHERE id='env'").run();
    const managementHash=createHash('sha256').update(managementKey).digest('hex');let revokedDuringProcessing=false;
    const revokeBucket=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(args[0].includes('/signed:')&&!revokedDuringProcessing){revokedDuringProcessing=true;await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(managementHash).run();}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(db,revokeBucket),'revoked key cannot commit pending PDF');assert.equal(revokedDuringProcessing,true);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'IN_PROGRESS');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signature_jobs WHERE status='PENDING'").first())!.n,1);await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(managementHash).run();
    const pendingRecovery=await Promise.allSettled([recover(db,bucket),recover(db,bucket)]);assert.ok(pendingRecovery.every(x=>x.status==='rejected'),'concurrent recovery must not claim completion on TSA timeout');assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM synthetic_tsa_test_evidence').first())!.n,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,2);
    mode='invalid';await assert.rejects(()=>recover(db,bucket));assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM synthetic_tsa_test_evidence').first())!.n,0);
    await db.prepare("UPDATE envelopes SET status='EXPIRED' WHERE id='env'").run();const beforeExpired=tsaCalls;await assert.rejects(()=>recover(db,bucket),'expired envelope must not be recovered');assert.equal(tsaCalls,beforeExpired);await db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id='env'").run();
    let revokedBeforeTsa=false;const revokeBeforeTsa=new Proxy(bucket,{get(target,key){if(key==='get')return async (objectKey:string)=>{const result=await target.get(objectKey);if(objectKey.endsWith('synthetic-tsa-test.json')&&!revokedBeforeTsa){revokedBeforeTsa=true;await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(managementHash).run();}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const beforeRevocation=tsaCalls;await assert.rejects(()=>recover(db,revokeBeforeTsa),'revoked recovery key must not start TSA');assert.equal(revokedBeforeTsa,true);assert.equal(tsaCalls,beforeRevocation);await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(managementHash).run();
    mode='good';let lostEvidence=true;const evidenceBucket=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(lostEvidence&&args[0].endsWith('synthetic-tsa-test.json')){lostEvidence=false;throw new Error('evidence response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(db,evidenceBucket));assert.equal(lostEvidence,false,'test must reach the evidence write before simulating its lost response');assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');
    await assert.rejects(()=>recover(db,bucket),'an unanchored object after a lost R2 response is not reusable');await bucket.delete('envelopes/env/synthetic-tsa-test.json');
    await db.prepare("UPDATE tasks SET role='other' WHERE id='ana'").run();await assert.rejects(()=>recover(db,bucket),'prior signer role change must be rejected');await db.prepare("UPDATE tasks SET role='ana' WHERE id='ana'").run();
    const historical=await db.prepare('SELECT session_hash FROM signature_records WHERE sequence=1').first<{session_hash:string}>();const otherSession=await db.prepare('SELECT session_hash FROM signature_records WHERE sequence=2').first<{session_hash:string}>();let changedSession=false;
    const sessionRaceDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!changedSession){changedSession=true;await target.prepare('UPDATE signature_records SET session_hash=? WHERE sequence=1').bind(otherSession!.session_hash).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(sessionRaceDb,bucket),'historical session changed before finalization must fail');assert.equal(changedSession,true);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');await db.prepare('UPDATE signature_records SET session_hash=? WHERE sequence=1').bind(historical!.session_hash).run();
    const otpRow=await db.prepare('SELECT recipient_email FROM recipient_otp_verifications WHERE task_id=?').bind('ana').first<{recipient_email:string}>();let changedOtp=false;
    const otpRaceDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!changedOtp){changedOtp=true;await target.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind('tampered@example.com','ana').run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(otpRaceDb,bucket),'historical OTP changed before finalization must fail');assert.equal(changedOtp,true);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');await db.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind(otpRow!.recipient_email,'ana').run();
    const event=await db.prepare('SELECT signature_id,event_hash FROM signature_events ORDER BY sequence LIMIT 1').first<{signature_id:string;event_hash:string}>();let changed=false;
    const racedDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!changed){changed=true;await target.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind('0'.repeat(64),event!.signature_id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(racedDb,bucket),'facts changed between revalidation and commit must fail');assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');
    await db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(event!.event_hash,event!.signature_id).run();
    let revokedAtCommit=false;const revokeDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!revokedAtCommit){revokedAtCommit=true;await target.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(managementHash).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(revokeDb,bucket),'revoked key cannot commit completion');assert.equal(revokedAtCommit,true);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(managementHash).run();
    let expiredAtCommit=false;const expireDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!expiredAtCommit){expiredAtCommit=true;await target.prepare("UPDATE envelopes SET status='EXPIRED' WHERE id='env'").run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(expireDb,bucket),'envelope expiration wins the completion race');assert.equal(expiredAtCommit,true);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'EXPIRED');await db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id='env'").run();
    const before=tsaCalls;const failingDb=new Proxy(db,{get(target,key){if(key==='batch')return async()=>{throw new Error('D1 unavailable');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>recover(failingDb,bucket));assert.equal(tsaCalls,before,'published valid response is reused after loss');assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');
    let lostFinalCommit=true;const ambiguousFinalDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(lostFinalCommit){lostFinalCommit=false;throw new Error('commit response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});await assert.rejects(()=>recover(ambiguousFinalDb,bucket));assert.equal(lostFinalCommit,false);assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'SYNTHETIC_TSA_TEST_COMPLETED');assert.equal(tsaCalls,before,'lost D1 reply must not issue another TSA request');
   }
   const [result,again]=await Promise.all(index?[recover(db,bucket),recover(db,bucket)]:[sign(db,bucket,cmd),sign(db,bucket,cmd)]);
   assert.deepEqual(result,again);assert.equal(result.status,index?'SYNTHETIC_TSA_TEST_COMPLETED':'IN_PROGRESS');
   if(index===0){const count=tsaCalls;await assert.rejects(()=>recover(db,bucket),'recovery cannot sign an unsigned next task');assert.equal(tsaCalls,count);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,1);
    const tokenHash=await hash(new TextEncoder().encode(token)),beforeReplay=(await bucket.list({prefix:'envelopes/env/'})).objects.map(o=>o.key).sort();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,?)').bind(tokenHash,'other',1).run();
    await assert.rejects(()=>sign(db,bucket,cmd),'a revoked colliding key must also block existing-fact replay');assert.deepEqual((await bucket.list({prefix:'envelopes/env/'})).objects.map(o=>o.key).sort(),beforeReplay);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,1);await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(tokenHash).run();}
   await assert.rejects(()=>sign(db,bucket,{...cmd,values:{...cmd.values,[title.id]:'Changed'}}));
   await assert.rejects(()=>sign(db,bucket,{...cmd,idempotencyKey:'different-key'}));
   await assert.rejects(()=>sign(db,bucket,{...cmd,origin:'https://other.example.com'}));
   await assert.rejects(()=>sign(db,bucket,{...cmd,now:now+99999999}));
   const output=await db.prepare('SELECT o.artifact_id,o.sha256 FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id JOIN signature_records r ON r.id=j.signature_id WHERE r.task_id=?').bind(role).first<{artifact_id:string;sha256:string}>();artifactId=output!.artifact_id;artifactHash=output!.sha256;
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM local_test_evidence').first())!.n,0);
  const evidence=await db.prepare('SELECT object_key FROM synthetic_tsa_test_evidence').first<{object_key:string}>();const evidenceBytes=await (await bucket.get(evidence!.object_key))!.arrayBuffer();const material=JSON.parse(new TextDecoder().decode(evidenceBytes)) as {manifest:string;mockKmsMac:string;nonceHex:string;queryHex:string;responseHex:string;testPolicy:{now:number;allowedPolicies:string[]};revocation:string};
  assert.deepEqual(material.testPolicy.allowedPolicies,['1.2.3.4']);assert.equal(material.testPolicy.now,policy.now);assert.equal(material.revocation,'TEST_ONLY_NOT_CHECKED');
  const manifest=JSON.parse(material.manifest);assert.equal(manifest.format,'esign-local-test-manifest-v3');assert.equal(manifest.signatures.length,2);assert.equal(manifest.positionedSignatures.length,2);assert.equal(manifest.signatures[1].input_sha256,manifest.signatures[0].sha256);assert.equal(manifest.signatures[1].previous_hash,manifest.signatures[0].event_hash);
  assert.deepEqual(Buffer.from(material.queryHex,'hex'),makeTimestampRequest(Buffer.from(material.mockKmsMac),Buffer.from(material.nonceHex,'hex')));
  await writeFile(join(dir,'stored-query.tsq'),Buffer.from(material.queryHex,'hex'));await writeFile(join(dir,'stored-response.tsr'),Buffer.from(material.responseHex,'hex'));run(['ts','-verify','-queryfile','stored-query.tsq','-in','stored-response.tsr','-CAfile','root.pem']);
  await bucket.put(evidence!.object_key,'tampered');await assert.rejects(()=>recover(db,bucket),'corrupted stored timestamp evidence must not produce a success');await bucket.put(evidence!.object_key,evidenceBytes);assert.equal((await recover(db,bucket)).status,'SYNTHETIC_TSA_TEST_COMPLETED');
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
