import {unstable_splitSqlQuery} from 'wrangler';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import app from '../src/worker.ts';
import {verifyLocalTestSeal} from '../src/seal/local.ts';
import {processEnvelopeStep,finalizeEnvelopeStep} from '../src/envelope-completion.ts';

test('local HTTP Ana then Marcus authenticate, inspect and sign consecutive PDFs', async () => {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
  try {
    const db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS'), mail=await mf.getR2Bucket('TEST_MAIL');
    for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
      const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
    }
    const secret='test-key-0123456789-abcdefghijklmnopqrstuvwxyz';
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))),n=>n.toString(16).padStart(2,'0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
    await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();
    const origin='https://host.example.com';
    const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,SIGNING_PAGE_ORIGINS:origin,OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
    const management={authorization:`Bearer ${secret}`};
    const req=(path:string,init:RequestInit={})=>app.fetch(new Request('http://localhost'+path,init),env);
    const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
    const pdf=await PDFDocument.create();pdf.addPage();const form=new FormData();form.set('file',new File([await pdf.save()],'sample.pdf',{type:'application/pdf'}));form.set('roles','["ana","marcus"]');
    const templateResponse=await req('/v1/templates',{method:'POST',headers:management,body:form});assert.equal(templateResponse.status,201);const template=await templateResponse.json();
    const create=await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...management,'idempotency-key':'env-1'}));assert.equal(create.status,201);const envelope=await create.json();
    assert.equal((await req(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST',headers:management})).status,204);
    const details=await (await req(`/v1/envelopes/${envelope.id}`,{headers:management})).json();
    // Every tenant signs on the Worker's own origin, plus SIGNING_PAGE_ORIGINS; nothing else.
    const firstTask=details.tasks[0].id;
    assert.deepEqual(await (await req(`/v1/envelopes/${envelope.id}/tasks/${firstTask}/recipient-view`,json({origin:'https://other.example.com'},management))).json(),{error:'invalid_origin'});
    const ownView=await req(`/v1/envelopes/${envelope.id}/tasks/${firstTask}/recipient-view`,json({},management));assert.equal(ownView.status,201);
    const ownExchange=await req('/v1/page-sessions/exchange',json({code:(await ownView.json()).code},{origin:'http://localhost'}));assert.equal(ownExchange.status,200,'the default code is for the Worker\'s own origin');
    assert.equal((await req('/v1/page-sessions/exchange',json({code:'0'.repeat(64)},{origin:'https://other.example.com'}))).status,403,'other origins are refused before the exchange');
    async function sign(task:any,index:number) {
      const view=await req(`/v1/envelopes/${envelope.id}/tasks/${task.id}/recipient-view`,json({origin},management));assert.equal(view.status,201,await view.clone().text());const {code}=await view.json();
      const exchange=await req('/v1/page-sessions/exchange',json({code},{origin}));assert.equal(exchange.status,200);const {token}=await exchange.json();
      const headers={origin,authorization:`Bearer ${token}`};
      // The document can be read before the code; signing it cannot (below, and in the record layer).
      assert.equal((await req('/v1/signing/pdf',{headers})).status,200);
      const early=await (await req('/v1/signing/current',{headers})).json();assert.equal(early.verified,false);
      assert.equal((await req('/v1/signing/sign',json({artifactId:early.id,artifactHash:early.sha256,consent:true},headers))).status,409);
      assert.equal((await req('/v1/signing/decline',json({reason:'No'},headers))).status,401);
      assert.equal((await req('/v1/signing/current',{headers:{origin,authorization:management.authorization}})).status,401);
      assert.equal((await req('/v1/signing/current',{headers:{...headers,origin:'https://wrong.example.com'}})).status,403);
      const send=await app.fetch(new Request('https://public.example.com/v1/signing/otp',json({},headers)),env);assert.equal(send.status,202);
      const shown=await send.json();assert.deepEqual(Object.keys(shown),['messageId']);
      const objects=await mail.list();const item=objects.objects[0];assert.ok(item);const message=await (await mail.get(item.key))!.json() as {to:string;otp:string};assert.equal(message.to,task.recipientEmail);assert.equal(item.key,`test-mail/${shown.messageId}.json`);await mail.delete(item.key);
      const disabled=await app.fetch(new Request('http://localhost/v1/signing/otp',json({},headers)),{...env,OTP_KEY:''});assert.equal(disabled.status,404);assert.equal((await disabled.text()).includes(message.otp),false);
      assert.equal((await req('/v1/signing/otp/verify',json({otp:message.otp},headers))).status,204);
      assert.equal((await req('/v1/signing/otp/verify',json({otp:message.otp},headers))).status,204);
      const current=await req('/v1/signing/current',{headers});assert.equal(current.status,200);const artifact=await current.json();
      const content=await req('/v1/signing/pdf',{headers});assert.equal(content.status,200);assert.equal((await PDFDocument.load(await content.arrayBuffer())).getPageCount(),index===0?1:2);
      const signed=await req('/v1/signing/sign',json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true},headers));assert.equal(signed.status,202,await signed.clone().text());
      const signedId=(await signed.json()).id;
      const replay=await req('/v1/signing/sign',json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true},headers));assert.equal(replay.status,202);assert.equal((await replay.json()).id,signedId);
      assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelope.id),'processed');
      assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelope.id),'processed');
      return artifact;
    }
    const d0=await sign(details.tasks[0],0);const d1=await sign(details.tasks[1],1);assert.notEqual(d0.sha256,d1.sha256);
    const pending=await (await req(`/v1/envelopes/${envelope.id}`,{headers:management})).json();assert.equal(pending.status,'FINALIZING');
    assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:management})).status,404);
    assert.equal((await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management})).status,404);
    const finalOutput=await db.prepare("SELECT 'envelopes/'||envelope_id||'/'||output_artifact_id||'.pdf' AS object_key FROM signatures WHERE envelope_id=? AND status='DONE' ORDER BY sequence DESC LIMIT 1").bind(envelope.id).first<{object_key:string}>();
    const original=await (await bucket.get(finalOutput!.object_key))!.arrayBuffer();await bucket.put(finalOutput!.object_key,'tampered');
    assert.equal(await finalizeEnvelopeStep(env,'a',envelope.id),'finalization_failed');
    await bucket.put(finalOutput!.object_key,original);
    assert.equal(await finalizeEnvelopeStep(env,'a',envelope.id),'finalized');
    assert.equal(await finalizeEnvelopeStep(env,'a',envelope.id),'finalized');
    const certificate=await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:management});assert.equal(certificate.status,200);const cert=await certificate.json();assert.equal(cert.mode,'LOCAL TEST ONLY');assert.equal(cert.envelope.id,envelope.id);assert.equal(cert.signatures[0].recipient_name,'Ana');assert.equal(cert.signatures[0].input_sha256,d0.sha256);assert.ok(cert.signatures[0].consented_at);assert.ok(cert.signatures[0].event_hash);assert.equal(cert.finalSha256,cert.signatures[1].sha256);
    assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`)).status,401);
    assert.equal((await PDFDocument.load(original)).getPageCount(),2);
    assert.equal((await req(`/v1/envelopes/${envelope.id}/delivery-pdf`)).status,401);
    let failMetadata=true;
    const failingBucket=new Proxy(bucket,{get(target,prop) {if(prop==='put') return async (key:string,...args:any[])=>{if(key.endsWith('/local-delivery-v3.json') && failMetadata) {failMetadata=false;throw new Error('simulated storage failure');}return (target.put as any)(key,...args);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    const failedDelivery=await app.fetch(new Request(`http://localhost/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management}),{...env,ARTIFACTS:failingBucket});assert.equal(failedDelivery.status,503);
    assert.ok(await bucket.get(`envelopes/${envelope.id}/local-delivery-v3.pdf`));
    const delivery=await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management});assert.equal(delivery.status,200);
    const deliveryBytes=await delivery.arrayBuffer();assert.ok((await PDFDocument.load(deliveryBytes)).getPageCount()>2);
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loaded=await pdfjs.getDocument({data:new Uint8Array(deliveryBytes.slice(0)),useSystemFonts:true}).promise;
    const text=(await (await loaded.getPage(3)).getTextContent()).items.map((item:any)=>item.str ?? '').join(' ');
    assert.match(text,/LOCAL TEST ONLY/);assert.ok(text.includes(cert.finalSha256));assert.ok(text.includes('Ana'));
    assert.equal((await req(`/v1/envelopes/${envelope.id}/delivery-metadata`,{headers:management})).status,404,'no separate metadata endpoint');
    const retry=await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management});assert.deepEqual(await retry.arrayBuffer(),deliveryBytes);
    assert.deepEqual(await (await bucket.get(finalOutput!.object_key))!.arrayBuffer(),original);
    const deliveryKey=`envelopes/${envelope.id}/local-delivery-v3.pdf`;await bucket.put(deliveryKey,'tampered');
    assert.equal((await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management})).status,503);
    await bucket.put(deliveryKey,deliveryBytes);

    const otherSecret='other-test-key-0123456789-abcdefghijklmnopqrstuvwxyz';const otherHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(otherSecret))),n=>n.toString(16).padStart(2,'0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('b')").run();await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'b')").bind(otherHash).run();
    assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:{authorization:`Bearer ${otherSecret}`}})).status,404);
    assert.equal((await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:{authorization:`Bearer ${otherSecret}`}})).status,404);
    await bucket.put(finalOutput!.object_key,'tampered');assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:management})).status,503);assert.equal((await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management})).status,503);await bucket.put(finalOutput!.object_key,original);
    const done=await (await req(`/v1/envelopes/${envelope.id}`,{headers:management})).json();assert.equal(done.status,'COMPLETED');
    const evidence=await db.prepare("SELECT object_key FROM seals WHERE envelope_id=? AND mode='LOCAL_TEST'").bind(envelope.id).first<{object_key:string}>();
    const evidenceBytes=await (await bucket.get(evidence!.object_key))!.arrayBuffer();await bucket.put(evidence!.object_key,'tampered');assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:management})).status,503);await bucket.put(evidence!.object_key,evidenceBytes);
    await assert.rejects(()=>db.prepare('UPDATE signatures SET event_hash=? WHERE envelope_id=? AND sequence=1').bind('0'.repeat(64),envelope.id).run(),/immutable/);
    // A privileged edit past the trigger still fails the event hash check.
    await db.prepare('DROP TRIGGER signatures_facts_immutable').run();await db.prepare('UPDATE signatures SET event_hash=? WHERE envelope_id=? AND sequence=1').bind('0'.repeat(64),envelope.id).run();assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:management})).status,503);
    const seal=await (await bucket.get(evidence!.object_key))!.json() as import('../src/seal/local.ts').LocalTestSeal;assert.equal(seal.mode,'LOCAL_TEST_ONLY');assert.equal(typeof seal.syntheticTimestampMs,'number');
    const key=new TextEncoder().encode(env.TEST_SEAL_KEY);
    assert.equal(await verifyLocalTestSeal(seal,key),true);
    assert.equal(await verifyLocalTestSeal({...seal,manifest:seal.manifest+' '},key),false);
    assert.equal(await verifyLocalTestSeal({...seal,testTsaMac:'0'.repeat(64)},key),false);
    assert.equal(await verifyLocalTestSeal({...seal,syntheticTimestampMs:seal.syntheticTimestampMs+1},key),false);
    const sessions=[];
    for (let i=0;i<2;i++) {
      const created=await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...management,'idempotency-key':`parallel-${i}`}));
      const envelope2=await created.json();
      assert.equal((await req(`/v1/envelopes/${envelope2.id}/prepare`,{method:'POST',headers:management})).status,204);
      const task2=(await (await req(`/v1/envelopes/${envelope2.id}`,{headers:management})).json()).tasks[0];
      const view2=await (await req(`/v1/envelopes/${envelope2.id}/tasks/${task2.id}/recipient-view`,json({origin},management))).json();
      const session2=await (await req('/v1/page-sessions/exchange',json({code:view2.code},{origin}))).json();
      sessions.push({origin,authorization:`Bearer ${session2.token}`});
    }
    const sends=await Promise.all(sessions.map(headers=>req('/v1/signing/otp',json({},headers))));
    assert.deepEqual(sends.map(r=>r.status),[202,202]);
    for (const response of sends) assert.match(response.headers.get('content-type') ?? '', /application\/json/, 'OTP send must return a unique local mailbox message id');
    const ids=await Promise.all(sends.map(async r=>(await r.json()).messageId));
    assert.match(ids[0],/^[0-9a-f-]{36}$/);assert.notEqual(ids[0],ids[1]);
    const objects=await mail.list();assert.equal(objects.objects.length,2);
    for(let i=0;i<2;i++) {
      const message=await (await mail.get(`test-mail/${ids[i]}.json`))!.json() as {to:string;otp:string};
      assert.equal(message.to,'ana@example.com');
      assert.equal((await req('/v1/signing/otp/verify',json({otp:message.otp},sessions[i]))).status,204);
    }
  } finally {await mf.dispose();}
});
