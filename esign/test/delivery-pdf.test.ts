import {blobStore} from './helpers/platform.ts';
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { issueRecipientCode, exchangeRecipientCode, sendRecipientOtp, verifyRecipientOtp } from '../src/app/server/esign/otp.ts';
import { recordSignature } from '../src/app/server/esign/signature-record.ts';
import { processSignature } from '../src/app/server/esign/signature-processing.ts';
import { finalizeLocalTestEvidence } from '../src/app/server/esign/seal/local.ts';
import { deliveryPdf } from '../src/app/server/esign/delivery-pdf.ts';

const sha=async (data:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data instanceof Uint8Array?Uint8Array.from(data):data)),n=>n.toString(16).padStart(2,'0')).join('');

test('delivery retries concurrent creation and completed finalization with long names and multipage certificate',{timeout:20000},async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db=await mf.getD1Database('DB'), bucket=await blobStore(mf,'artifacts');
    for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()) {
      const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
    }
    const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const d0=await pdf.save();
    await db.exec(`INSERT INTO tenants (id) VALUES ('tenant'); INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES ('template','tenant','template.pdf','[]',1); INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('env','tenant','template','IN_PROGRESS',1,'hash');`);
    const names=Array.from({length:11},(_,i)=>`${'i'.repeat(i===7?160:100)}${i}`);
    for(const [i,name] of names.entries()) await db.prepare('INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES (?,?,?,?,?,?,?)').bind(`task-${i}`,'env',`role-${i}`,name,`signer${i}@example.com`,i+1,i===0?'ACTIVE':'PENDING').run();
    await bucket.put('source.pdf',d0);let inputId='d0',inputHash=await sha(d0);
    await db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').bind(inputId,'env','source.pdf',inputHash).run();
    const originalObjects=new Map<string,ArrayBuffer>([['source.pdf',await (await bucket.get('source.pdf'))!.arrayBuffer()]]);
    const origin='https://host.example.com',key=new TextEncoder().encode('local-test-seal-key-at-least-32-bytes'),pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');
    for(const i of names.keys()) {
      const now=100000+i*10000,taskId=`task-${i}`;
      const code=await issueRecipientCode(db,{tenantId:'tenant',envelopeId:'env',taskId,origin,now});
      const token=await exchangeRecipientCode(db,code,origin,now+1);let otp='';
      await sendRecipientOtp(db,token,origin,now+2,pepper,async (_email,value)=>{otp=value;});
      assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),true);
      const signature=await recordSignature(db,bucket,{token,origin,now:now+4,artifactId:inputId,artifactHash:inputHash,consent:true});
      await processSignature(db,bucket,signature);
      const output=(await db.prepare("SELECT output_artifact_id AS artifact_id,'envelopes/env/'||output_artifact_id||'.pdf' AS object_key,output_sha256 AS sha256 FROM signatures WHERE id=?").bind(signature).first<{artifact_id:string;object_key:string;sha256:string}>())!;
      inputId=output.artifact_id;inputHash=output.sha256;originalObjects.set(output.object_key,await (await bucket.get(output.object_key))!.arrayBuffer());
    }
    const signed=await pdfjsSigned(inputId);
    assert.equal(signed.numPages,4);
    for (const [pageNumber, expected] of [[3,names.slice(0,8)],[4,names.slice(8)]] as const) {
      const items=(await (await signed.getPage(pageNumber)).getTextContent()).items as any[];
      const lines=items.filter(item=>item.str?.startsWith('Name:'));
      assert.equal(lines.length,expected.length);
      for (const [i,line] of lines.entries()) {
        assert.ok(line.str.includes(expected[i]));
        assert.ok(line.transform[4]+line.width<=563);
        if (i) assert.ok(lines[i-1].transform[5]-line.transform[5]>=80);
      }
    }
    async function pdfjsSigned(_id:string) {
      const objectKey=[...originalObjects.keys()].at(-1)!;
      const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
      return pdfjs.getDocument({data:new Uint8Array((await (await bucket.get(objectKey))!.arrayBuffer()).slice(0)),useSystemFonts:true}).promise;
    }
    const facts=await db.prepare("SELECT id,sequence,status,previous_hash,event_hash,facts_json,render_json,output_sha256,json_extract(facts_json,'$.otpVerifiedAt') AS otp_verified_at,json_extract(facts_json,'$.consentedAt') AS consented_at,json_extract(facts_json,'$.recipientName') AS recipient_name FROM signatures ORDER BY sequence").all();
    // The evidence R2 write precedes the finalization D1 batch. Test both rollback and lost response after commit.
    let batches=0;
    const faultDb=new Proxy(db,{get(target,prop){if(prop==='batch')return async (statements:any[])=>{batches++;if(batches===1)throw new Error('D1 unavailable before commit');await target.batch(statements);throw new Error('D1 response lost after commit');};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>finalizeLocalTestEvidence(faultDb,bucket,'tenant','env',key),/before commit/);
    assert.ok(await bucket.get('envelopes/env/local-test-evidence.json'));
    assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'FINALIZING');
    await assert.rejects(()=>finalizeLocalTestEvidence(faultDb,bucket,'tenant','env',key),/after commit/);
    assert.equal((await db.prepare("SELECT status FROM envelopes WHERE id='env'").first())!.status,'COMPLETED');
    await finalizeLocalTestEvidence(db,bucket,'tenant','env',key);
    // Non-blocking version-key assertion runs before the concurrency gate.
    const inspectBucket=new Proxy(bucket,{get(target,prop){if(prop==='put')return async (objectKey:string)=>{assert.equal(objectKey,'envelopes/env/local-delivery-v3.pdf');throw new Error('version key observed');};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>deliveryPdf(db,inspectBucket,'tenant','env',key),/version key observed/);
    // Preserve artifacts created by the original delivery renderer.
    await bucket.put('envelopes/env/local-delivery.pdf','legacy pdf');
    await bucket.put('envelopes/env/local-delivery.json','legacy metadata');
    await bucket.put('envelopes/env/local-delivery-v2.pdf','v2 pdf');
    await bucket.put('envelopes/env/local-delivery-v2.json','v2 metadata');
    // Competing first requests conditionally create the same objects without deleting either.
    let arrivals=0, release!:()=>void;
    const gate=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('concurrency gate timed out')),5000);release=()=>{clearTimeout(timer);resolve();};});
    const racingBucket=new Proxy(bucket,{get(target,prop){if(prop==='delete')return ()=>{throw new Error('delivery must not delete objects');};if(prop==='put')return async (objectKey:string,...args:any[])=>{assert.equal(originalObjects.has(objectKey),false,'delivery must not write prior artifact keys');if(objectKey.endsWith('local-delivery-v3.pdf')) {if(++arrivals===4)release();await gate;}return (target.put as any)(objectKey,...args);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    const deliveries=await Promise.all(Array.from({length:4},()=>deliveryPdf(db,racingBucket,'tenant','env',key)));
    assert.equal(arrivals,4);
    for(const item of deliveries) {assert.deepEqual(item.bytes,deliveries[0].bytes);assert.equal(item.metadata.sha256,await sha(item.bytes));assert.equal(item.metadata.finalSha256,inputHash);}
    // D3 has no D1 writes: a later D1 read failure must not delete or overwrite its already written R2 objects.
    const deliveryKeys=['envelopes/env/local-delivery-v3.pdf','envelopes/env/local-delivery-v3.json'];
    const saved=await Promise.all(deliveryKeys.map(async objectKey=>await (await bucket.get(objectKey))!.arrayBuffer()));
    const readFailureDb=new Proxy(db,{get(target,prop){if(prop==='prepare')return ()=>{throw new Error('D1 read unavailable');};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await assert.rejects(()=>deliveryPdf(readFailureDb,bucket,'tenant','env',key),/D1 read unavailable/);
    for(const [i,objectKey] of deliveryKeys.entries())assert.deepEqual(await (await bucket.get(objectKey))!.arrayBuffer(),saved[i]);
    assert.deepEqual((await deliveryPdf(db,bucket,'tenant','env',key)).bytes,deliveries[0].bytes);
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document=await pdfjs.getDocument({data:Uint8Array.from(deliveries[0].bytes),useSystemFonts:true}).promise;
    const signedPages=2+Math.ceil(names.length/8);assert.ok(document.numPages>signedPages+1,'certificate spans multiple pages');
    let content='';
    const certificatePages:string[]=[];
    const certificateItems:any[][]=[];
    for(let n=signedPages+1;n<=document.numPages;n++) {
      const page=await document.getPage(n),items=(await page.getTextContent()).items as any[];
      assert.ok(items.some(item=>item.str?.includes('LOCAL TEST ONLY')));
      for(const item of items) if(item.str) {assert.ok(item.transform[4]>=49);assert.ok(item.transform[4]+item.width<=563,`clipped: ${item.str}`);assert.ok(item.transform[5]>=50);}
      const pageText=items.map(item=>item.str??'').join('');
      certificatePages.push(pageText);certificateItems.push(items);content+=pageText;
    }
    for(const section of ['Certificate of completion','Envelope','Document','Signers','Events (UTC)']) assert.ok(content.includes(section),`missing section ${section}`);
    for(const name of names)assert.ok(content.includes(name),`missing name ${name}`);
    // Associate values with their labels using PDF coordinates, not page-wide text matches.
    function assertEventGroups(pages:any[][]) {
      const headingPage=pages.findIndex(items=>items.some(item=>item.str==='Events (UTC)'));
      assert.ok(headingPage>=0,'missing event heading');
      const heading=pages[headingPage].find(item=>item.str==='Events (UTC)');
      const labels=pages.flatMap((items,page)=>items
        .filter(item=>page>=headingPage && (page>headingPage || item.transform?.[5]<heading.transform[5]) &&
          item.transform?.[4]<60 && /^(Signer \d+|OTP verified|Consent \/ signed)$/.test(item.str??''))
        .map(item=>({page,item})))
        .sort((a,b)=>a.page-b.page || b.item.transform[5]-a.item.transform[5]);
      assert.equal(labels.length,facts.results.length*3,'unexpected event labels');
      const value=(page:number,top:number,bottom:number)=>pages[page]
        .filter(item=>item.str && item.transform?.[4]>=179 && item.transform[5]<=top && item.transform[5]>bottom)
        .sort((a,b)=>b.transform[5]-a.transform[5] || a.transform[4]-b.transform[4])
        .map(item=>item.str).join('');
      const groupPages:number[]=[];
      for(const [index,row] of (facts.results as any[]).entries()) {
        const [signer,otp,consent]=labels.slice(index*3,index*3+3);
        assert.equal(signer.item.str,`Signer ${row.sequence}`);
        assert.equal(otp.item.str,'OTP verified');assert.equal(consent.item.str,'Consent / signed');
        assert.equal(otp.page,signer.page,`OTP split from signer ${row.sequence}`);
        assert.equal(consent.page,signer.page,`consent split from signer ${row.sequence}`);
        const signerY=signer.item.transform[5],otpY=otp.item.transform[5],consentY=consent.item.transform[5];
        assert.ok(signerY>otpY && otpY>consentY,`event order for signer ${row.sequence}`);
        assert.equal(value(signer.page,signerY,otpY),row.recipient_name,`name for signer ${row.sequence}`);
        assert.equal(value(otp.page,otpY,consentY),new Date(row.otp_verified_at).toISOString(),`OTP for signer ${row.sequence}`);
        assert.equal(value(consent.page,consentY,consentY-1),new Date(row.consented_at).toISOString(),`consent for signer ${row.sequence}`);
        groupPages.push(signer.page);
      }
      return groupPages;
    }
    const groupPages=assertEventGroups(certificateItems);
    assert.notEqual(groupPages[6],groupPages[7],'fixture must exercise an event page boundary');
    // Mutate real extracted PDF.js text, retaining coordinates, to prove wrong associations fail.
    for(const [firstIndex,secondIndex] of [[0,1],[6,7]]) {
      for(const [field,label] of [['otp_verified_at','OTP'],['consented_at','consent']] as const) {
        const swapped=certificateItems.map(items=>items.map(item=>({...item})));
        const first=(facts.results as any[])[firstIndex],second=(facts.results as any[])[secondIndex];
        const a=new Date(first[field]).toISOString(),b=new Date(second[field]).toISOString();
        const left=swapped[groupPages[firstIndex]].find(item=>item.str===a);
        const right=swapped[groupPages[secondIndex]].find(item=>item.str===b);
        assert.ok(left && right);left.str=b;right.str=a;
        assert.throws(()=>assertEventGroups(swapped),new RegExp(`${label} for signer ${firstIndex+1}`));
      }
    }
    const longEventPage=certificatePages.findIndex(text=>text.includes(new Date((facts.results as any[])[7].otp_verified_at).toISOString()));
    assert.ok(longEventPage>=0);
    assert.ok(certificatePages[longEventPage].includes(names[7]),'wrapped name must be complete on the event page');
    assert.ok(!certificateItems[longEventPage].some(item=>item.str?.includes(names[7])),'long event name must actually wrap');
    const events=await db.prepare('SELECT event_hash FROM signatures ORDER BY sequence').all<{event_hash:string}>();
    for(const event of events.results) assert.ok(content.includes(event.event_hash));
    assert.ok(content.includes(await sha(d0)));
    for(const forbidden of ['Sent by','SSO','IP / device','verify.fours.com']) assert.ok(!content.includes(forbidden));
    assert.equal(await (await bucket.get('envelopes/env/local-delivery.pdf'))!.text(),'legacy pdf');
    assert.equal(await (await bucket.get('envelopes/env/local-delivery.json'))!.text(),'legacy metadata');
    assert.equal(await (await bucket.get('envelopes/env/local-delivery-v2.pdf'))!.text(),'v2 pdf');
    assert.equal(await (await bucket.get('envelopes/env/local-delivery-v2.json'))!.text(),'v2 metadata');
    assert.equal(deliveries[0].metadata.format,'esign-local-delivery-v3');
    assert.ok(content.includes(inputHash));assert.ok(!content.includes(deliveries[0].metadata.sha256));
    for(const [objectKey,bytes] of originalObjects) assert.deepEqual(await (await bucket.get(objectKey))!.arrayBuffer(),bytes,objectKey);
    assert.deepEqual((await db.prepare("SELECT id,sequence,status,previous_hash,event_hash,facts_json,render_json,output_sha256,json_extract(facts_json,'$.otpVerifiedAt') AS otp_verified_at,json_extract(facts_json,'$.consentedAt') AS consented_at,json_extract(facts_json,'$.recipientName') AS recipient_name FROM signatures ORDER BY sequence").all()).results,facts.results);
  } finally {await mf.dispose();}
});
