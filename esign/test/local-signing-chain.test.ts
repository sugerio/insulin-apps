import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { issueRecipientCode, exchangeRecipientCode, sendRecipientOtp, verifyRecipientOtp } from '../src/page-authorization.ts';
import { recordSignature } from '../src/signature-record.ts';
import { processSignatureJob } from '../src/signature-processing.ts';

test('local primitives chain Ana D0 to D1 and Marcus D1 to D2 without overwriting', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
  try {
    const db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0004_artifacts.sql','0006_page_authorization.sql','0007_signature_records.sql','0011_signature_layout.sql','0012_signature_input_layouts.sql','0008_signature_events.sql','0009_otp_lifecycle.sql','0025_otp_recipient_binding.sql','0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql','0026_signature_otp_recipient.sql','0017_positioned_signatures.sql', '0050_task_expiry.sql']) {
      const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    const pdf=await PDFDocument.create();pdf.addPage().drawText('Electronic signature - forged layout');const d0=await pdf.save();
    const h0=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',d0)),n=>n.toString(16).padStart(2,'0')).join('');
    await db.exec(`INSERT INTO tenants VALUES ('a');
INSERT INTO templates VALUES ('template','a','source','["ana","marcus"]',1);
INSERT INTO envelopes VALUES ('env','a','template','IN_PROGRESS',1);
INSERT INTO tasks VALUES ('ana','env','ana','Ana','ana@example.com',1,'ACTIVE');
INSERT INTO tasks VALUES ('marcus','env','marcus','Marcus','marcus@example.com',2,'PENDING');
INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com');`);
    await db.prepare("INSERT INTO artifacts VALUES ('d0','env','d0.pdf',?)").bind(h0).run();await bucket.put('d0.pdf',d0);
    const origin='https://host.example.com', pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');
    async function signer(taskId:string, inputId:string, inputHash:string, now:number) {
      const code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'env',taskId,origin,now});
      const token=await exchangeRecipientCode(db,code,origin,now+1);let otp='';
      await sendRecipientOtp(db,token,origin,now+2,pepper,async (_email,value)=>{otp=value;});
      assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),true);
      const cmd={token,origin,now:now+4,artifactId:inputId,artifactHash:inputHash,consent:true};
      if (taskId === 'marcus') {
        const layout=(await db.prepare('SELECT * FROM signature_layouts').first<{job_id:string;page_count:number;slot:number}>())!;
        const assertUnchanged=async()=>{
          for (const table of ['signature_records','signature_events','signature_jobs'])
            assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())!.n,1,table);
          assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='marcus'").first())!.status,'ACTIVE');
        };
        await db.prepare('DELETE FROM signature_layouts WHERE job_id=?').bind(layout.job_id).run();
        await assert.rejects(()=>recordSignature(db,bucket,cmd));
        await assertUnchanged();
        await db.prepare('INSERT INTO signature_layouts VALUES (?,?,?)').bind(layout.job_id,layout.page_count,layout.slot).run();
        await assert.rejects(()=>recordSignature(db,bucket,{...cmd,artifactHash:'wrong'}));
        await assertUnchanged();
        await assert.rejects(()=>recordSignature(db,bucket,{...cmd,artifactId:'other-artifact'}));
        await assertUnchanged();
        await db.prepare('UPDATE signature_layouts SET slot=0.5 WHERE job_id=?').bind(layout.job_id).run();
        await assert.rejects(()=>recordSignature(db,bucket,cmd));
        await assertUnchanged();
        await db.prepare('UPDATE signature_layouts SET slot=? WHERE job_id=?').bind(layout.slot,layout.job_id).run();
        await db.prepare('UPDATE signature_layouts SET page_count=99 WHERE job_id=?').bind(layout.job_id).run();
        await assert.rejects(()=>recordSignature(db,bucket,cmd));
        await assertUnchanged();
        await db.prepare('UPDATE signature_layouts SET page_count=? WHERE job_id=?').bind(layout.page_count,layout.job_id).run();
        const input=(await db.prepare('SELECT object_key FROM signature_outputs WHERE job_id=?').bind(layout.job_id).first<{object_key:string}>())!;
        const inputBytes=await (await bucket.get(input.object_key))!.arrayBuffer();
        await bucket.put(input.object_key,'tampered');
        await assert.rejects(()=>recordSignature(db,bucket,cmd),/hash mismatch/);
        await assertUnchanged();
        await bucket.put(input.object_key,inputBytes);
        const changedLayoutDb=new Proxy(db,{get(target,key){
          if(key==='batch') return async (statements:D1PreparedStatement[])=>{
            await target.prepare('UPDATE signature_layouts SET slot=1 WHERE job_id=?').bind(layout.job_id).run();
            return target.batch(statements);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        await assert.rejects(()=>recordSignature(changedLayoutDb,bucket,cmd));
        await assertUnchanged();
        await db.prepare('UPDATE signature_layouts SET slot=? WHERE job_id=?').bind(layout.slot,layout.job_id).run();
        const racedDb=new Proxy(db,{get(target,key){
          if(key==='batch') return async (statements:D1PreparedStatement[])=>{
            await target.prepare('DELETE FROM signature_layouts WHERE job_id=?').bind(layout.job_id).run();
            return target.batch(statements);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        await assert.rejects(()=>recordSignature(racedDb,bucket,cmd));
        await assertUnchanged();
        await db.prepare('INSERT INTO signature_layouts VALUES (?,?,?)').bind(layout.job_id,layout.page_count,layout.slot).run();
      }
      const signature=await recordSignature(db,bucket,cmd);
      const job=await db.prepare('SELECT id FROM signature_jobs WHERE signature_id=?').bind(signature).first<{id:string}>();
      if (taskId === 'marcus') {
        const layout = await db.prepare('SELECT * FROM signature_layouts').first<{job_id:string;page_count:number;slot:number}>();
        const snapshot=(await db.prepare('SELECT * FROM signature_input_layouts WHERE signature_id=?').bind(signature).first<{object_key:string;page_count:number;slot:number}>())!;
        await db.prepare('DELETE FROM signature_input_layouts WHERE signature_id=?').bind(signature).run();
        await assert.rejects(()=>processSignatureJob(db,bucket,job!.id),/signature layout/);
        await db.prepare('INSERT INTO signature_input_layouts VALUES (?,?,?,?)').bind(signature,snapshot.object_key,snapshot.page_count,snapshot.slot).run();
        await db.prepare('DELETE FROM signature_layouts WHERE job_id=?').bind(layout!.job_id).run();
        await processSignatureJob(db,bucket,job!.id);
        await db.prepare('INSERT INTO signature_layouts VALUES (?,?,?)').bind(layout!.job_id,layout!.page_count,layout!.slot).run();
      }
      await processSignatureJob(db,bucket,job!.id);
      return (await db.prepare('SELECT artifact_id,object_key,sha256 FROM signature_outputs WHERE job_id=?').bind(job!.id).first<{artifact_id:string;object_key:string;sha256:string}>())!;
    }
    await assert.rejects(()=>issueRecipientCode(db,{tenantId:'a',envelopeId:'env',taskId:'marcus',origin,now:1000}));
    const d1=await signer('ana','d0',h0,1000);
    const d1Bytes=await (await bucket.get(d1.object_key))!.arrayBuffer();
    const d2=await signer('marcus',d1.artifact_id,d1.sha256,2000);
    assert.deepEqual(await (await bucket.get(d1.object_key))!.arrayBuffer(),d1Bytes);
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    async function signatureText(bytes:ArrayBuffer) {
      const doc=await pdfjs.getDocument({data:new Uint8Array(bytes.slice(0)),useSystemFonts:true}).promise;
      return (await (await doc.getPage(2)).getTextContent()).items.map((item:any)=>item.str ?? '').join(' ');
    }
    const d2Bytes=await (await bucket.get(d2.object_key))!.arrayBuffer();
    const firstText=await signatureText(d1Bytes), secondText=await signatureText(d2Bytes);
    const signedDoc=await pdfjs.getDocument({data:new Uint8Array(d2Bytes.slice(0)),useSystemFonts:true}).promise;
    const originalText=(await (await signedDoc.getPage(1)).getTextContent()).items.map((item:any)=>item.str ?? '').join(' ');
    assert.equal(originalText,'Electronic signature - forged layout');
    assert.match(firstText,/Name: Ana/);assert.doesNotMatch(firstText,/Marcus/);
    assert.match(secondText,/Name: Ana/);assert.match(secondText,/Name: Marcus/);
    assert.notEqual(d1.sha256,h0);assert.notEqual(d2.sha256,d1.sha256);
    assert.equal((await PDFDocument.load(await (await bucket.get(d1.object_key))!.arrayBuffer())).getPageCount(),2);
    assert.equal((await PDFDocument.load(await (await bucket.get(d2.object_key))!.arrayBuffer())).getPageCount(),2);
    assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');
    assert.deepEqual(new Uint8Array(await (await bucket.get('d0.pdf'))!.arrayBuffer()),d0);
    const facts=await db.prepare('SELECT task_id,input_artifact_id,input_sha256 FROM signature_records ORDER BY sequence').all();
    assert.deepEqual(facts.results.map((x:any)=>[x.task_id,x.input_artifact_id,x.input_sha256]),[['ana','d0',h0],['marcus',d1.artifact_id,d1.sha256]]);
    const events=await db.prepare(`SELECT e.sequence,e.previous_hash,e.event_hash,r.id,r.envelope_id,r.task_id,r.recipient_name,r.input_artifact_id,r.input_sha256,r.otp_verified_at,r.consented_at FROM signature_events e JOIN signature_records r ON r.id=e.signature_id ORDER BY e.sequence`).all();
    let previous='';
    for (const event of events.results as any[]) {
      assert.equal(event.previous_hash,previous);
      const canonical=JSON.stringify(['esign-signature-event-v1',event.envelope_id,event.sequence,previous,event.id,event.task_id,event.recipient_name,event.input_artifact_id,event.input_sha256,event.otp_verified_at,event.consented_at]);
      previous=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical))),n=>n.toString(16).padStart(2,'0')).join('');
      assert.equal(event.event_hash,previous);
    }
    assert.equal(events.results.length,2);
  } finally { await mf.dispose(); }
});
