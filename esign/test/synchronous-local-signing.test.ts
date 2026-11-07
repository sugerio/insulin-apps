import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { issueRecipientCode, exchangeRecipientCode, sendRecipientOtp, verifyRecipientOtp } from '../src/page-authorization.ts';

const candidate = await import('../src/synchronous-local-signing.ts').catch(() => ({}));

test('local synchronous fieldless signing resumes after lost PDF and evidence responses', async () => {
  assert.equal(typeof candidate.signSynchronouslyLocalTest, 'function');
  const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("ok")}}', d1Databases:['DB'], r2Buckets:['ARTIFACTS'] });
  try {
    const db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS');
    for(const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0004_artifacts.sql','0006_page_authorization.sql','0007_signature_records.sql','0008_signature_events.sql','0009_otp_lifecycle.sql','0025_otp_recipient_binding.sql','0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql','0026_signature_otp_recipient.sql','0010_local_test_evidence.sql','0011_signature_layout.sql','0012_signature_input_layouts.sql','0017_positioned_signatures.sql', '0050_task_expiry.sql']) {
      const sql=await readFile(new URL(`../migrations/${name}`, import.meta.url),'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    await db.exec("ALTER TABLE templates ADD COLUMN fields_json TEXT NOT NULL DEFAULT '[]'");
    const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    await bucket.put('d0.pdf',bytes);
    await db.exec(`INSERT INTO tenants VALUES ('a'); INSERT INTO templates VALUES ('template','a','source','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('env','a','template','IN_PROGRESS',1); INSERT INTO tasks VALUES ('ana','env','ana','Ana','ana@example.com',1,'ACTIVE'); INSERT INTO artifacts VALUES ('d0','env','d0.pdf','${hash}'); INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com');`);
    const origin='https://host.example.com', code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'env',taskId:'ana',origin,now:1000}), token=await exchangeRecipientCode(db,code,origin,1001);
    const pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes'); let otp='';
    await sendRecipientOtp(db,token,origin,1002,pepper,async (_to,value)=>{otp=value;});
    assert.equal(await verifyRecipientOtp(db,token,origin,1003,pepper,otp),true);
    const cmd={token,origin,now:1004,artifactId:'d0',artifactHash:hash,consent:true};
    const sealKey=new TextEncoder().encode('local-test-seal-key-at-least-32-bytes');
    let failure='pdf';
    const unreliable=new Proxy(bucket,{get(target,key){
      if(key==='put') return async (...args:Parameters<typeof bucket.put>)=>{const result=await target.put(...args);if((failure==='pdf' && args[0].endsWith('.pdf') && args[0]!=='d0.pdf') || (failure==='evidence' && args[0].endsWith('local-test-evidence.json'))) { failure=''; throw new Error('response lost'); }return result;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    let loseCommit=true;
    const ambiguousDb=new Proxy(db,{get(target,key){
      if(key==='batch') return async (statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(loseCommit){loseCommit=false;throw new Error('commit response lost');}return result;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(()=>candidate.signSynchronouslyLocalTest!(ambiguousDb,unreliable,cmd,sealKey),/response lost/);
    assert.equal(loseCommit,false);
    assert.equal((await db.prepare('SELECT status FROM signature_jobs').first())!.status,'PENDING');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n,1);
    await assert.rejects(()=>candidate.signSynchronouslyLocalTest!(db,bucket,{...cmd,artifactHash:'0'.repeat(64)},sealKey));
    failure='evidence';
    await assert.rejects(()=>candidate.signSynchronouslyLocalTest!(db,unreliable,cmd,sealKey),/response lost/);
    assert.equal((await db.prepare('SELECT status FROM signature_jobs').first())!.status,'DONE');
    assert.equal((await db.prepare('SELECT status FROM envelopes').first())!.status,'FINALIZING');
    const [result, concurrent]=await Promise.all([candidate.signSynchronouslyLocalTest!(db,bucket,cmd,sealKey),candidate.signSynchronouslyLocalTest!(db,bucket,cmd,sealKey)]);
    assert.equal(result.mode,'LOCAL_TEST_ONLY');
    assert.equal(result.status,'COMPLETED_LOCAL_TEST');
    assert.deepEqual(concurrent,result);
    const again=await candidate.signSynchronouslyLocalTest!(db,bucket,cmd,sealKey);
    assert.deepEqual(again,result);
    await assert.rejects(()=>candidate.signSynchronouslyLocalTest!(db,bucket,{...cmd,now:9999999},sealKey));
    const output=await db.prepare('SELECT object_key FROM signature_outputs').first<{object_key:string}>();
    await bucket.put(output!.object_key,'tampered');
    await assert.rejects(()=>candidate.signSynchronouslyLocalTest!(db,bucket,cmd,sealKey),/integrity/);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n,1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM local_test_evidence').first())!.n,1);
    await assert.rejects(()=>candidate.signSynchronouslyLocalTest!(db,bucket,{...cmd,origin:'https://other.example.com'},sealKey));
  } finally {await mf.dispose();}
});
