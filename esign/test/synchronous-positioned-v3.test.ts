import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {issueRecipientCode,exchangeRecipientCode,sendRecipientOtp,verifyRecipientOtp} from '../src/page-authorization.ts';
import {renderTypedSignature} from '../src/typed-signature-image.ts';
import {renderPositionedV3Text} from '../src/positioned-v3-text-render.ts';
import {signatureGeometry} from '../src/positioned-signature-geometry.ts';
import {positionedV3TextGeometry} from '../src/positioned-v3-text-fit.ts';
import {signaturePreviewHash} from '../src/positioned-signature-preview.ts';
const module=await import('../src/synchronous-positioned-v3.ts').catch(()=>({}));
const hash=async(b:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(b))).toString('hex');

test('two v3 signers synchronously retry persisted key and recover lost PDF response',async()=>{
 assert.equal(typeof module.signPositionedV3SynchronouslyLocalTest,'function');
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
  let artifactId='d0',artifactHash=h0;const sealKey=new TextEncoder().encode('local-test-seal-key-at-least-32-bytes');
  for(const [index,role] of roles.entries()){
   const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'tenant',envelopeId:'env',taskId:role,origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1),pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');let otp='';
   await sendRecipientOtp(db,token,origin,now+2,pepper,async(_email,value)=>{otp=value;});assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),true);
   const sig=fields.find(f=>f.id===`sig-${role}`)!,title=fields.find(f=>f.id===`title-${role}`)!,dateField=fields.find(f=>f.id===`date-${role}`)!;
   const name=role.toUpperCase(),titleText='Director',date=new Date(now+4).toISOString().slice(0,10),sigImage=await renderTypedSignature(name),titleImage=await renderPositionedV3Text(titleText),dateImage=await renderPositionedV3Text(date),previewId=crypto.randomUUID();
   const signaturePreviews={[sig.id]:await signaturePreviewHash(artifactHash,rolesJson,fieldsJson,sig.id,name,await hash(sigImage),signatureGeometry(pdf.getPage(0),sig,sigImage))};
   const textPreviews={[title.id]:await signaturePreviewHash(artifactHash,rolesJson,fieldsJson,title.id,titleText,await hash(titleImage),positionedV3TextGeometry(pdf.getPage(0),title,titleImage))};
   await db.prepare('INSERT INTO positioned_v3_date_previews(session_hash,field_id,preview_id,date_text,image_sha256,artifact_id,artifact_sha256,roles_json,fields_json,expires_at,geometry_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(await hash(new TextEncoder().encode(token)),dateField.id,previewId,date,await hash(dateImage),artifactId,artifactHash,rolesJson,fieldsJson,now+300000,JSON.stringify(positionedV3TextGeometry(pdf.getPage(0),dateField,dateImage))).run();
   const cmd={token,origin,now:now+4,artifactId,artifactHash,consent:true,values:{[sig.id]:name,[title.id]:titleText},datePreviewIds:{[dateField.id]:previewId},signaturePreviews,textPreviews,idempotencyKey:`synthetic-${role}-key`};
   if(index===1){await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(db,bucket,{...cmd,idempotencyKey:'synthetic-ana-key'},sealKey),/Idempotency conflict/);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,1);}
   let lose=true;const unreliable=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(lose&&args[0].includes('/signed:')){lose=false;throw new Error('PDF response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   if(index===0){
    const attempts=await Promise.allSettled([module.signPositionedV3SynchronouslyLocalTest!(db,unreliable,cmd,sealKey),module.signPositionedV3SynchronouslyLocalTest!(db,unreliable,cmd,sealKey)]);
    assert.ok(attempts.some(x=>x.status==='rejected'),'lost output response must surface');
    assert.equal(lose,false);
   }else{
    let lostCommit=true;
    const ambiguousDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(lostCommit){lostCommit=false;throw new Error('commit response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(ambiguousDb,unreliable,cmd,sealKey),/response lost/);
    assert.equal(lostCommit,false);
   }
   assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,index+1);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key LIKE 'local-v3-sign:%'").first())!.n,index+1);
   if(index===1){
    let lostEvidence=true;const evidenceBucket=new Proxy(bucket,{get(target,key){if(key==='put')return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if(lostEvidence&&args[0].endsWith('local-test-evidence.json')){lostEvidence=false;throw new Error('evidence response lost');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(db,evidenceBucket,cmd,sealKey),/evidence response lost/);
    assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');
   }
   const [result,again]=await Promise.all([module.signPositionedV3SynchronouslyLocalTest!(db,bucket,cmd,sealKey),module.signPositionedV3SynchronouslyLocalTest!(db,bucket,cmd,sealKey)]);
   assert.deepEqual(result,again);assert.equal(result.status,index?'COMPLETED_LOCAL_TEST':'IN_PROGRESS');
   await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(db,bucket,{...cmd,values:{...cmd.values,[title.id]:'Changed'}},sealKey));
   await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(db,bucket,{...cmd,idempotencyKey:'different-key'},sealKey));
   await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(db,bucket,{...cmd,origin:'https://other.example.com'},sealKey));
   await assert.rejects(()=>module.signPositionedV3SynchronouslyLocalTest!(db,bucket,{...cmd,now:now+99999999},sealKey));
   const output=await db.prepare('SELECT o.artifact_id,o.sha256 FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id WHERE j.signature_id=?').bind(result.signatureId).first<{artifact_id:string;sha256:string}>();artifactId=output!.artifact_id;artifactHash=output!.sha256;
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM local_test_evidence').first())!.n,1);
 }finally{await mf.dispose();}
});
