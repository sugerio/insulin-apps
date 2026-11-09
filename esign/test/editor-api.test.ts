import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';
import {setEditorOrigins} from './helpers/editor-origins.ts';

test('editor sessions enforce scope and persist immutable template versions with field signing blocked',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try {
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
   const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
  }
  const a='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',b='local-test-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?, 'a'), (?, 'b')").bind(await digest(a),await digest(b)).run();
  await setEditorOrigins(db,'a',['https://host.example.com']);await setEditorOrigins(db,'b',['https://other.example.com']);
  const env={DB:db,ARTIFACTS:await mf.getR2Bucket('ARTIFACTS'),ASSETS:{fetch:async()=>new Response('<html>editor</html>',{headers:{'content-type':'text/html'}})}};
  const req=(path:string,options:RequestInit={})=>app.fetch(new Request('https://esign.example.com'+path,options),env);
  const management=(key:string,body:unknown)=>({method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await req('/v1/template-editing-sessions',management(a,{allowedParentOrigin:'https://evil.example.com'}))).status,403);
  assert.equal((await req('/v1/template-editing-sessions',management(a,{allowedParentOrigin:'https://host.example.com',sourceTemplateId:''}))).status,422);
  const created=await req('/v1/template-editing-sessions',management(a,{allowedParentOrigin:'https://host.example.com',roles:['Partner','Seller']}));
  assert.equal(created.status,201,await created.clone().text());const first=await created.json() as any;
  assert.ok(first.sessionId && first.url.includes('#'));assert.match(new URL(first.url).hash,/^#[a-f0-9]{64}$/);assert.equal(new URL(first.url).search,'');assert.ok(!first.url.split('#')[0].includes(new URL(first.url).hash.slice(1)));
  const url=new URL(first.url);const page=await req(url.pathname);
  assert.equal(page.status,200);assert.equal(page.headers.get('content-security-policy')?.includes('frame-ancestors https://host.example.com'),true);assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await req('/v1/editor/exchange',management(a,{pageId:first.sessionId,code:first.sessionId}))).status,401);
  const code=url.hash.slice(1);const exchange=()=>req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:'https://esign.example.com'},body:JSON.stringify({pageId:first.sessionId,code})});
  const race=await Promise.all([exchange(),exchange()]);assert.deepEqual(race.map(r=>r.status).sort(),[200,401]);const token=((await race.find(r=>r.status===200)!.json()) as any).token;
  const editorHeaders={authorization:`Bearer ${token}`,origin:'https://esign.example.com'};
  assert.equal((await req('/v1/editor/current',{headers:{...editorHeaders,origin:'https://evil.example.com'}})).status,403);
  const current=await req('/v1/editor/current',{headers:editorHeaders});assert.deepEqual((await current.json() as any).roles,['Partner','Seller']);
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
  const field={id:'field-1',type:'Signature',role:'Partner',page:1,required:true,rect:{x:.1,y:.2,width:.2,height:.1}};
  const fields=[field,{...field,id:'field-2',role:'Seller',rect:{...field.rect,x:.4}},{...field,id:'field-3',role:'Legal',rect:{...field.rect,x:.7}}];
  const invalidForm=(items:unknown[])=>{const f=new FormData();f.set('file',new File([bytes],'test.pdf'));f.set('roles',JSON.stringify(['Partner','Seller','Legal']));f.set('fields',JSON.stringify(items));return f;};
  for(const invalid of [[],[field], [{...field,type:'Text box'},...fields.slice(1)]])assert.equal((await req('/v1/editor/save',{method:'POST',headers:editorHeaders,body:invalidForm(invalid)})).status,422);
  const duplicate=await req('/v1/editor/save',{method:'POST',headers:editorHeaders,body:invalidForm([...fields,{...field,id:'extra',rect:{...field.rect,y:.5}}])});
  assert.equal(duplicate.status,422);assert.deepEqual(await duplicate.json(),{error:'invalid_signing_fields',message:'Role Partner: duplicate Signature field'});
  const form=()=>{const f=new FormData();f.set('file',new File([bytes],'test.pdf',{type:'application/pdf'}));f.set('roles',JSON.stringify(['Partner','Seller','Legal']));f.set('fields',JSON.stringify(fields));return f;};
  const saves=await Promise.all([req('/v1/editor/save',{method:'POST',headers:editorHeaders,body:form()}),req('/v1/editor/save',{method:'POST',headers:editorHeaders,body:form()})]);
  assert.deepEqual(saves.map(r=>r.status).sort(),[201,409]);const one=(await saves.find(r=>r.status===201)!.json() as any).id;
  const confirmed=await req(`/v1/template-editing-sessions/${first.sessionId}`,{headers:{authorization:`Bearer ${a}`}});assert.equal((await confirmed.json() as any).templateId,one);
  assert.equal((await req(`/v1/template-editing-sessions/${first.sessionId}`,{headers:{authorization:`Bearer ${b}`}})).status,404);
  const fieldInfo=await req(`/v1/templates/${one}`,{headers:{authorization:`Bearer ${a}`}});const fieldInfoBody=await fieldInfo.json() as any;assert.equal(fieldInfoBody.hasPositionedFields,true);
  // The host previews the placed fields: type, role, page and box only.
  assert.deepEqual(fieldInfoBody.fields,fields.map(f=>({type:f.type,role:f.role,page:f.page,rect:f.rect})));
  assert.equal((await req(`/v1/templates/${one}`,{headers:{authorization:`Bearer ${b}`}})).status,404);
  assert.equal((await req('/v1/envelopes',{...management(a,{templateId:one,recipients:[{role:'Partner',name:'Ana',email:'ana@example.com'},{role:'Seller',name:'Bo',email:'bo@example.com'},{role:'Legal',name:'Cam',email:'cam@example.com'}]}),headers:{...management(a,{}).headers,'idempotency-key':'fields-1'}})).status,201);
  assert.equal((await req('/v1/template-editing-sessions',management(b,{allowedParentOrigin:'https://other.example.com',sourceTemplateId:one}))).status,404);
  const next=await req('/v1/template-editing-sessions',management(a,{allowedParentOrigin:'https://host.example.com',sourceTemplateId:one}));const nextData=await next.json() as any;const nextUrl=new URL(nextData.url);
  const ex2=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:'https://esign.example.com'},body:JSON.stringify({pageId:nextData.sessionId,code:nextUrl.hash.slice(1)})});const token2=(await ex2.json() as any).token;
  const headers2={authorization:`Bearer ${token2}`,origin:'https://esign.example.com'};const loaded=await req('/v1/editor/current',{headers:headers2});const details=await loaded.json() as any;assert.deepEqual(details.fields,fields);assert.deepEqual(details.roles,['Partner','Seller','Legal']);
  const source=await req('/v1/editor/pdf',{headers:headers2});assert.deepEqual(new Uint8Array(await source.arrayBuffer()),bytes);
  const secondForm=new FormData();secondForm.set('roles',JSON.stringify(details.roles));secondForm.set('fields','[]');assert.equal((await req('/v1/editor/save',{method:'POST',headers:headers2,body:secondForm})).status,422);secondForm.set('fields',JSON.stringify(fields));const saved=await req('/v1/editor/save',{method:'POST',headers:headers2,body:secondForm});assert.equal(saved.status,201,await saved.clone().text());const two=(await saved.json() as any).id;assert.notEqual(one,two);
  const emptyInfo=await req(`/v1/templates/${two}`,{headers:{authorization:`Bearer ${a}`}});assert.equal((await emptyInfo.json() as any).hasPositionedFields,true);
  const old=await db.prepare('SELECT fields_json FROM templates WHERE id=?').bind(one).first() as any;assert.deepEqual(JSON.parse(old.fields_json),fields);
  const legacyForm=new FormData();legacyForm.set('file',new File([bytes],'legacy.pdf',{type:'application/pdf'}));legacyForm.set('roles','["Signer","signer"]');
  const legacyResponse=await req('/v1/templates',{method:'POST',headers:{authorization:`Bearer ${a}`},body:legacyForm});assert.equal(legacyResponse.status,201);const legacy=(await legacyResponse.json() as any).id;assert.deepEqual(((await (await req(`/v1/templates/${legacy}`,{headers:{authorization:`Bearer ${a}`}})).json()) as any).fields,[]);const legacyBefore=await db.prepare('SELECT object_key,roles_json,fields_json FROM templates WHERE id=?').bind(legacy).first();
  const legacySessionResponse=await req('/v1/template-editing-sessions',management(a,{allowedParentOrigin:'https://host.example.com',sourceTemplateId:legacy}));assert.equal(legacySessionResponse.status,201);const legacySession=await legacySessionResponse.json() as any;const legacyUrl=new URL(legacySession.url);
  const legacyExchange=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:'https://esign.example.com'},body:JSON.stringify({pageId:legacySession.sessionId,code:legacyUrl.hash.slice(1)})});const legacyToken=(await legacyExchange.json() as any).token;const legacyHeaders={authorization:`Bearer ${legacyToken}`,origin:'https://esign.example.com'};
  const legacyCurrent=await req('/v1/editor/current',{headers:legacyHeaders});assert.deepEqual((await legacyCurrent.json() as any).roles,['Signer','signer']);
  const invalidLegacySave=new FormData();invalidLegacySave.set('roles','["Signer","signer","SIGNER"]');invalidLegacySave.set('fields','[]');assert.equal((await req('/v1/editor/save',{method:'POST',headers:legacyHeaders,body:invalidLegacySave})).status,422);
  const legacySave=new FormData();legacySave.set('roles','["Signer","signer"]');legacySave.set('fields',JSON.stringify([{...field,id:'upper',role:'Signer'},{...field,id:'lower',role:'signer',rect:{...field.rect,x:.5}}]));const legacySaved=await req('/v1/editor/save',{method:'POST',headers:legacyHeaders,body:legacySave});assert.equal(legacySaved.status,201,await legacySaved.clone().text());const legacyVersion=(await legacySaved.json() as any).id;
  assert.deepEqual(await db.prepare('SELECT object_key,roles_json,fields_json FROM templates WHERE id=?').bind(legacy).first(),legacyBefore);
  for(const id of [legacy,legacyVersion]){const row=await db.prepare('SELECT roles_json,object_key FROM templates WHERE id=?').bind(id).first() as any;assert.deepEqual(JSON.parse(row.roles_json),['Signer','signer']);const object=await env.ARTIFACTS.get(row.object_key);assert.deepEqual(new Uint8Array(await object!.arrayBuffer()),bytes);}
  const emptyEnvelope=await req('/v1/envelopes',{...management(a,{templateId:two,recipients:[{role:'Partner',name:'Ana',email:'ana@example.com'},{role:'Seller',name:'Bo',email:'bo@example.com'},{role:'Legal',name:'Cam',email:'cam@example.com'}]}),headers:{...management(a,{}).headers,'idempotency-key':'empty-1'}});assert.equal(emptyEnvelope.status,201,await emptyEnvelope.clone().text());
  const rotated=await PDFDocument.create();rotated.addPage().setRotation((await import('pdf-lib')).degrees(90));
  const rotateSession=await req('/v1/template-editing-sessions',management(a,{allowedParentOrigin:'https://host.example.com',roles:['Partner']}));const rotateData=await rotateSession.json() as any;const rotateUrl=new URL(rotateData.url);
  const rotateExchange=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:'https://esign.example.com'},body:JSON.stringify({pageId:rotateData.sessionId,code:rotateUrl.hash.slice(1)})});const rotateToken=(await rotateExchange.json() as any).token;
  const sameRoleForm=new FormData();sameRoleForm.set('file',new File([bytes],'synthetic.pdf'));sameRoleForm.set('roles','["Partner","Seller"]');sameRoleForm.set('fields',JSON.stringify([field,{...field,id:'field-2',rect:{...field.rect,x:.15}}]));
  assert.equal((await req('/v1/editor/save',{method:'POST',headers:{authorization:`Bearer ${rotateToken}`,origin:'https://esign.example.com'},body:sameRoleForm})).status,422,'overlapping same-role fields cannot be saved');
  const overlappingForm=new FormData();overlappingForm.set('file',new File([bytes],'synthetic.pdf'));overlappingForm.set('roles','["Partner","Seller"]');overlappingForm.set('fields',JSON.stringify([field,{...field,id:'field-2',role:'Seller',rect:{...field.rect,x:.15}}]));
  assert.equal((await req('/v1/editor/save',{method:'POST',headers:{authorization:`Bearer ${rotateToken}`,origin:'https://esign.example.com'},body:overlappingForm})).status,422,'overlapping cross-role fields cannot be saved');
  const rotateForm=new FormData();rotateForm.set('file',new File([await rotated.save()],'rotated.pdf'));rotateForm.set('roles','["Partner"]');rotateForm.set('fields','[]');
  assert.equal((await req('/v1/editor/save',{method:'POST',headers:{authorization:`Bearer ${rotateToken}`,origin:'https://esign.example.com'},body:rotateForm})).status,422);
  assert.equal((await req('/v1/me',{headers:{authorization:`Bearer ${rotateToken}`}})).status,401);
  assert.equal((await req('/v1/editor/current',{headers:{authorization:`Bearer ${a}`}})).status,401);
  const before=(await env.ARTIFACTS.list()).objects.length;
  const brokenDb=new Proxy(db,{get(target,property){if(property==='batch')return async()=>{throw new Error('injected database failure');};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
  const failedForm=new FormData();failedForm.set('file',new File([bytes],'test.pdf'));failedForm.set('roles','["Partner"]');failedForm.set('fields',JSON.stringify([field]));
  const failed=await app.fetch(new Request('https://esign.example.com/v1/editor/save',{method:'POST',headers:{authorization:`Bearer ${rotateToken}`,origin:'https://esign.example.com'},body:failedForm}),{...env,DB:brokenDb});assert.equal(failed.status,503);assert.equal((await env.ARTIFACTS.list()).objects.length,before+1,'ambiguous failure preserves uploaded object');
 }finally{await mf.dispose();}
});
