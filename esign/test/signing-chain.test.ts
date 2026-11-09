import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { PDFDocument } from 'pdf-lib';
import { issueRecipientCode, exchangeRecipientCode, sendRecipientOtp, verifyRecipientOtp } from '../src/otp.ts';
import { recordSignature } from '../src/signature-record.ts';
import { processSignature } from '../src/signature-processing.ts';
import { signatureEventHash } from '../src/signatures.ts';

test('local primitives chain Ana D0 to D1 and Marcus D1 to D2 without overwriting', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
  try {
    const db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0004_artifacts.sql','0005_access.sql','0006_otp_challenges.sql','0007_signatures.sql','0015_editor_sessions.sql','0016_editor_template_integration.sql']) {
      const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
    }
    const pdf=await PDFDocument.create();pdf.addPage().drawText('Electronic signature - forged layout');const d0=await pdf.save();
    const h0=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',d0)),n=>n.toString(16).padStart(2,'0')).join('');
    await db.exec(`INSERT INTO tenants (id) VALUES ('a');
INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES ('template','a','source','["ana","marcus"]',1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('env','a','template','IN_PROGRESS',1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('ana','env','ana','Ana','ana@example.com',1,'ACTIVE');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('marcus','env','marcus','Marcus','marcus@example.com',2,'PENDING');
`);
    await db.prepare("INSERT INTO artifacts VALUES ('d0','env','d0.pdf',?)").bind(h0).run();await bucket.put('d0.pdf',d0);
    const origin='https://host.example.com', pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');
    async function signer(taskId:string, inputId:string, inputHash:string, now:number) {
      const code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'env',taskId,origin,now});
      const token=await exchangeRecipientCode(db,code,origin,now+1);let otp='';
      await sendRecipientOtp(db,token,origin,now+2,pepper,async (_email,value)=>{otp=value;});
      assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),true);
      const cmd={token,origin,now:now+4,artifactId:inputId,artifactHash:inputHash,consent:true};
      if (taskId === 'marcus') {
        const assertUnchanged=async()=>{
          assert.equal((await db.prepare('SELECT count(*) AS n FROM signatures').first())!.n,1);
          assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='marcus'").first())!.status,'ACTIVE');
        };
        await assert.rejects(()=>recordSignature(db,bucket,{...cmd,artifactHash:'wrong'}));
        await assertUnchanged();
        await assert.rejects(()=>recordSignature(db,bucket,{...cmd,artifactId:'other-artifact'}));
        await assertUnchanged();
        await assert.rejects(()=>recordSignature(db,bucket,{...cmd,artifactId:'d0',artifactHash:h0}),/Stale input/);
        await assertUnchanged();
        const inputKey=`envelopes/env/${inputId}.pdf`, inputBytes=await (await bucket.get(inputKey))!.arrayBuffer();
        await bucket.put(inputKey,'tampered');
        await assert.rejects(()=>recordSignature(db,bucket,cmd),/Input mismatch/);
        await assertUnchanged();
        await bucket.put(inputKey,inputBytes);
        // A name that changes between the read and the write rolls the whole signature back.
        const racedDb=new Proxy(db,{get(target,key){
          if(key==='batch') return async (statements:D1PreparedStatement[])=>{
            await target.prepare("UPDATE tasks SET recipient_name='Ana Changed' WHERE id='ana'").run();
            return target.batch(statements);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        await assert.rejects(()=>recordSignature(racedDb,bucket,cmd));
        await assertUnchanged();
        await db.prepare("UPDATE tasks SET recipient_name='Ana' WHERE id='ana'").run();
      }
      const signature=await recordSignature(db,bucket,cmd);
      await processSignature(db,bucket,signature);
      const out=(await db.prepare('SELECT output_artifact_id,output_sha256 FROM signatures WHERE id=?').bind(signature).first<{output_artifact_id:string;output_sha256:string}>())!;
      return {artifact_id:out.output_artifact_id,object_key:`envelopes/env/${out.output_artifact_id}.pdf`,sha256:out.output_sha256};
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
    const rows=(await db.prepare('SELECT * FROM signatures ORDER BY sequence').all()).results as any[];
    assert.deepEqual(rows.map(x=>[x.task_id,x.input_artifact_id,x.input_sha256]),[['ana','d0',h0],['marcus',d1.artifact_id,d1.sha256]]);
    // Each event hash covers its link to the one before, the input, the facts and what is drawn.
    let previous:string|null=null;
    for (const row of rows) {
      assert.equal(row.previous_hash,previous);
      const facts=JSON.parse(row.facts_json),render=JSON.parse(row.render_json);
      assert.equal(facts.recipientName,row.task_id==='ana'?'Ana':'Marcus');assert.equal(render.kind,'appended-page');assert.equal(render.slot,row.sequence-1);
      previous=await signatureEventHash({previousHash:previous,envelopeId:'env',sequence:row.sequence,inputSha256:row.input_sha256},facts,render);
      assert.equal(row.event_hash,previous);
    }
    const events={results:rows};
    assert.equal(events.results.length,2);
  } finally { await mf.dispose(); }
});
