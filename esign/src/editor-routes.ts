import {EMBEDDABLE_HEADERS} from './signing-page.ts';
import {bodyLimit} from 'hono/body-limit';
import {PDFDocument} from 'pdf-lib';
import {issueEditorPage,editorPageParent,exchangeEditorPage,editorPageContext} from './editor-session.ts';
import {validateTemplateFields,assertNoOverlappingFields,assertEditorSigningFields} from './template-fields.ts';
import type {Hono,MiddlewareHandler} from 'hono';

type Env={Bindings:{DB:D1Database;ARTIFACTS:R2Bucket;ASSETS?:Fetcher};Variables:{tenantId:string}};
const limit=5*1024*1024;
const sha256=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),n=>n.toString(16).padStart(2,'0')).join('');
async function stagedBytes(bucket:R2Bucket,key:string,hash:string){const object=await bucket.get(key);if(!object||object.size<1||object.size>limit)throw new Error('Source unavailable');const bytes=new Uint8Array(await object.arrayBuffer());if(await sha256(bytes)!==hash)throw new Error('Source changed');return bytes;}
function rolesValid(value:unknown,caseSensitive=false):value is string[]{return Array.isArray(value)&&value.length>0&&value.length<=20&&value.every(r=>typeof r==='string'&&r===r.trim()&&r.length>0&&r.length<=64)&&new Set(value.map(r=>caseSensitive?r:r.toLowerCase())).size===value.length;}
function sameOrigin(request:Request){const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
async function contextFor(c:import('hono').Context<Env>){const match=/^Bearer ([a-f0-9]{64})$/.exec(c.req.header('authorization')??'');if(!match)throw new Error('unauthorized');return editorPageContext(c.env.DB,match[1],Date.now());}
// Injection must provide a security-reviewed network boundary; the Worker supplies none by default.
type SourceDownloader=(url:string,signal:AbortSignal)=>Promise<Uint8Array>;
export function mountEditorRoutes(app:Hono<Env>,managementAuth:MiddlewareHandler<Env>,options:{downloadSource?:SourceDownloader}={}){
 app.use('/v1/template-editing-sessions',managementAuth);app.use('/v1/template-editing-sessions/*',managementAuth);
 app.post('/v1/template-editing-sessions',bodyLimit({maxSize:8192}),async c=>{
  let input:{allowedParentOrigin?:unknown;sourceTemplateId?:unknown;sourceUrl?:unknown;roles?:unknown};try{input=await c.req.json();}catch{return c.json({error:'invalid_json'},400);}
  if(!input||typeof input.allowedParentOrigin!=='string'||(input.sourceTemplateId!==undefined&&(typeof input.sourceTemplateId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.sourceTemplateId)))||(input.roles!==undefined&&!rolesValid(input.roles)))return c.json({error:'invalid_session'},422);
  let sourceUrl:string|undefined;
  if(input.sourceUrl!==undefined){if(typeof input.sourceUrl!=='string'||input.sourceUrl.length>4096||input.sourceTemplateId!==undefined)return c.json({error:'invalid_session'},422);try{const u=new URL(input.sourceUrl);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port)throw new Error('invalid');sourceUrl=u.href;}catch{return c.json({error:'invalid_session'},422);}}
  const tenant=c.get('tenantId');
  let sourceHash:string|null=null;
  if(input.sourceTemplateId){const source=await c.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(input.sourceTemplateId,tenant).first<{object_key:string}>();if(!source)return c.json({error:'not_found'},404);
   try{const object=await c.env.ARTIFACTS.get(source.object_key);if(!object||object.size<1||object.size>limit)throw new Error('Source unavailable');sourceHash=await sha256(new Uint8Array(await object.arrayBuffer()));}catch{return c.json({error:'source_unavailable'},503);}
  }
  let issued:{pageId:string;code:string};try{issued=await issueEditorPage(c.env.DB,tenant,input.allowedParentOrigin,Date.now());}catch{return c.json({error:'origin_not_allowed'},403);}
  let stagedKey:string|null=null,stagedHash:string|null=null;
  if(sourceUrl){
   if(!options.downloadSource)return c.json({error:'source_unavailable'},503);
   const abort=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
   try{
    const expired=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{abort.abort();reject(new Error('timeout'));},15000);});
    const bytes=await Promise.race([options.downloadSource(sourceUrl,abort.signal),expired]);
    if(!(bytes instanceof Uint8Array)||bytes.length<5||bytes.length>limit||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('invalid');
    const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true});if(!pdf.getPageCount()||pdf.getPageCount()>100)throw new Error('invalid');
    stagedHash=await sha256(bytes);stagedKey=`editor-sources/${issued.pageId}/${crypto.randomUUID()}.pdf`;
    if(!await c.env.ARTIFACTS.put(stagedKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}}))throw new Error('storage');
   }catch{return c.json({error:'source_unavailable'},503);}finally{if(timeout)clearTimeout(timeout);abort.abort();}
  }
  await c.env.DB.prepare('UPDATE editor_page_entries SET source_template_id=?,source_sha256=?,preset_roles_json=?,staged_object_key=?,staged_sha256=? WHERE page_id=?').bind(input.sourceTemplateId??null,sourceHash,JSON.stringify(input.roles??[]),stagedKey,stagedHash,issued.pageId).run();
  const url=new URL(`/editor/page/${issued.pageId}`,c.req.url);url.hash=issued.code;
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');return c.json({sessionId:issued.pageId,url:url.toString()},201);
 });
 app.post('/v1/template-editing-sessions/:id/source',bodyLimit({maxSize:limit}),async c=>{
  const pageId=c.req.param('id'),tenant=c.get('tenantId');
  const row=await c.env.DB.prepare('SELECT source_template_id,staged_object_key,used_at,expires_at FROM editor_page_entries e WHERE page_id=? AND tenant_id=? AND EXISTS (SELECT 1 FROM editor_allowed_origins o WHERE o.tenant_id=e.tenant_id AND o.origin=e.parent_origin)').bind(pageId,tenant).first<{source_template_id:string|null;staged_object_key:string|null;used_at:number|null;expires_at:number}>();
  if(!row)return c.json({error:'not_found'},404);
  if(row.source_template_id||row.staged_object_key||row.used_at||row.expires_at<=Date.now())return c.json({error:'source_immutable'},409);
  if(c.req.header('content-type')!=='application/pdf')return c.json({error:'invalid_file'},422);
  const bytes=new Uint8Array(await c.req.arrayBuffer());if(bytes.length<5||bytes.length>limit||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')return c.json({error:'invalid_file'},422);
  try{const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true});if(!pdf.getPageCount()||pdf.getPageCount()>100)throw new Error('pages');}catch{return c.json({error:'invalid_file'},422);}
  const hash=await sha256(bytes),key=`editor-sources/${pageId}/${crypto.randomUUID()}.pdf`;
  const stored=await c.env.ARTIFACTS.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});if(!stored)return c.json({error:'storage_conflict'},503);
  const result=await c.env.DB.prepare('UPDATE editor_page_entries SET staged_object_key=?,staged_sha256=? WHERE page_id=? AND tenant_id=? AND source_template_id IS NULL AND staged_object_key IS NULL AND used_at IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM editor_allowed_origins o WHERE o.tenant_id=editor_page_entries.tenant_id AND o.origin=editor_page_entries.parent_origin)').bind(key,hash,pageId,tenant,Date.now()).run();
  if(result.meta.changes!==1)return c.json({error:'source_immutable'},409);return c.json({ok:true},201);
 });
 app.get('/v1/template-editing-sessions/:id',async c=>{const row=await c.env.DB.prepare('SELECT result_template_id FROM editor_page_entries WHERE page_id=? AND tenant_id=?').bind(c.req.param('id'),c.get('tenantId')).first<{result_template_id:string|null}>();if(!row)return c.json({error:'not_found'},404);c.header('Cache-Control','no-store');return c.json({templateId:row.result_template_id});});
 app.get('/editor/page/:id',async c=>{const parent=await editorPageParent(c.env.DB,c.req.param('id'),Date.now());if(!parent||!c.env.ASSETS)return c.notFound();const source=await c.env.ASSETS.fetch(new Request(new URL('/editor.html',c.req.url)));if(!source.ok)return c.notFound();const headers=new Headers(source.headers);headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${parent}`);headers.set('Cache-Control','no-store');headers.set('Referrer-Policy','no-referrer');headers.set('X-Content-Type-Options','nosniff');for(const [name,value] of Object.entries(EMBEDDABLE_HEADERS))headers.set(name,value);return new Response(source.body,{status:200,headers});});
 app.post('/v1/editor/exchange',bodyLimit({maxSize:1024}),async c=>{if(!sameOrigin(c.req.raw))return c.json({error:'origin'},403);let data:{pageId?:unknown;code?:unknown};try{data=await c.req.json();}catch{return c.json({error:'invalid_json'},400);}if(!data||typeof data.pageId!=='string'||typeof data.code!=='string')return c.json({error:'invalid_code'},401);try{const token=await exchangeEditorPage(c.env.DB,data.pageId,data.code,Date.now());c.header('Cache-Control','no-store');return c.json({token});}catch{return c.json({error:'invalid_code'},401);}});
 app.use('/v1/editor/*',async(c,next)=>{if(!sameOrigin(c.req.raw))return c.json({error:'origin'},403);c.header('Cache-Control','no-store');await next();});
 app.get('/v1/editor/current',async c=>{let session;try{session=await contextFor(c);}catch{return c.json({error:'unauthorized'},401);}if(!session.sourceTemplateId)return c.json({roles:session.roles,fields:[],sourceTemplateId:null,hasStagedSource:!!session.stagedObjectKey,parentOrigin:session.parentOrigin});const row=await c.env.DB.prepare('SELECT roles_json,fields_json FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{roles_json:string;fields_json:string}>();if(!row)return c.json({error:'not_found'},404);return c.json({roles:JSON.parse(row.roles_json),fields:JSON.parse(row.fields_json),sourceTemplateId:session.sourceTemplateId,parentOrigin:session.parentOrigin});});
 app.get('/v1/editor/pdf',async c=>{let session;try{session=await contextFor(c);}catch{return c.json({error:'unauthorized'},401);}if(session.stagedObjectKey&&session.stagedSha256){try{return new Response(await stagedBytes(c.env.ARTIFACTS,session.stagedObjectKey,session.stagedSha256),{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{return c.json({error:'source_unavailable'},409);}}if(!session.sourceTemplateId)return c.json({error:'not_found'},404);if(!session.sourceSha256)return c.json({error:'source_unavailable'},409);try{const row=await c.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{object_key:string}>();if(!row)throw new Error('Source unavailable');return new Response(await stagedBytes(c.env.ARTIFACTS,row.object_key,session.sourceSha256),{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{return c.json({error:'source_unavailable'},409);}});
 app.post('/v1/editor/save',bodyLimit({maxSize:limit+65536}),async c=>{
  let session;try{session=await contextFor(c);}catch{return c.json({error:'unauthorized'},401);}if(session.resultTemplateId)return c.json({error:'already_saved'},409);
  if(!c.req.header('content-type')?.startsWith('multipart/form-data;'))return c.json({error:'multipart_required'},400);
  let form:FormData;try{form=await c.req.formData();}catch{return c.json({error:'invalid_multipart'},400);}
  let roles:unknown,fields:unknown;try{roles=JSON.parse(String(form.get('roles')));fields=JSON.parse(String(form.get('fields')));}catch{return c.json({error:'invalid_definition'},422);}if(!rolesValid(roles,true))return c.json({error:'invalid_roles'},422);
  if(new Set(roles.map(role=>role.toLowerCase())).size!==roles.length){
   if(!session.sourceTemplateId)return c.json({error:'invalid_roles'},422);
   const source=await c.env.DB.prepare('SELECT roles_json FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{roles_json:string}>();
   let sourceRoles:unknown;try{sourceRoles=JSON.parse(source?.roles_json??'null');}catch{return c.json({error:'invalid_roles'},422);}
   if(!Array.isArray(sourceRoles)||!roles.every((role,index)=>roles.slice(0,index).every(previous=>previous.toLowerCase()!==role.toLowerCase()||(sourceRoles.includes(previous)&&sourceRoles.includes(role)))))return c.json({error:'invalid_roles'},422);
  }
  let bytes:Uint8Array;if(session.stagedObjectKey&&session.stagedSha256){if(form.has('file'))return c.json({error:'source_immutable'},422);try{bytes=await stagedBytes(c.env.ARTIFACTS,session.stagedObjectKey,session.stagedSha256);}catch{return c.json({error:'source_unavailable'},409);}}else if(session.sourceTemplateId){if(form.has('file'))return c.json({error:'source_immutable'},422);if(!session.sourceSha256)return c.json({error:'source_unavailable'},409);try{const row=await c.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{object_key:string}>();if(!row)throw new Error('Source unavailable');bytes=await stagedBytes(c.env.ARTIFACTS,row.object_key,session.sourceSha256);}catch{return c.json({error:'source_unavailable'},409);}}else{const file=form.get('file');if(!(file instanceof File)||file.size<1||file.size>limit)return c.json({error:'invalid_file'},422);bytes=new Uint8Array(await file.arrayBuffer());}
  try{const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true});const pages=pdf.getPages();if(!pages.length||pages.length>100||pages.some(p=>((p.getRotation().angle%360)+360)%360!==0))throw new Error('Unsupported rotation');fields=validateTemplateFields(fields,roles,pages.length);assertNoOverlappingFields(fields as import('./template-fields.ts').TemplateField[]);}catch{return c.json({error:'invalid_pdf_or_fields'},422);}
  try{assertEditorSigningFields(fields as import('./template-fields.ts').TemplateField[],roles);}catch(error){return c.json({error:'invalid_signing_fields',message:error instanceof Error?error.message:'Invalid signing fields'},422);}
  const id=crypto.randomUUID(),key=`templates/${id}/source.pdf`;const stored=await c.env.ARTIFACTS.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});if(!stored)return c.json({error:'storage_conflict'},503);
  try{await c.env.DB.batch([
   c.env.DB.prepare('INSERT INTO editor_page_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM editor_page_entries e JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin JOIN editor_page_tokens t ON t.page_id=e.page_id WHERE e.page_id=? AND e.tenant_id=? AND e.result_template_id IS NULL AND t.expires_at>?) THEN 1 ELSE 0 END').bind(session.pageId,session.tenantId,Date.now()),
   c.env.DB.prepare('INSERT INTO templates (id,tenant_id,object_key,roles_json,fields_json,created_at) VALUES (?,?,?,?,?,?)').bind(id,session.tenantId,key,JSON.stringify(roles),JSON.stringify(fields),Date.now()),
   c.env.DB.prepare('UPDATE editor_page_entries SET result_template_id=? WHERE page_id=?').bind(id,session.pageId),
   c.env.DB.prepare('DELETE FROM editor_page_assertions')
  ]);}catch{const result=await c.env.DB.prepare('SELECT result_template_id FROM editor_page_entries WHERE page_id=?').bind(session.pageId).first<{result_template_id:string|null}>();if(result?.result_template_id)return c.json({error:'already_saved'},409);return c.json({error:'save_failed'},503);}
  return c.json({id},201);
 });
}
