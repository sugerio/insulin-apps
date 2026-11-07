import {unstable_splitSqlQuery} from 'wrangler';
/** Generates a new in-memory local Worker fixture; never reads caller-provided evidence. */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import app from '../src/worker.ts';
import { finalizeLocalTestEvidence } from '../src/local-test-evidence.ts';

export async function createSyntheticFixture(...args:never[]) {
  if(args.length) throw new Error('Fixture accepts no input');
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
  try {
    const db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS'), mail=await mf.getR2Bucket('TEST_MAIL');
    for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
      const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
    }
    const secret='test-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com';
    await db.prepare("INSERT INTO tenants VALUES ('a')").run();
    await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(createHash('sha256').update(secret).digest('hex')).run();
    await db.prepare("INSERT INTO tenant_page_origins VALUES ('a',?)").bind(origin).run();
    const sealKey='local-test-seal-key-at-least-32-bytes';
    const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:'local-test-pepper-at-least-32-bytes',LOCAL_TEST_SEAL_KEY:sealKey};
    const management={authorization:`Bearer ${secret}`};
    const req=async (path:string,init:RequestInit={},expected=200)=>{
      const result=await app.fetch(new Request('http://localhost'+path,init),env);
      if(result.status!==expected) throw new Error(`Fixture request failed: ${path} (${result.status})`);
      return result;
    };
    const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
    const pdf=await PDFDocument.create();pdf.addPage();
    const form=new FormData();form.set('file',new File([Uint8Array.from(await pdf.save())],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["ana","marcus"]');
    const template=await (await req('/v1/templates',{method:'POST',headers:management,body:form},201)).json() as {id:string};
    const envelope=await (await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...management,'idempotency-key':'fixture'}),201)).json() as {id:string};
    await req(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST',headers:management},204);
    const details=await (await req(`/v1/envelopes/${envelope.id}`,{headers:management})).json() as {tasks:{id:string}[]};
    for(const task of details.tasks) {
      const view=await (await req(`/v1/envelopes/${envelope.id}/tasks/${task.id}/recipient-view`,json({origin},management),201)).json() as {code:string};
      const session=await (await req('/v1/page-sessions/exchange',json({code:view.code},{origin}))).json() as {token:string};
      const headers={origin,authorization:`Bearer ${session.token}`};
      const sent=await (await req('/v1/signing/otp',json({},headers),202)).json() as {messageId:string};
      const message=await (await mail.get(`test-mail/${sent.messageId}.json`))!.json() as {otp:string};
      await req('/v1/signing/otp/verify',json({otp:message.otp},headers),204);
      const artifact=await (await req('/v1/signing/current',{headers})).json() as {id:string;sha256:string};
      await req('/v1/signing/sign',json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true},headers),202);
      await req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:management},204);
    }
    await req(`/v1/envelopes/${envelope.id}/finalize`,{method:'POST',headers:management},204);
    const delivery=await req(`/v1/envelopes/${envelope.id}/delivery-pdf`,{headers:management});
    const d3=new Uint8Array(await delivery.arrayBuffer());
    const evidence=await finalizeLocalTestEvidence(db,bucket as unknown as R2Bucket,'a',envelope.id,new TextEncoder().encode(sealKey),true);
    if(!evidence || !evidence.source || evidence.signatures.length!==2) throw new Error('Fixture evidence incomplete');
    const keys=[evidence.source.object_key,...evidence.signatures.map(row=>row.object_key)];
    const artifacts:Uint8Array[]=[];
    for(const key of keys) {
      const object=await bucket.get(key);if(!object) throw new Error('Fixture artifact missing');
      artifacts.push(new Uint8Array(await object.arrayBuffer()));
    }
    artifacts.push(d3);
    return {envelopeId:envelope.id,source:evidence.source,signatures:evidence.signatures,artifacts};
  } finally {await mf.dispose();}
}
