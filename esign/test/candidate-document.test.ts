import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {exerciseCandidateSyntheticFinalization} from './candidate-synthetic-finalization-support.ts';

const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
test('private recipient reads only its OTP-verified current initial document',async()=>{
 const built=await build({entryPoints:['src/candidate-worker.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers'],plugins:[{name:'interleave-done-processing',setup(build){build.onLoad({filter:/positioned-v3-processing\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace("  if(recipientReplay)await db.batch([", "  if(recipientReplay){const mutation=await db.prepare('SELECT sql FROM test_done_interleave').first<{sql:string}>();if(mutation){await db.prepare('DELETE FROM test_done_interleave').run();await db.prepare(mutation.sql).run();}}\n  if(recipientReplay)await db.batch([").replace("  if(candidateGuard)await db.batch([candidateRecoveryAuthorizationAssertion(db,candidateGuard),candidateFacts(),","  if(candidateGuard){const mutation=await db.prepare('SELECT sql FROM test_done_interleave').first<{sql:string}>();if(mutation){await db.prepare('DELETE FROM test_done_interleave').run();await db.prepare(mutation.sql).run();}}\n  if(candidateGuard)await db.batch([candidateRecoveryAuthorizationAssertion(db,candidateGuard),candidateFacts(),").replace(' await db.batch([\n  ...(candidateGuard?', " if(recipientReplay && predecessor){const mutation=await db.prepare('SELECT sql FROM test_sign_replay_interleave').first<{sql:string}>();if(mutation){await db.prepare('DELETE FROM test_sign_replay_interleave').run();await db.prepare(mutation.sql).run();}}\n await db.batch([\n  ...(candidateGuard?").replace(" if(row.status==='DONE'){", " if(row.status==='DONE' && row.sequence===2){const mutation=await db.prepare('SELECT sql FROM test_second_done_interleave').first<{sql:string}>();if(mutation){await db.prepare('DELETE FROM test_second_done_interleave').run();await db.prepare(mutation.sql).run();}}\n if(row.status==='DONE'){"),loader:'ts'}));}},{name:'interleave-second-replay',setup(build){build.onLoad({filter:/candidate-sign\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(' if(predecessor)await db.batch(['," if(predecessor){const mutation=await db.prepare('SELECT sql FROM test_sign_replay_interleave').first<{sql:string}>();if(mutation){await db.prepare('DELETE FROM test_sign_replay_interleave').run();await db.prepare(mutation.sql).run();}}\n if(predecessor)await db.batch(["),loader:'ts'}));}},{name:'interleave-final-preview',setup(build){build.onLoad({filter:/candidate-worker\.ts$/},async args=>({contents:(`import {processCandidatePositionedV3Job} from './candidate-v3-processing.ts';\n` + (await readFile(args.path,'utf8')).replace('// Final preview validation.',`// Final preview validation.
        if(dateBinding) { const action=await db.prepare('SELECT action FROM test_preview_interleave').first<{action:string}>(); if(action) { await db.prepare('DELETE FROM test_preview_interleave').run(); if(action.action==='revoke') await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,1)').bind(tokenHash).run(); else if(action.action==='expire') await db.prepare('UPDATE positioned_v3_date_previews SET expires_at=0 WHERE session_hash=?').bind(tokenHash).run(); else if(action.action==='session-expire') await db.prepare('UPDATE recipient_page_sessions SET expires_at=0 WHERE token_hash=?').bind(tokenHash).run(); else if(action.action==='artifact') await db.prepare("UPDATE artifacts SET object_key='changed' WHERE id=?").bind(artifact.id).run(); } }`) + `\nexport class TestProcessor extends WorkerEntrypoint { async fetch(req) { try { await processCandidatePositionedV3Job(this.env.DB,this.env.ARTIFACTS,await req.text(),{keyHash:'key',tenantId:'a',envelopeId:'e',taskId:'t'}); return new Response('ok'); } catch { return new Response('failed',{status:503}); } } }`),loader:'ts'}));}}]});
 const mf=new Miniflare({workers:[{name:'caller',modules:true,script:'export default {fetch(r,e){return e.R.fetch(r)}}',serviceBindings:{R:{name:'candidate',entrypoint:'PrivateRecipient'}}},{name:'manager',modules:true,script:'export default {fetch(r,e){return e.R.fetch(r)}}',serviceBindings:{R:{name:'candidate',entrypoint:'PrivateManagement'}}},{name:'processor',modules:true,script:'export default {fetch(r,e){return e.R.fetch(r)}}',serviceBindings:{R:{name:'candidate',entrypoint:'TestProcessor'}}},{name:'candidate',modules:true,script:built.outputFiles[0].text,d1Databases:['DB'],r2Buckets:['ARTIFACTS']}]});
 try {
  const db=await mf.getD1Database('DB','candidate'),bucket=await mf.getR2Bucket('ARTIFACTS','candidate');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
  await db.exec('CREATE TABLE test_preview_interleave (action TEXT); CREATE TABLE test_done_interleave (sql TEXT); CREATE TABLE test_sign_replay_interleave (sql TEXT); CREATE TABLE test_second_done_interleave (sql TEXT)');
  const token='a'.repeat(64),th=await hash(token),origin='https://host.example.com';
  const doc=await PDFDocument.create();doc.addPage();const pdf=await doc.save();const pdfHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pdf)),b=>b.toString(16).padStart(2,'0')).join('');
  const fields=[{id:'sig',type:'Signature',role:'ana',page:1,required:true,rect:{x:0.1,y:0.1,width:0.3,height:0.1}},{id:'title',type:'Title',role:'ana',page:1,required:true,rect:{x:0.1,y:0.3,width:0.3,height:0.1}},{id:'date',type:'Date signed',role:'ana',page:1,required:true,rect:{x:0.5,y:0.3,width:0.3,height:0.1}},{id:'other',type:'Signature',role:'lee',page:1,required:true,rect:{x:0.1,y:0.5,width:0.3,height:0.1}},{id:'date2',type:'Date signed',role:'lee',page:1,required:true,rect:{x:0.5,y:0.5,width:0.3,height:0.1}}];
  await db.exec(`INSERT INTO tenants VALUES ('a'),('b'); INSERT INTO templates VALUES ('p','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO tasks VALUES ('t','e','ana','Ana','ana@example.com',1,'ACTIVE'); INSERT INTO tenant_page_origins VALUES ('a','${origin}'); INSERT INTO artifacts VALUES ('d0','e','document','${pdfHash}');`);
  await db.prepare('UPDATE templates SET roles_json=?,fields_json=?').bind(JSON.stringify(['ana','lee']),JSON.stringify(fields)).run();
  await bucket.put('document',pdf);
  await db.prepare("INSERT INTO recipient_page_sessions VALUES (?,?,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER)+800000)").bind(th,'a','e','t',origin).run();
  const request=(data:unknown)=>mf.dispatchFetch('https://caller.test/v1/document',{method:'POST',body:JSON.stringify(data)});
  const metadataRequest=(data:unknown)=>mf.dispatchFetch('https://caller.test/v1/fields',{method:'POST',body:JSON.stringify(data)});
  assert.notEqual((await request({token,origin})).status,200);assert.notEqual((await metadataRequest({token,origin})).status,200);
  await db.prepare("INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES ('t',?,1,'ana@example.com')").bind(th).run();
  const ok=await request({token,origin});assert.equal(ok.status,200);assert.deepEqual(new Uint8Array(await ok.arrayBuffer()),pdf);assert.equal(ok.headers.get('content-type'),'application/pdf');assert.equal(ok.headers.get('cache-control'),'no-store');
  const metadata=await metadataRequest({token,origin});assert.equal(metadata.status,200);assert.deepEqual(await metadata.json(),{artifactId:'d0',artifactHash:pdfHash,role:'ana',recipientName:'Ana',fields:fields.slice(0,3)});
  const preview=(data:unknown)=>mf.dispatchFetch('https://caller.test/v1/preview',{method:'POST',body:JSON.stringify(data)});
  const signature=await preview({token,origin,fieldId:'sig',text:'Ana'});assert.equal(signature.status,200);assert.equal(signature.headers.get('content-type'),'image/png');assert.ok(signature.headers.get('x-signature-preview'));const replay=await preview({token,origin,fieldId:'sig',text:'Ana'});assert.equal(replay.headers.get('x-signature-preview'),signature.headers.get('x-signature-preview'));const changed=await preview({token,origin,fieldId:'sig',text:'Anna'});assert.notEqual(changed.headers.get('x-signature-preview'),signature.headers.get('x-signature-preview'));
  const date=await preview({token,origin,fieldId:'date'});assert.equal(date.status,200);assert.match(date.headers.get('x-preview-text')!,/^\d{4}-\d{2}-\d{2}$/);assert.ok(date.headers.get('x-date-preview-id'));
  const dateId=date.headers.get('x-date-preview-id');
  const concurrent=await Promise.all(Array.from({length:5},()=>preview({token,origin,fieldId:'date'})));assert.ok(concurrent.every(r=>r.status===200&&r.headers.get('x-date-preview-id')===dateId));
  const stored=await db.prepare('SELECT * FROM positioned_v3_date_previews WHERE session_hash=?').bind(th).first<any>();assert.equal(stored.preview_id,dateId);assert.equal(stored.date_text,date.headers.get('x-preview-text'));assert.equal(stored.artifact_sha256,pdfHash);assert.ok(stored.geometry_json);assert.ok(stored.expires_at<=Date.now()+300000);
  // Deterministically change persisted state after the old final authorization read.
  for (const action of ['revoke','expire','session-expire','artifact']) {
   await db.prepare('INSERT INTO test_preview_interleave VALUES (?)').bind(action).run();
   assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200,`interleaved ${action}`);
   if(action==='revoke') { assert.ok(await db.prepare('SELECT 1 FROM recipient_session_revocations WHERE token_hash=?').bind(th).first()); await db.exec('DELETE FROM recipient_session_revocations'); }
   if(action==='session-expire') await db.exec("UPDATE recipient_page_sessions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+800000");
   if(action==='artifact') await db.exec("UPDATE artifacts SET object_key='document'");
  }
  // An update trigger models a competing change after the issuing write and before the final read.
  for (const mutation of ["preview_id='00000000-0000-0000-0000-000000000000'",'expires_at=0',"date_text='2000-01-01'"]) {
   await db.exec(`CREATE TRIGGER supersede_date AFTER UPDATE ON positioned_v3_date_previews BEGIN UPDATE positioned_v3_date_previews SET ${mutation} WHERE session_hash=NEW.session_hash AND field_id=NEW.field_id; END`);
   assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200,`superseded preview: ${mutation}`);
   await db.exec('DROP TRIGGER supersede_date');
  }
  assert.notEqual((await preview({token,origin,fieldId:'date',text:'2020-01-01'})).status,200);
  await db.exec("UPDATE positioned_v3_date_previews SET image_sha256='tampered'");const refreshed=await preview({token,origin,fieldId:'date'});assert.equal(refreshed.status,200);assert.notEqual(refreshed.headers.get('x-date-preview-id'),dateId);
  await db.exec('UPDATE positioned_v3_date_previews SET expires_at=0');const expired=await preview({token,origin,fieldId:'date'});assert.equal(expired.status,200);assert.notEqual(expired.headers.get('x-date-preview-id'),refreshed.headers.get('x-date-preview-id'));
  await db.exec("UPDATE positioned_v3_date_previews SET date_text='2000-01-01'");const staleDate=await preview({token,origin,fieldId:'date'});assert.equal(staleDate.status,200);assert.notEqual(staleDate.headers.get('x-date-preview-id'),expired.headers.get('x-date-preview-id'));
  await db.exec("UPDATE tasks SET role='lee'");assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200);await db.exec("UPDATE tasks SET role='ana'");
  await db.exec("UPDATE recipient_otp_verifications SET recipient_email='lee@example.test'");assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200);await db.exec("UPDATE recipient_otp_verifications SET recipient_email='ana@example.com'");
  const title=await preview({token,origin,fieldId:'title',text:'Director'});assert.equal(title.status,200);assert.ok(title.headers.get('x-text-preview'));
  const signBody={token,origin,artifactId:'d0',artifactHash:pdfHash,consent:true,idempotencyKey:'request_123',values:{sig:'Ana',title:'Director'},signaturePreviews:{sig:signature.headers.get('x-signature-preview')},textPreviews:{title:title.headers.get('x-text-preview')},datePreviewIds:{date:staleDate.headers.get('x-date-preview-id')}};
  const sign=(data:unknown)=>mf.dispatchFetch('https://caller.test/v1/sign',{method:'POST',body:JSON.stringify(data)});
  assert.equal((await sign({...signBody,consent:false})).status,400);
  for(const values of [{title:'Director'},{sig:'Ana!',title:'Director'},{sig:'Ana',title:'Director',other:'Lee'}]) assert.equal((await sign({...signBody,values})).status,400);
  assert.equal((await sign({...signBody,signaturePreviews:{sig:'wrong'}})).status,409);
  assert.equal((await sign({...signBody,textPreviews:{title:'wrong'}})).status,409);
  assert.equal((await sign({...signBody,signaturePreviews:{sig:'wrong',other:'extra'}})).status,400);
  assert.equal((await sign({...signBody,datePreviewIds:{date:'bad'}})).status,400);
  const badDate={...signBody,datePreviewIds:{date:'00000000-0000-0000-0000-000000000000'}};
  for(let i=0;i<3;i++) assert.equal((await sign(badDate)).status,400);
  assert.equal((await bucket.list({prefix:'envelopes/e/signature-images/'})).objects.length,0);
  await db.exec(`CREATE TRIGGER revoke_during_sign AFTER INSERT ON signature_records BEGIN INSERT INTO recipient_session_revocations VALUES (NEW.session_hash,1); END`);
  assert.notEqual((await sign(signBody)).status,202);
  for(const table of ['signature_records','signature_events','signature_jobs','positioned_signature_inputs','idempotency_keys','recipient_session_revocations']) assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<any>())!.n,0,table);
  await db.exec('DROP TRIGGER revoke_during_sign');
  const orphans=await bucket.list({prefix:'envelopes/e/signature-images/'});assert.equal(orphans.objects.length,3);
  await db.exec(`CREATE TRIGGER revoke_during_sign AFTER INSERT ON signature_records BEGIN INSERT INTO recipient_session_revocations VALUES (NEW.session_hash,1); END`);
  await Promise.all(Array.from({length:4},()=>sign(signBody)));assert.equal((await bucket.list({prefix:'envelopes/e/signature-images/'})).objects.length,3);
  await db.exec('DROP TRIGGER revoke_during_sign');
  await db.exec(`CREATE TRIGGER revoke_during_sign AFTER INSERT ON signature_records BEGIN INSERT INTO recipient_session_revocations VALUES (NEW.session_hash,1); END`);
  for(let i=0;i<2;i++) {
   const modified=fields.map(f=>f.id==='sig'?{...f,id:`sig${i}`}:f);
   await db.prepare('UPDATE templates SET fields_json=?').bind(JSON.stringify(modified)).run();
   const sp=await preview({token,origin,fieldId:`sig${i}`,text:'Ana'}),tp=await preview({token,origin,fieldId:'title',text:'Director'}),dp=await preview({token,origin,fieldId:'date'});
   assert.equal(sp.status,200);assert.equal(tp.status,200);assert.equal(dp.status,200);
   const changedBody={...signBody,values:{[`sig${i}`]:'Ana',title:'Director'},signaturePreviews:{[`sig${i}`]:sp.headers.get('x-signature-preview')},textPreviews:{title:tp.headers.get('x-text-preview')},datePreviewIds:{date:dp.headers.get('x-date-preview-id')}};
   await Promise.all(Array.from({length:3},()=>sign(changedBody)));
   assert.equal((await bucket.list({prefix:'envelopes/e/signature-images/'})).objects.length,6+3*i);
  }
  await db.prepare('UPDATE templates SET fields_json=?').bind(JSON.stringify(fields)).run();
  const restoredDate=await preview({token,origin,fieldId:'date'});signBody.datePreviewIds.date=restoredDate.headers.get('x-date-preview-id');
  const anna=await preview({token,origin,fieldId:'sig',text:'Anna'});
  const changedInput={...signBody,values:{sig:'Anna',title:'Director'},signaturePreviews:{sig:anna.headers.get('x-signature-preview')}};
  assert.notEqual((await sign(changedInput)).status,202);
  assert.equal((await bucket.list({prefix:'envelopes/e/signature-images/'})).objects.length,12);
  await db.exec('DROP TRIGGER revoke_during_sign');
  assert.equal((await (await mf.getWorker('manager')).fetch('https://manager.test/v1/sign',{method:'POST',body:JSON.stringify(signBody)})).status,404);
  assert.equal((await (await mf.getWorker('candidate')).fetch('https://candidate.test/v1/sign',{method:'POST',body:JSON.stringify(signBody)})).status,404);
  await db.exec("CREATE TRIGGER hold_output BEFORE INSERT ON signature_outputs BEGIN SELECT RAISE(ABORT,'hold processing'); END");
  const signed=await sign(signBody);assert.equal(signed.status,503);const result={signatureId:(await db.prepare('SELECT id FROM signature_records').first<{id:string}>())!.id,status:'PROCESSED_UNSEALED'};
  const retry=await sign(signBody);assert.equal(retry.status,503);
  assert.equal((await sign({...signBody,values:{sig:'Anna',title:'Director'}})).status,409);
  const imageKey=`envelopes/e/signature-images/${result.signatureId}/sig.png`;
  const originalImage=await (await bucket.get(imageKey))!.arrayBuffer();await bucket.put(imageKey,'tampered');
  await db.exec('DROP TRIGGER hold_output');
  assert.equal((await sign(signBody)).status,503,'pending image integrity failure is not accepted');
  assert.equal((await db.prepare("SELECT status FROM signature_jobs").first<{status:string}>())!.status,'PENDING');
  await bucket.put(imageKey,originalImage);
  await db.exec("CREATE TRIGGER hold_output BEFORE INSERT ON signature_outputs BEGIN SELECT RAISE(ABORT,'hold processing'); END");
  await bucket.put('document','tampered');assert.notEqual((await sign(signBody)).status,202);await bucket.put('document',pdf);
  const event=await db.prepare('SELECT * FROM signature_events').first<any>();await db.exec('DELETE FROM signature_events');assert.notEqual((await sign(signBody)).status,202);
  await db.prepare('INSERT INTO signature_events(signature_id,envelope_id,sequence,previous_hash,event_hash,event_version) VALUES (?,?,?,?,?,?)').bind(event.signature_id,event.envelope_id,event.sequence,event.previous_hash,event.event_hash,event.event_version).run();
  const captured=await db.prepare('SELECT * FROM positioned_signature_inputs').first<any>();await db.exec('DELETE FROM positioned_signature_inputs');assert.notEqual((await sign(signBody)).status,202);
  await db.prepare('INSERT INTO positioned_signature_inputs(signature_id,input_object_key,input_page_count,payload_json) VALUES (?,?,?,?)').bind(captured.signature_id,captured.input_object_key,captured.input_page_count,captured.payload_json).run();
  assert.equal((await db.prepare("SELECT count(*) AS n FROM signature_jobs WHERE status='PENDING'").first<any>())!.n,1);
  await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,1)').bind(th).run();assert.notEqual((await sign(signBody)).status,202);await db.exec('DELETE FROM recipient_session_revocations');
  await db.exec("INSERT INTO api_keys (key_hash,tenant_id) VALUES ('key','a')");
  const job=(await db.prepare('SELECT id FROM signature_jobs').first<{id:string}>())!.id;
  const managementToken='m'.repeat(64), managementHash=await hash(managementToken);
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?, 'a')").bind(managementHash).run();
  const lookup=async(credential=managementToken,path='/v1/envelopes/e/tasks/t/job')=>(await mf.getWorker('manager')).fetch(`https://manager.test${path}`,{headers:{authorization:`Bearer ${credential}`}});
  assert.equal((await lookup('x'.repeat(64))).status,401);
  assert.deepEqual(await (await lookup()).json(),{jobId:job});
  assert.notEqual((await lookup(managementToken,'/v1/envelopes/e/tasks/wrong/job')).status,200);
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(managementHash).run();assert.equal((await lookup()).status,401);await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(managementHash).run();
  const recoveryPath=`/v1/envelopes/e/tasks/t/jobs/${job}/recover`;
  const recover=async(path=recoveryPath,credential=managementToken)=>(await mf.getWorker('manager')).fetch(`https://manager.test${path}`,{method:'POST',headers:{authorization:`Bearer ${credential}`}});
  assert.equal((await recover(recoveryPath,'x'.repeat(64))).status,401);
  assert.notEqual((await recover(`/v1/envelopes/e/tasks/wrong/jobs/${job}/recover`)).status,200);
  assert.notEqual((await recover('/v1/envelopes/e/tasks/t/jobs/missing/recover')).status,200);
  const otherToken='n'.repeat(64);await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?, 'b')").bind(await hash(otherToken)).run();
  assert.notEqual((await recover(recoveryPath,otherToken)).status,200);assert.notEqual((await lookup(otherToken)).status,200);
  assert.equal((await (await mf.getWorker('manager')).fetch(`https://manager.test${recoveryPath}`,{method:'POST',headers:{authorization:`Bearer ${managementToken}`},body:'{}'})).status,400);
  assert.equal((await (await mf.getWorker('candidate')).fetch(`https://candidate.test${recoveryPath}`,{method:'POST',headers:{authorization:`Bearer ${managementToken}`}})).status,404);
  await db.exec('DROP TRIGGER hold_output');
  await db.exec(`CREATE TRIGGER revoke_route AFTER INSERT ON signature_outputs BEGIN UPDATE api_keys SET revoked_at=1 WHERE key_hash='${managementHash}'; END`);
  assert.equal((await recover()).status,503);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first<{n:number}>())!.n,0);
  await db.exec('DROP TRIGGER revoke_route');
  await bucket.put('document','tampered');assert.equal((await recover()).status,503);await bucket.put('document',pdf);
  await db.exec("CREATE TRIGGER status_processing AFTER INSERT ON signature_outputs BEGIN UPDATE tasks SET status='PENDING' WHERE id='t'; END");
  assert.equal((await recover()).status,503);assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='t'").first<{status:string}>())!.status,'SIGNED');
  await db.exec('DROP TRIGGER status_processing');
  // A distinct second signer must see the verified predecessor, never D0.
  const secondToken='b'.repeat(64),secondHash=await hash(secondToken);
  await db.exec("INSERT INTO tasks VALUES ('t2','e','lee','Lee','lee@example.com',2,'PENDING')");
  await db.prepare("INSERT INTO recipient_page_sessions VALUES (?,'a','e','t2',?,CAST(unixepoch('subsec')*1000 AS INTEGER)+800000)").bind(secondHash,origin).run();
  await db.prepare("INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES ('t2',?,1,'lee@example.com')").bind(secondHash).run();
  assert.notEqual((await request({token:secondToken,origin})).status,200,'pending second signer cannot read');
  // Concurrent pending recovery; discard one successful response and retry after commit.
  const pending=await Promise.all([recover(),recover()]);assert.ok(pending.every(r=>r.status===200));
  const recovered=await Promise.all([recover(),recover()]);assert.ok(recovered.every(r=>r.status===200));
  for(const response of recovered) assert.deepEqual(await response.json(),{status:'PROCESSED_UNSEALED'});
  assert.deepEqual(await (await recover()).json(),{status:'PROCESSED_UNSEALED'});
  const secondOutput=await db.prepare('SELECT artifact_id,sha256,object_key FROM signature_outputs WHERE job_id=?').bind(job).first<{artifact_id:string;sha256:string;object_key:string}>();
  const secondDocument=await request({token:secondToken,origin});assert.equal(secondDocument.status,200,'active second signer can read verified D1');
  assert.deepEqual(new Uint8Array(await secondDocument.arrayBuffer()),new Uint8Array(await (await bucket.get(secondOutput!.object_key))!.arrayBuffer()));
  const secondFields=await metadataRequest({token:secondToken,origin});assert.equal(secondFields.status,200);
  assert.deepEqual(await secondFields.json(),{artifactId:secondOutput!.artifact_id,artifactHash:secondOutput!.sha256,role:'lee',recipientName:'Lee',fields:fields.slice(3)});
  assert.equal((await preview({token:secondToken,origin,fieldId:'other',text:'Lee'})).status,200);
  assert.notEqual((await preview({token:secondToken,origin,fieldId:'sig',text:'Ana'})).status,200);
  const secondDate=await preview({token:secondToken,origin,fieldId:'date2'});assert.equal(secondDate.status,200);
  assert.notEqual((await request({token,origin})).status,200,'signed first signer cannot access second document');
  await db.prepare("UPDATE recipient_page_sessions SET expires_at=0 WHERE token_hash=?").bind(secondHash).run();assert.notEqual((await request({token:secondToken,origin})).status,200);await db.prepare("UPDATE recipient_page_sessions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+800000 WHERE token_hash=?").bind(secondHash).run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(secondHash,'b').run();assert.notEqual((await request({token:secondToken,origin})).status,200);await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(secondHash).run();
  const alteredFields=fields.map(f=>f.id==='other'?{...f,rect:{...f.rect,x:.2}}:f);await db.prepare('UPDATE templates SET fields_json=?').bind(JSON.stringify(alteredFields)).run();assert.notEqual((await metadataRequest({token:secondToken,origin})).status,200,'template must match captured predecessor');await db.prepare('UPDATE templates SET fields_json=?').bind(JSON.stringify(fields)).run();
  const secondDateRow=await db.prepare("SELECT artifact_id,artifact_sha256 FROM positioned_v3_date_previews WHERE session_hash=? AND field_id='date2'").bind(secondHash).first<any>();
  assert.deepEqual(secondDateRow,{artifact_id:secondOutput!.artifact_id,artifact_sha256:secondOutput!.sha256});
  assert.notEqual((await request({token:secondToken,origin:'https://other.example.com'})).status,200);
  await db.prepare("UPDATE recipient_page_sessions SET tenant_id='b' WHERE token_hash=?").bind(secondHash).run();assert.notEqual((await request({token:secondToken,origin})).status,200);await db.prepare("UPDATE recipient_page_sessions SET tenant_id='a' WHERE token_hash=?").bind(secondHash).run();
  await db.prepare("UPDATE recipient_otp_verifications SET recipient_email='ana@example.com' WHERE session_hash=?").bind(secondHash).run();assert.notEqual((await request({token:secondToken,origin})).status,200);await db.prepare("UPDATE recipient_otp_verifications SET recipient_email='lee@example.com' WHERE session_hash=?").bind(secondHash).run();
  const secondPdf=await (await bucket.get(secondOutput!.object_key))!.arrayBuffer();
  for(const [key,original] of [[secondOutput!.object_key,secondPdf],['document',pdf], [imageKey,originalImage]] as const){await bucket.put(key,'corrupt');for(const response of [await request({token:secondToken,origin}),await metadataRequest({token:secondToken,origin}),await preview({token:secondToken,origin,fieldId:'date2'})])assert.notEqual(response.status,200,key);await bucket.put(key,original);}
  const savedOutput=await db.prepare('SELECT * FROM signature_outputs WHERE job_id=?').bind(job).first<any>();
  await db.prepare('DELETE FROM signature_outputs WHERE job_id=?').bind(job).run();assert.notEqual((await request({token:secondToken,origin})).status,200,'missing predecessor output');
  await db.prepare('INSERT INTO signature_outputs(job_id,artifact_id,object_key,sha256) VALUES (?,?,?,?)').bind(savedOutput.job_id,savedOutput.artifact_id,savedOutput.object_key,savedOutput.sha256).run();
  const savedEvent=await db.prepare('SELECT * FROM signature_events WHERE signature_id=?').bind(result.signatureId).first<any>();
  await db.prepare('DELETE FROM signature_events WHERE signature_id=?').bind(result.signatureId).run();assert.notEqual((await request({token:secondToken,origin})).status,200,'missing predecessor event');
  await db.prepare('INSERT INTO signature_events(signature_id,envelope_id,sequence,previous_hash,event_hash,event_version) VALUES (?,?,?,?,?,?)').bind(savedEvent.signature_id,savedEvent.envelope_id,savedEvent.sequence,savedEvent.previous_hash,savedEvent.event_hash,savedEvent.event_version).run();
  const secondRaces=[
   ["UPDATE positioned_signature_inputs SET payload_json='{}'",'positioned_signature_inputs','payload_json'],
   ["UPDATE signature_events SET event_hash='changed'",'signature_events','event_hash'],
   ["UPDATE signature_outputs SET sha256='changed'",'signature_outputs','sha256'],
   ["UPDATE signature_jobs SET status='PENDING'",'signature_jobs','status'],
   ["UPDATE tasks SET status='PENDING' WHERE id='t2'",'tasks','status'],
   ["UPDATE recipient_page_sessions SET expires_at=0 WHERE task_id='t2'",'recipient_page_sessions','expires_at'],
   ["UPDATE recipient_otp_verifications SET recipient_email='ana@example.com' WHERE task_id='t2'",'recipient_otp_verifications','recipient_email']
  ];
  for(const [mutation,table,column] of secondRaces){
   const where=['tasks','recipient_page_sessions','recipient_otp_verifications'].includes(table)?(table==='tasks'?" WHERE id='t2'":" WHERE task_id='t2'"):'';
   const before=await db.prepare(`SELECT ${column} AS value FROM ${table}${where}`).first<any>();
   await db.prepare('INSERT INTO test_done_interleave VALUES (?)').bind(mutation).run();
   assert.notEqual((await request({token:secondToken,origin})).status,200,mutation);
   await db.prepare(`UPDATE ${table} SET ${column}=?${where}`).bind(before.value).run();
  }
  await db.prepare(`INSERT INTO test_done_interleave VALUES (?)`).bind(`INSERT INTO recipient_session_revocations VALUES ('${secondHash}',1)`).run();
  assert.notEqual((await preview({token:secondToken,origin,fieldId:'date2'})).status,200,'revocation after preview before final batch');
  await db.prepare('DELETE FROM recipient_session_revocations WHERE token_hash=?').bind(secondHash).run();
  assert.equal((await preview({token:secondToken,origin,fieldId:'date2'})).status,200);
  const leeSignature=await preview({token:secondToken,origin,fieldId:'other',text:'Lee'});
  const leeDate=await preview({token:secondToken,origin,fieldId:'date2'});
  const leeBody={token:secondToken,origin,artifactId:secondOutput!.artifact_id,artifactHash:secondOutput!.sha256,consent:true,idempotencyKey:'lee_request_123',values:{other:'Lee'},signaturePreviews:{other:leeSignature.headers.get('x-signature-preview')},datePreviewIds:{date2:leeDate.headers.get('x-date-preview-id')}};
  // D1 IDs are accepted only for the verified predecessor output.
  assert.equal((await sign({...leeBody,artifactId:'other:invalid'})).status,400);
  assert.equal((await sign({...leeBody,artifactId:`signed:${'a'.repeat(122)}`})).status,400);
  await db.exec("INSERT INTO tasks VALUES ('third','e','other','Other','other@example.com',3,'PENDING')");
  assert.notEqual((await sign(leeBody)).status,202,'exactly two tasks required');await db.exec("DELETE FROM tasks WHERE id='third'");
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?, 'b', 1)").bind(secondHash).run();
  assert.notEqual((await sign(leeBody)).status,202,'cross-tenant key collision');await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(secondHash).run();
  for(const mutation of ["UPDATE signature_outputs SET sha256='tampered'", `INSERT INTO recipient_session_revocations VALUES ('${secondHash}',1)`]){
   await db.exec(`CREATE TRIGGER tamper_reservation AFTER INSERT ON candidate_v3_attempt_slots WHEN NEW.task_id='t2' BEGIN ${mutation}; END`);
   assert.notEqual((await sign(leeBody)).status,202,mutation);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM candidate_v3_attempt_slots WHERE task_id='t2'").first<{n:number}>())!.n,0);
   assert.equal((await db.prepare('SELECT sha256 FROM signature_outputs WHERE job_id=?').bind(job).first<{sha256:string}>())!.sha256,savedOutput.sha256);
   assert.equal((await db.prepare('SELECT count(*) AS n FROM recipient_session_revocations WHERE token_hash=?').bind(secondHash).first<{n:number}>())!.n,0);
   await db.exec('DROP TRIGGER tamper_reservation');
  }
  for(const mutation of [
   "UPDATE signature_records SET consented_at=0 WHERE sequence=1",
   "UPDATE signature_events SET event_hash='tampered' WHERE sequence=1",
   "UPDATE positioned_signature_inputs SET payload_json='{}' WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)",
   "UPDATE tasks SET status='PENDING' WHERE id='t'",
   "UPDATE artifacts SET object_key='tampered' WHERE id='d0'",
   "UPDATE signature_jobs SET status='PENDING' WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)",
   "UPDATE signature_outputs SET sha256='tampered'",
   "UPDATE recipient_otp_verifications SET recipient_email='ana@example.com' WHERE task_id='t2'",
   "INSERT INTO recipient_session_revocations VALUES (NEW.session_hash,1)"
  ]) {
   await db.exec(`CREATE TRIGGER tamper_second AFTER INSERT ON signature_records WHEN NEW.sequence=2 BEGIN ${mutation}; END`);
   assert.notEqual((await sign(leeBody)).status,202,mutation);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM signature_records WHERE task_id='t2'").first<{n:number}>())!.n,0);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM signature_events WHERE sequence=2").first<{n:number}>())!.n,0);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key='candidate-v3-sign:lee_request_123'").first<{n:number}>())!.n,0);
   assert.equal((await db.prepare("SELECT count(*) AS n FROM recipient_session_revocations WHERE token_hash=?").bind(secondHash).first<{n:number}>())!.n,0);
   assert.equal((await db.prepare('SELECT event_hash FROM signature_events WHERE sequence=1').first<{event_hash:string}>())!.event_hash,savedEvent.event_hash);
   assert.equal((await db.prepare('SELECT sha256 FROM signature_outputs WHERE job_id=?').bind(job).first<{sha256:string}>())!.sha256,savedOutput.sha256);
   await db.exec('DROP TRIGGER tamper_second');
  }
  await db.exec("CREATE TRIGGER hold_second_output BEFORE INSERT ON signature_outputs BEGIN SELECT RAISE(ABORT,'hold processing'); END");
  const leeResponses=await Promise.all([sign(leeBody),sign(leeBody)]);
  assert.deepEqual(leeResponses.map(r=>r.status),[503,503],'concurrent exact second requests remain outcome-unknown');
  const leeResult={signatureId:(await db.prepare("SELECT id FROM signature_records WHERE task_id='t2'").first<{id:string}>())!.id,status:'PROCESSED_UNSEALED'};
  assert.equal((await sign(leeBody)).status,503);
  assert.equal((await sign({...leeBody,values:{other:'Lea'}})).status,409);
  const leeImageKey=`envelopes/e/signature-images/${leeResult.signatureId}/other.png`;
  const leeImage=await (await bucket.get(leeImageKey))!.arrayBuffer();
  for(const [key,original] of [[leeImageKey,leeImage],[secondOutput!.object_key,secondPdf],['document',pdf],[imageKey,originalImage]] as const){await bucket.put(key,'tampered');assert.notEqual((await sign(leeBody)).status,202,key);await bucket.put(key,original);}
  await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,1)').bind(secondHash).run();assert.notEqual((await sign(leeBody)).status,202);await db.prepare('DELETE FROM recipient_session_revocations WHERE token_hash=?').bind(secondHash).run();
  assert.equal((await sign(leeBody)).status,503);
  for(const [mutation,query,restore] of [
   ["UPDATE signature_records SET consented_at=0 WHERE sequence=1","SELECT consented_at AS value FROM signature_records WHERE sequence=1","UPDATE signature_records SET consented_at=? WHERE sequence=1"],
   ["UPDATE signature_events SET event_hash='tampered' WHERE sequence=1","SELECT event_hash AS value FROM signature_events WHERE sequence=1","UPDATE signature_events SET event_hash=? WHERE sequence=1"],
   ["UPDATE positioned_signature_inputs SET payload_json='{}' WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)","SELECT payload_json AS value FROM positioned_signature_inputs WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)","UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)"],
   ["UPDATE signature_jobs SET status='PENDING' WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)","SELECT status AS value FROM signature_jobs WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)","UPDATE signature_jobs SET status=? WHERE signature_id IN (SELECT id FROM signature_records WHERE sequence=1)"],
   ["UPDATE signature_outputs SET sha256='tampered'","SELECT sha256 AS value FROM signature_outputs","UPDATE signature_outputs SET sha256=?"],
   ["UPDATE artifacts SET object_key='tampered' WHERE id='d0'","SELECT object_key AS value FROM artifacts WHERE id='d0'","UPDATE artifacts SET object_key=? WHERE id='d0'"],
   ["UPDATE tasks SET status='PENDING' WHERE id='t2'","SELECT status AS value FROM tasks WHERE id='t2'","UPDATE tasks SET status=? WHERE id='t2'"],
   ["UPDATE recipient_page_sessions SET expires_at=0 WHERE task_id='t2'","SELECT expires_at AS value FROM recipient_page_sessions WHERE task_id='t2'","UPDATE recipient_page_sessions SET expires_at=? WHERE task_id='t2'"],
   ["UPDATE recipient_otp_verifications SET verified_at=0 WHERE task_id='t2'","SELECT verified_at AS value FROM recipient_otp_verifications WHERE task_id='t2'","UPDATE recipient_otp_verifications SET verified_at=? WHERE task_id='t2'"],
   ["UPDATE signature_records SET consented_at=0 WHERE sequence=2","SELECT consented_at AS value FROM signature_records WHERE sequence=2","UPDATE signature_records SET consented_at=? WHERE sequence=2"],
   ["UPDATE idempotency_keys SET request_hash='tampered' WHERE idempotency_key='candidate-v3-sign:lee_request_123'","SELECT request_hash AS value FROM idempotency_keys WHERE idempotency_key='candidate-v3-sign:lee_request_123'","UPDATE idempotency_keys SET request_hash=? WHERE idempotency_key='candidate-v3-sign:lee_request_123'"]
  ]){
   const before=await db.prepare(query).first<{value:string|number}>();await db.prepare('INSERT INTO test_sign_replay_interleave VALUES (?)').bind(mutation).run();
   assert.notEqual((await sign(leeBody)).status,202,mutation);assert.equal(await db.prepare('SELECT 1 FROM test_sign_replay_interleave').first(),null);
   await db.prepare(restore).bind(before!.value).run();
  }
  await db.prepare('INSERT INTO test_sign_replay_interleave VALUES (?)').bind(`INSERT INTO recipient_session_revocations VALUES ('${secondHash}',1)`).run();
  assert.notEqual((await sign(leeBody)).status,202,'revocation after predecessor verification');
  assert.equal(await db.prepare('SELECT 1 FROM test_sign_replay_interleave').first(),null);
  await db.prepare('DELETE FROM recipient_session_revocations WHERE token_hash=?').bind(secondHash).run();
  assert.equal((await db.prepare("SELECT count(*) AS n FROM signature_records WHERE task_id='t2'").first<{n:number}>())!.n,1);
  const secondJob=(await db.prepare('SELECT id FROM signature_jobs WHERE signature_id=?').bind(leeResult.signatureId).first<{id:string}>())!.id;
  const secondLookup=await lookup(managementToken,'/v1/envelopes/e/tasks/t2/job');
  assert.equal(secondLookup.status,200,'management can discover the second pending job');
  assert.deepEqual(await secondLookup.json(),{jobId:secondJob});
  const secondPath=`/v1/envelopes/e/tasks/t2/jobs/${secondJob}/recover`;
  const secondRecover=()=>recover(secondPath);
  assert.notEqual((await recover(secondPath,secondToken)).status,200,'recipient token is not management authority');
  assert.notEqual((await recover(`/v1/envelopes/e/tasks/t/jobs/${secondJob}/recover`)).status,200,'wrong task');
  for(const [key,original] of [[leeImageKey,leeImage],[secondOutput!.object_key,secondPdf],['document',pdf],[imageKey,originalImage]] as const){
   await bucket.put(key,'tampered');assert.equal((await secondRecover()).status,503,key);await bucket.put(key,original);
  }
  await db.exec('DROP TRIGGER hold_second_output');
  for(const mutation of [
   `UPDATE api_keys SET revoked_at=1 WHERE key_hash='${managementHash}'`,
   "UPDATE signature_events SET event_hash='tampered' WHERE sequence=1",
   "UPDATE signature_outputs SET sha256='tampered' WHERE job_id IN (SELECT j.id FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id WHERE r.sequence=1)",
   "UPDATE signature_records SET consented_at=0 WHERE sequence=2"
  ]){
   await db.exec(`CREATE TRIGGER tamper_second_processing AFTER INSERT ON signature_outputs WHEN NEW.job_id='${secondJob}' BEGIN ${mutation}; END`);
   assert.equal((await secondRecover()).status,503,mutation);
   assert.equal((await db.prepare('SELECT status FROM signature_jobs WHERE id=?').bind(secondJob).first<{status:string}>())!.status,'PENDING');
   assert.equal(await db.prepare('SELECT 1 FROM signature_outputs WHERE job_id=?').bind(secondJob).first(),null);
   assert.equal((await db.prepare('SELECT event_hash FROM signature_events WHERE sequence=1').first<{event_hash:string}>())!.event_hash,savedEvent.event_hash);
   assert.equal((await db.prepare('SELECT sha256 FROM signature_outputs WHERE job_id=?').bind(job).first<{sha256:string}>())!.sha256,savedOutput.sha256);
   await db.exec('DROP TRIGGER tamper_second_processing');
  }
  const processedSecond=await Promise.all([secondRecover(),secondRecover()]);
  assert.ok(processedSecond.every(r=>r.status===200),'concurrent recovery verifies the same D2');
  for(const response of processedSecond) assert.deepEqual(await response.json(),{status:'PROCESSED_UNSEALED'});
  assert.equal((await db.prepare('SELECT status FROM signature_jobs WHERE id=?').bind(secondJob).first<{status:string}>())!.status,'DONE');
  assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='e'").first<{status:string}>())!.status,'FINALIZING');
  assert.deepEqual(await (await sign(leeBody)).json(),leeResult,'exact recipient retry after recovery');
  assert.equal((await sign({...leeBody,values:{other:'Lea'}})).status,409);
  assert.equal((await secondRecover()).status,200,'lost recovery response retry');
  for(const mutation of [
   "UPDATE signature_events SET event_hash='tampered' WHERE sequence=1",
   "UPDATE signature_records SET consented_at=0 WHERE sequence=2",
   `UPDATE api_keys SET revoked_at=1 WHERE key_hash='${managementHash}'`
  ]){
   const query=mutation.includes('signature_events')?"SELECT event_hash AS value FROM signature_events WHERE sequence=1":mutation.includes('signature_records')?"SELECT consented_at AS value FROM signature_records WHERE sequence=2":`SELECT revoked_at AS value FROM api_keys WHERE key_hash='${managementHash}'`;
   const restore=mutation.includes('signature_events')?"UPDATE signature_events SET event_hash=? WHERE sequence=1":mutation.includes('signature_records')?"UPDATE signature_records SET consented_at=? WHERE sequence=2":`UPDATE api_keys SET revoked_at=? WHERE key_hash='${managementHash}'`;
   const before=await db.prepare(query).first<{value:string|number|null}>();
   await db.prepare('INSERT INTO test_second_done_interleave VALUES (?)').bind(mutation).run();
   assert.equal((await secondRecover()).status,503,`DONE interleave: ${mutation}`);
   await db.prepare(restore).bind(before!.value).run();
  }
  for(const [mutation,query,restore] of [
   ["UPDATE signature_events SET event_hash='tampered' WHERE sequence=1","SELECT event_hash AS value FROM signature_events WHERE sequence=1","UPDATE signature_events SET event_hash=? WHERE sequence=1"],
   ["UPDATE signature_records SET consented_at=0 WHERE sequence=2","SELECT consented_at AS value FROM signature_records WHERE sequence=2","UPDATE signature_records SET consented_at=? WHERE sequence=2"]
  ]){
   const before=await db.prepare(query).first<{value:string|number}>();
   await db.prepare('INSERT INTO test_second_done_interleave VALUES (?)').bind(mutation).run();
   assert.notEqual((await sign(leeBody)).status,202,`recipient DONE interleave: ${mutation}`);
   await db.prepare(restore).bind(before!.value).run();
  }
  await db.prepare('INSERT INTO test_second_done_interleave VALUES (?)').bind(`INSERT INTO recipient_session_revocations VALUES ('${secondHash}',1)`).run();
  assert.notEqual((await sign(leeBody)).status,202,'DONE replay rechecks recipient revocation');
  await db.prepare('DELETE FROM recipient_session_revocations WHERE token_hash=?').bind(secondHash).run();
  const d2=(await db.prepare('SELECT object_key FROM signature_outputs WHERE job_id=?').bind(secondJob).first<{object_key:string}>())!.object_key;
  const d2Bytes=await (await bucket.get(d2))!.arrayBuffer();
  await bucket.put(d2,'tampered');assert.equal((await secondRecover()).status,503);assert.notEqual((await sign(leeBody)).status,202);await bucket.put(d2,d2Bytes);
  await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,1)').bind(secondHash).run();
  assert.notEqual((await sign(leeBody)).status,202,'recipient revocation blocks recipient retry');
  assert.equal((await secondRecover()).status,200,'recipient revocation does not revoke management');
  await db.prepare('DELETE FROM recipient_session_revocations WHERE token_hash=?').bind(secondHash).run();
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(managementHash).run();
  assert.notEqual((await secondRecover()).status,200,'management revocation blocks recovery');
  assert.equal((await sign(leeBody)).status,202,'management revocation does not revoke recipient');
  await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(managementHash).run();
  await exerciseCandidateSyntheticFinalization(db,bucket,managementToken,managementHash,d2);
  await db.prepare('DELETE FROM signature_outputs WHERE job_id=?').bind(secondJob).run();
  await db.exec("DELETE FROM signature_jobs WHERE signature_id IN (SELECT id FROM signature_records WHERE task_id='t2'); DELETE FROM signature_events WHERE signature_id IN (SELECT id FROM signature_records WHERE task_id='t2'); DELETE FROM positioned_signature_inputs WHERE signature_id IN (SELECT id FROM signature_records WHERE task_id='t2'); DELETE FROM signature_records WHERE task_id='t2'; DELETE FROM positioned_v3_date_previews WHERE field_id='date2'; DELETE FROM recipient_otp_verifications WHERE task_id='t2'; DELETE FROM recipient_page_sessions WHERE task_id='t2'; DELETE FROM tasks WHERE id='t2'; UPDATE envelopes SET status='FINALIZING'");
  const processedRetry=await sign(signBody);assert.equal(processedRetry.status,202);assert.deepEqual(await processedRetry.json(),result);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first<{n:number}>())!.n,1);
  await db.exec("UPDATE tasks SET status='PENDING' WHERE id='t'");assert.notEqual((await sign(signBody)).status,202);await db.exec("UPDATE tasks SET status='SIGNED' WHERE id='t'");
  const output=await db.prepare('SELECT object_key FROM signature_outputs').first<{object_key:string}>();
  await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,1)').bind(th).run();assert.notEqual((await sign(signBody)).status,202);await db.exec('DELETE FROM recipient_session_revocations');
  assert.equal((await sign({...signBody,values:{sig:'Anna',title:'Director'}})).status,409);
  const outputBytes=await (await bucket.get(output!.object_key))!.arrayBuffer();await bucket.put(output!.object_key,'corrupt');
  assert.notEqual((await sign(signBody)).status,202);
  assert.equal((await recover()).status,503);await bucket.put(output!.object_key,outputBytes);
  assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='e'").first<{status:string}>())!.status,'FINALIZING');
  await db.exec("DELETE FROM signature_outputs; UPDATE signature_jobs SET status='PENDING'; UPDATE envelopes SET status='IN_PROGRESS'");
  const process=async()=>(await mf.getWorker('processor')).fetch('https://processor.test/',{method:'POST',body:job});
  await db.exec("CREATE TRIGGER revoke_processing AFTER INSERT ON signature_outputs BEGIN UPDATE api_keys SET revoked_at=1 WHERE key_hash='key'; END");
  assert.equal((await process()).status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first<{n:number}>())!.n,0);assert.equal((await db.prepare("SELECT status FROM signature_jobs WHERE id=?").bind(job).first<{status:string}>())!.status,'PENDING');
  await db.exec('DROP TRIGGER revoke_processing');
  await db.exec("CREATE TRIGGER corrupt_processing AFTER INSERT ON signature_outputs BEGIN UPDATE positioned_signature_inputs SET payload_json='{}'; END");
  assert.equal((await process()).status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first<{n:number}>())!.n,0);
  assert.equal((await db.prepare('SELECT payload_json FROM positioned_signature_inputs').first<{payload_json:string}>())!.payload_json,captured.payload_json);
  await db.exec('DROP TRIGGER corrupt_processing');
  for(const mutation of ["UPDATE signature_records SET otp_recipient_email=NULL", "UPDATE recipient_otp_verifications SET verified_at=verified_at+1"]) {
   await db.exec(`CREATE TRIGGER corrupt_otp_processing AFTER INSERT ON signature_outputs BEGIN ${mutation}; END`);
   assert.equal((await process()).status,503,mutation);
   assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first<{n:number}>())!.n,0);
   await db.exec('DROP TRIGGER corrupt_otp_processing');
  }
  await bucket.put('document','tampered');assert.equal((await process()).status,503);await bucket.put('document',pdf);
  const processed=await Promise.all([process(),process()]);assert.ok(processed.some(r=>r.status===200));assert.equal((await db.prepare('SELECT status FROM signature_jobs WHERE id=?').bind(job).first<{status:string}>())!.status,'DONE');
  assert.equal((await process()).status,200);
  const mutations=[
   ["UPDATE signature_records SET otp_recipient_email=NULL",'signature_records','otp_recipient_email'],
   ["UPDATE recipient_otp_verifications SET verified_at=verified_at+1",'recipient_otp_verifications','verified_at'],
   ["UPDATE positioned_signature_inputs SET payload_json='{}'",'positioned_signature_inputs','payload_json'],
   ["UPDATE tasks SET status='PENDING'",'tasks','status'],
   ["UPDATE signature_events SET event_hash='changed'",'signature_events','event_hash'],
   ["UPDATE signature_records SET recipient_name='Changed'",'signature_records','recipient_name'],
   ["UPDATE artifacts SET object_key='changed'",'artifacts','object_key'],
   ["UPDATE signature_jobs SET status='PENDING'",'signature_jobs','status'],
   ["UPDATE signature_outputs SET sha256='changed'",'signature_outputs','sha256'],
   ["UPDATE api_keys SET revoked_at=1 WHERE key_hash='key'",'api_keys','revoked_at']
  ];
  for(const [mutation,table,column] of mutations){
   const before=await db.prepare(`SELECT ${column} AS value FROM ${table}${table==='api_keys'?" WHERE key_hash='key'":''}`).first<{value:string|null}>();
   await db.prepare('INSERT INTO test_done_interleave VALUES (?)').bind(mutation).run();
   assert.equal((await process()).status,503,mutation);
   await db.prepare(`UPDATE ${table} SET ${column}=?${table==='api_keys'?" WHERE key_hash='key'":''}`).bind(before!.value).run();
  }
  await db.exec("UPDATE api_keys SET revoked_at=1 WHERE key_hash='key'");assert.equal((await process()).status,503);
  await db.exec("DELETE FROM signature_outputs; DELETE FROM idempotency_keys; DELETE FROM signature_jobs; DELETE FROM signature_events; DELETE FROM positioned_signature_inputs; DELETE FROM signature_records; UPDATE tasks SET status='ACTIVE'; UPDATE envelopes SET status='IN_PROGRESS'");

  assert.notEqual((await preview({token,origin,fieldId:'other',text:'Lee'})).status,200);
  assert.notEqual((await preview({token,origin,fieldId:'title',text:' Director'})).status,200);
  assert.notEqual((await request({token,origin:'https://other.example.com'})).status,200);
  assert.notEqual((await request({token,origin,artifactId:'other'})).status,200);
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?, ?, 1)').bind(th,'b').run();assert.notEqual((await request({token,origin})).status,200);await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(th).run();
  await db.exec("UPDATE recipient_otp_verifications SET recipient_email='lee@example.test'");assert.notEqual((await request({token,origin})).status,200);await db.exec("UPDATE recipient_otp_verifications SET recipient_email='ana@example.com'");
  await db.exec("UPDATE recipient_page_sessions SET expires_at=0");assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200);assert.notEqual((await preview({token,origin,fieldId:'sig',text:'Ana'})).status,200);assert.notEqual((await request({token,origin})).status,200);await db.exec("UPDATE recipient_page_sessions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+800000");
  await db.exec("UPDATE recipient_page_sessions SET tenant_id='b'");assert.notEqual((await request({token,origin})).status,200);await db.exec("UPDATE recipient_page_sessions SET tenant_id='a'");
  await db.exec("UPDATE tasks SET status='PENDING'");assert.notEqual((await request({token,origin})).status,200);await db.exec("UPDATE tasks SET status='ACTIVE'");
  await db.exec("DELETE FROM tenant_page_origins");assert.notEqual((await request({token,origin})).status,200);await db.exec(`INSERT INTO tenant_page_origins VALUES ('a','${origin}')`);
  await db.exec("UPDATE recipient_page_sessions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+1000000");assert.notEqual((await request({token,origin})).status,200);await db.exec("UPDATE recipient_page_sessions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+800000");
  await db.prepare("INSERT INTO signature_records(id,envelope_id,task_id,sequence,session_hash,recipient_name,input_artifact_id,input_sha256,otp_verified_at,consented_at) VALUES ('r','e','t',1,?,'Ana','d0',?,1,1)").bind(th,pdfHash).run();assert.notEqual((await request({token,origin})).status,200);await db.exec('DELETE FROM signature_records');
  await bucket.put('document','tampered');assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200);assert.notEqual((await preview({token,origin,fieldId:'sig',text:'Ana'})).status,200);assert.notEqual((await request({token,origin})).status,200);assert.notEqual((await metadataRequest({token,origin})).status,200);
  await bucket.put('document',pdf); await db.prepare('INSERT INTO recipient_session_revocations VALUES (?,1)').bind(th).run();assert.notEqual((await preview({token,origin,fieldId:'date'})).status,200);assert.notEqual((await metadataRequest({token,origin})).status,200);assert.notEqual((await preview({token,origin,fieldId:'sig',text:'Ana'})).status,200);
  const publicWorker=await mf.getWorker('candidate');assert.equal((await publicWorker.fetch('https://candidate.test/v1/document',{method:'POST'})).status,404);assert.equal((await publicWorker.fetch('https://candidate.test/v1/fields',{method:'POST'})).status,404);assert.equal((await publicWorker.fetch('https://candidate.test/v1/preview',{method:'POST'})).status,404);
 }finally{await mf.dispose();}
});
