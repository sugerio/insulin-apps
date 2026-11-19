import {embedderAllowed,frameAncestors} from './signing-page.ts';
import { sessionToken } from './session-header.ts';
import {isProd} from './environment.ts';
import type {Env} from './app.ts';
import {bodyLimit} from 'hono/body-limit';
import {PDFDocument} from 'pdf-lib';
import {issueEditorPage,editorPageParent,exchangeEditorPage,editorPageContext,editorCodeOpen} from './editor-session.ts';
import {editorOriginAllowed,syncEditorOrigins} from './access.ts';
import {validateTemplateFields,assertNoOverlappingFields,assertEditorSigningFields,parsePrefillCatalog} from './fields.ts';
import type {Hono} from 'hono';
import type { BlobStore } from './blob-store.ts';
import {parseMetadata,parseTemplateName,unknownKeys} from './metadata.ts';
import {storedDefaultSigners} from './default-signers.ts';
import {atLeast,documentRole,parseShares,shareInserts,sharesFor} from './ownership.ts';
import {mergeTags,parseTags,tagsOf,tagWrites} from './tags.ts';
import {draftRoleLabels,draftRoles,envelopeDocument,initialDocumentId} from './envelope-documents.ts';
import {pdfRefusalBody,PdfUploadRefused,preparePdfUpload,uploadRecord} from './pdf-upload.ts';

const limit=5*1024*1024;
const sha256=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),n=>n.toString(16).padStart(2,'0')).join('');
async function stagedBytes(bucket:BlobStore,key:string,hash:string){const object=await bucket.get(key);if(!object||object.size<1||object.size>limit)throw new Error('Source unavailable');const bytes=new Uint8Array(await object.arrayBuffer());if(await sha256(bytes)!==hash)throw new Error('Source changed');return bytes;}
function rolesValid(value:unknown,caseSensitive=false):value is string[]{return Array.isArray(value)&&value.length>0&&value.length<=20&&value.every(r=>typeof r==='string'&&r===r.trim()&&r.length>0&&r.length<=64)&&new Set(value.map(r=>caseSensitive?r:r.toLowerCase())).size===value.length;}
/** The origins that may host the editor: the app's own first, then ESIGN_FRAME_ANCESTORS, without repeats. */
export function editorOrigins(own:string,frameAncestorsSetting:string|undefined,prod:boolean):string[]{return [...new Set([own,...frameAncestors(frameAncestorsSetting,prod)])];}
function sameOrigin(request:Request){const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
async function contextFor(c:import('hono').Context<Env>){const token=sessionToken(name=>c.req.header(name));if(!token)throw new Error('unauthorized');return editorPageContext(c.env.DB,token,Date.now());}
/**
 * The embedded field editor. The host (through the management API, as its organization) starts an
 * editing session for one of the deployment's editor origins and frames `/editor/page/:id#<code>`;
 * the page exchanges the code for an editor token and uses `/api/public/editor/*` with it.
 */
export function mountEditorRoutes(app:Hono<Env>){
 // The editor origins the deployment allows, where the editor's SQL reads them: the app's own origin,
 // whose Templates page hosts the editor, and the hosts in ESIGN_FRAME_ANCESTORS.
 const syncOrigins=async(c:import('hono').Context<Env>,next:import('hono').Next)=>{await syncEditorOrigins(c.env.DB,editorOrigins(new URL(c.req.url).origin,c.env.SIGNING_PAGE_FRAME_ANCESTORS,isProd(c.env)));await next();};
 app.use('/api/template-editing-sessions',syncOrigins);app.use('/api/template-editing-sessions/*',syncOrigins);app.use('/api/public/editor/*',syncOrigins);
 app.post('/api/template-editing-sessions',bodyLimit({maxSize:32768}),async c=>{
  let input:{allowedParentOrigin?:unknown;sourceTemplateId?:unknown;roles?:unknown;name?:unknown;metadata?:unknown;tags?:unknown;share?:unknown;replace?:unknown;envelopeId?:unknown;prefill?:unknown};try{input=await c.req.json();}catch{return c.json({error:'invalid_json'},400);}
  if(input&&typeof input==='object'&&!Array.isArray(input)){const unknown=unknownKeys(input,['allowedParentOrigin','sourceTemplateId','roles','name','metadata','tags','share','replace','envelopeId','prefill']);if(unknown.length)return c.json({error:'unknown_field',fields:unknown},422);}
  // `envelopeId`: the fields of an envelope draft with an uploaded document (envelope-documents.ts), for its editors,
  // admins and owner: its roles are its signers', its document the one uploaded, and saving writes the draft's fields.
  if(input&&typeof input==='object'&&input.envelopeId!==undefined){
   if(typeof input.envelopeId!=='string'||typeof input.allowedParentOrigin!=='string'||['sourceTemplateId','roles','name','metadata','tags','share','replace','prefill'].some(k=>(input as Record<string,unknown>)[k]!==undefined))return c.json({error:'invalid_session'},422);
   const tenant=c.get('tenantId'),envelopeId=input.envelopeId;
   const found=await documentRole(c.env.DB,tenant,c.get('caller'),'envelope',envelopeId);
   if(!found)return c.json({error:'not_found'},404);
   if(!atLeast(found.role,'editor'))return c.json({error:'forbidden',role:found.role},403);
   // The document the editor opens on: its fields are saved only while it is still the draft's document.
   const draft=await c.env.DB.prepare("SELECT status,template_id,draft_json,(SELECT a.sha256 FROM artifacts a WHERE a.id=? AND a.envelope_id=envelopes.id) AS document_sha256 FROM envelopes WHERE id=? AND tenant_id=?").bind(initialDocumentId(envelopeId),envelopeId,tenant).first<{status:string;template_id:string|null;draft_json:string|null;document_sha256:string|null}>();
   if(draft?.status!=='DRAFT'||draft.template_id!==null)return c.json({error:'not_an_upload_draft'},409);
   if(!draft.document_sha256)return c.json({error:'document_required'},409);
   const roles=draftRoles(draft.draft_json);
   if(!roles)return c.json({error:'invalid_roles'},422);
   let issued:{pageId:string;code:string};try{issued=await issueEditorPage(c.env.DB,tenant,input.allowedParentOrigin,Date.now(),{roles,ownerUserId:c.get('caller').userId,envelopeId,sourceSha256:draft.document_sha256});}catch{return c.json({error:'origin_not_allowed'},403);}
   const url=new URL(`/editor/page/${issued.pageId}`,c.req.url);url.hash=issued.code;
   c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');return c.json({sessionId:issued.pageId,url:url.toString()},201);
  }
  // The name and metadata the saved template gets (metadata.ts); without them, an edited template keeps its source's.
  // Its owner is the caller, with their tags (and theirs on the source) and the shares asked for (ownership.ts).
  // `prefill`: the pre-filled fields the host fills in when it sends ([{name,label}], fields.ts): the editor offers those
  // to place, and no add of its own; without it, the template's author names their own.
  const templateName=parseTemplateName(input?.name),templateMetadata=parseMetadata(input?.metadata);
  const tags=parseTags(input?.tags),shares=parseShares(input?.share),prefillCatalog=parsePrefillCatalog(input?.prefill);
  if(templateName==='invalid'||templateMetadata==='invalid'||tags==='invalid'||shares==='invalid'||prefillCatalog==='invalid')return c.json({error:'invalid_session'},422);
  if(!input||typeof input.allowedParentOrigin!=='string'||(input.sourceTemplateId!==undefined&&(typeof input.sourceTemplateId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.sourceTemplateId)))||(input.roles!==undefined&&!rolesValid(input.roles)))return c.json({error:'invalid_session'},422);
  const tenant=c.get('tenantId'),caller=c.get('caller');
  let sourceHash:string|null=null;
  // A copy of a template the caller sees only. `replace`: the saved template is the source's new version, which takes
  // its place (its owner, shares and everyone's tags carry over, and it is no longer listed): its editors, admins and
  // owner only, and only while it is the current version. Fields never change in place: envelopes in flight sign with
  // the fields of the template they were sent from.
  const replace=input.replace===true;
  if(input.replace!==undefined&&typeof input.replace!=='boolean'||(replace&&!input.sourceTemplateId))return c.json({error:'invalid_session'},422);
  if(input.sourceTemplateId){
   const found=await documentRole(c.env.DB,tenant,caller,'template',input.sourceTemplateId as string);
   if(!found)return c.json({error:'not_found'},404);
   if(replace&&!atLeast(found.role,'editor'))return c.json({error:'forbidden',role:found.role},403);
  }
  if(input.sourceTemplateId){const source=await c.env.DB.prepare('SELECT object_key,archived_at FROM templates WHERE id=? AND tenant_id=?').bind(input.sourceTemplateId,tenant).first<{object_key:string;archived_at:number|null}>();if(!source)return c.json({error:'not_found'},404);
   if(replace&&source.archived_at!==null)return c.json({error:'not_current'},409);
   try{const object=await c.env.ARTIFACTS.get(source.object_key);if(!object||object.size<1||object.size>limit)throw new Error('Source unavailable');sourceHash=await sha256(new Uint8Array(await object.arrayBuffer()));}catch{return c.json({error:'source_unavailable'},503);}
  }
  const given=sharesFor(shares,caller);
  const allTags=mergeTags(tags,input.sourceTemplateId?await tagsOf(c.env.DB,tenant,caller.userId,'template',input.sourceTemplateId as string):[]);
  let issued:{pageId:string;code:string};try{issued=await issueEditorPage(c.env.DB,tenant,input.allowedParentOrigin,Date.now(),{sourceTemplateId:(input.sourceTemplateId as string|undefined)??null,sourceSha256:sourceHash,roles:(input.roles as string[]|undefined)??[],templateName,templateMetadata,ownerUserId:caller.userId,shares:replace?[]:given,tags:replace?[]:allTags,replacesSource:replace,prefillCatalog});}catch{return c.json({error:'origin_not_allowed'},403);}
  const url=new URL(`/editor/page/${issued.pageId}`,c.req.url);url.hash=issued.code;
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');return c.json({sessionId:issued.pageId,url:url.toString()},201);
 });
 app.post('/api/template-editing-sessions/:id/source',bodyLimit({maxSize:limit}),async c=>{
  const pageId=c.req.param('id'),tenant=c.get('tenantId'),owner=c.get('caller').userId;
  // A source can be staged only before the page is opened: while the session's code is unused and unexpired; by whoever opened the session.
  const row=await c.env.DB.prepare(`SELECT x.source_template_id,x.staged_object_key,x.envelope_id,${editorCodeOpen('x')} AS open FROM editor_sessions x WHERE x.id=? AND x.tenant_id=? AND x.owner_user_id=? AND ${editorOriginAllowed('x.tenant_id','x.parent_origin')}`).bind(Date.now(),pageId,tenant,owner).first<{source_template_id:string|null;staged_object_key:string|null;envelope_id:string|null;open:number}>();
  if(!row)return c.json({error:'not_found'},404);
  if(row.source_template_id||row.staged_object_key||row.envelope_id||!row.open)return c.json({error:'source_immutable'},409);
  if(c.req.header('content-type')!=='application/pdf')return c.json({error:'invalid_file'},422);
  const bytes=new Uint8Array(await c.req.arrayBuffer());if(bytes.length<5||bytes.length>limit||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')return c.json({error:'invalid_file'},422);
  // Flattened and reoriented as any upload is (pdf-upload.ts); the template it saves keeps the record of it.
  let prepared;try{prepared=await preparePdfUpload(bytes,{route:'editor-source',tenantId:tenant,subjectId:pageId});}catch(error){if(error instanceof PdfUploadRefused)return c.json(pdfRefusalBody('invalid_file',error),422);throw error;}
  const [uploadedSha256,changesJson]=uploadRecord(prepared);
  const hash=prepared.sha256,key=`editor-sources/${pageId}/${crypto.randomUUID()}.pdf`;
  const stored=await c.env.ARTIFACTS.put(key,prepared.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});if(!stored)return c.json({error:'storage_conflict'},503);
  const result=await c.env.DB.prepare(`UPDATE editor_sessions AS x SET staged_object_key=?,staged_sha256=?,staged_uploaded_sha256=?,staged_changes_json=? WHERE x.id=? AND x.tenant_id=? AND x.owner_user_id=? AND x.source_template_id IS NULL AND x.staged_object_key IS NULL AND ${editorCodeOpen('x')} AND ${editorOriginAllowed('x.tenant_id','x.parent_origin')}`).bind(key,hash,uploadedSha256,changesJson,pageId,tenant,owner,Date.now()).run();
  if(result.meta.changes!==1)return c.json({error:'source_immutable'},409);return c.json({ok:true,changes:prepared.changes},201);
 });
 app.get('/api/template-editing-sessions/:id',async c=>{const row=await c.env.DB.prepare('SELECT result_template_id,envelope_id FROM editor_sessions WHERE id=? AND tenant_id=? AND owner_user_id=?').bind(c.req.param('id'),c.get('tenantId'),c.get('caller').userId).first<{result_template_id:string|null;envelope_id:string|null}>();if(!row)return c.json({error:'not_found'},404);c.header('Cache-Control','no-store');return c.json({templateId:row.result_template_id,...(row.envelope_id?{envelopeId:row.envelope_id}:{})});});
 app.post('/api/public/editor/exchange',bodyLimit({maxSize:1024}),async c=>{if(!sameOrigin(c.req.raw))return c.json({error:'origin'},403);let data:{pageId?:unknown;code?:unknown;embedded?:unknown;embedder?:unknown;embedders?:unknown};try{data=await c.req.json();}catch{return c.json({error:'invalid_json'},400);}if(!data||typeof data.pageId!=='string'||typeof data.code!=='string')return c.json({error:'invalid_code'},401);
  // Only the session's parent may frame the editor (signing-page.ts).
  const parent=await editorPageParent(c.env.DB,data.pageId,Date.now());if(!embedderAllowed(data,new URL(c.req.url).origin,parent?[parent]:[]))return c.json({error:'embedder_not_allowed'},403);
  try{const token=await exchangeEditorPage(c.env.DB,data.pageId,data.code,Date.now());c.header('Cache-Control','no-store');return c.json({token});}catch{return c.json({error:'invalid_code'},401);}});
 app.use('/api/public/editor/*',async(c,next)=>{if(!sameOrigin(c.req.raw))return c.json({error:'origin'},403);c.header('Cache-Control','no-store');await next();});
 app.get('/api/public/editor/current',async c=>{let session;try{session=await contextFor(c);}catch{return c.json({error:'unauthorized'},401);}
  // An envelope draft's: its roles (fixed when the session opened) with each signer's name, and the fields placed so
  // far for those roles.
  if(session.envelopeId){const row=await c.env.DB.prepare("SELECT fields_json,draft_json FROM envelopes WHERE id=? AND tenant_id=? AND status='DRAFT'").bind(session.envelopeId,session.tenantId).first<{fields_json:string|null;draft_json:string|null}>();if(!row)return c.json({error:'not_found'},404);let fields:unknown=[];try{fields=JSON.parse(row.fields_json??'[]');}catch{fields=[];}return c.json({roles:session.roles,roleLabels:draftRoleLabels(row.draft_json),prefill:false,fields:Array.isArray(fields)?fields.filter((f:{role?:unknown})=>session.roles.includes(f?.role as string)):[],sourceTemplateId:null,hasStagedSource:true,envelopeId:session.envelopeId,parentOrigin:session.parentOrigin});}
  const catalog=session.prefillCatalog?{prefillCatalog:session.prefillCatalog}:{};
  if(!session.sourceTemplateId)return c.json({roles:session.roles,fields:[],sourceTemplateId:null,hasStagedSource:!!session.stagedObjectKey,parentOrigin:session.parentOrigin,...catalog});const row=await c.env.DB.prepare('SELECT roles_json,fields_json FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{roles_json:string;fields_json:string}>();if(!row)return c.json({error:'not_found'},404);return c.json({roles:JSON.parse(row.roles_json),fields:JSON.parse(row.fields_json),sourceTemplateId:session.sourceTemplateId,parentOrigin:session.parentOrigin,...catalog});});
 app.get('/api/public/editor/pdf',async c=>{let session;try{session=await contextFor(c);}catch{return c.json({error:'unauthorized'},401);}if(session.envelopeId){const bytes=await envelopeDocument(c.env.DB,c.env.ARTIFACTS,session.envelopeId);return bytes?new Response(bytes,{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}):c.json({error:'source_unavailable'},409);}if(session.stagedObjectKey&&session.stagedSha256){try{return new Response(await stagedBytes(c.env.ARTIFACTS,session.stagedObjectKey,session.stagedSha256),{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{return c.json({error:'source_unavailable'},409);}}if(!session.sourceTemplateId)return c.json({error:'not_found'},404);if(!session.sourceSha256)return c.json({error:'source_unavailable'},409);try{const row=await c.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{object_key:string}>();if(!row)throw new Error('Source unavailable');return new Response(await stagedBytes(c.env.ARTIFACTS,row.object_key,session.sourceSha256),{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{return c.json({error:'source_unavailable'},409);}});
 app.post('/api/public/editor/save',bodyLimit({maxSize:limit+65536}),async c=>{
  let session;try{session=await contextFor(c);}catch{return c.json({error:'unauthorized'},401);}
  if(!c.req.header('content-type')?.startsWith('multipart/form-data;'))return c.json({error:'multipart_required'},400);
  let form:FormData;try{form=await c.req.formData();}catch{return c.json({error:'invalid_multipart'},400);}
  // `draft`: saved as a draft (templates.status), which starts no envelope and needn't be ready: no Signature field is
  // required yet. A draft is saved again, or saved as active, in place: by the session that saved it, or by one opened
  // to replace it. Nothing was sent from it, so its fields may change. An active template is never a draft again: a
  // new version of one is saved as active only.
  const draftField=form.get('draft');if(draftField!==null&&draftField!=='true'&&draftField!=='false')return c.json({error:'invalid_definition'},422);
  const draft=draftField==='true',status=draft?'draft':'active';
  let target:string|null=null;
  if(session.resultTemplateId){
   // Saved by this session already: again only while that is a draft.
   const saved=await c.env.DB.prepare('SELECT status FROM templates WHERE id=? AND tenant_id=?').bind(session.resultTemplateId,session.tenantId).first<{status:string}>();
   if(saved?.status!=='draft')return c.json({error:'already_saved'},409);
   target=session.resultTemplateId;
  }
  else if(session.replacesSource&&session.sourceTemplateId){
   const source=await c.env.DB.prepare('SELECT status FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{status:string}>();
   if(source?.status==='draft')target=session.sourceTemplateId;
   else if(draft)return c.json({error:'draft_not_allowed'},422);
  }
  let roles:unknown,fields:unknown;try{roles=JSON.parse(String(form.get('roles')));fields=JSON.parse(String(form.get('fields')));}catch{return c.json({error:'invalid_definition'},422);}if(!rolesValid(roles,true))return c.json({error:'invalid_roles'},422);
  // An envelope draft's fields: on its own uploaded document, for the roles its signers have (fixed when the session
  // opened). A draft is saved as it is; ready (without `draft`), every role has a required Signature. Sending it checks
  // them again (app.ts). Only while it is a draft, and while this editor token is live.
  if(session.envelopeId){
   if(form.has('file'))return c.json({error:'source_immutable'},422);
   if(roles.length!==session.roles.length||roles.some((r,i)=>r!==session.roles[i]))return c.json({error:'invalid_roles'},422);
   const document=await envelopeDocument(c.env.DB,c.env.ARTIFACTS,session.envelopeId);
   if(!document)return c.json({error:'source_unavailable'},409);
   // Only on the document they were placed on: an upload meanwhile cleared the fields, for its own document, and an
   // editor opened on the one before is told to open again, before its fields are checked against a document they
   // weren't placed on. A session opened before it recorded its document has none.
   const documentHash=session.sourceSha256??await sha256(document);
   if(documentHash!==await sha256(document))return c.json({error:'source_changed'},409);
   let placed:import('./fields.ts').TemplateField[];
   try{const pdf=await PDFDocument.load(document,{throwOnInvalidObject:true});const pages=pdf.getPages();if(!pages.length||pages.length>100||pages.some(p=>((p.getRotation().angle%360)+360)%360!==0))throw new Error('Unsupported rotation');placed=validateTemplateFields(fields,roles,pages.length);assertNoOverlappingFields(placed);}catch{return c.json({error:'invalid_pdf_or_fields'},422);}
   // An uploaded document has no pre-filled fields: its sender writes on it before uploading it.
   if(placed.some(f=>f.type==='Prefill'))return c.json({error:'prefill_not_supported'},422);
   if(!draft)try{assertEditorSigningFields(placed,roles);}catch(error){return c.json({error:'invalid_signing_fields',message:error instanceof Error?error.message:'Invalid signing fields'},422);}
   const saved=await c.env.DB.prepare(`UPDATE envelopes SET roles_json=?,fields_json=? WHERE id=? AND tenant_id=? AND status='DRAFT' AND template_id IS NULL
     AND (SELECT a.sha256 FROM artifacts a WHERE a.id=? AND a.envelope_id=envelopes.id)=?
     AND EXISTS (SELECT 1 FROM editor_sessions x JOIN access_sessions s ON s.subject_id=x.id AND s.tenant_id=x.tenant_id AND s.origin=x.parent_origin WHERE x.id=? AND x.tenant_id=? AND x.envelope_id=envelopes.id AND ${editorOriginAllowed('x.tenant_id','x.parent_origin')} AND s.scope='editor' AND s.token_hash=? AND s.expires_at>?)`)
     .bind(JSON.stringify(roles),JSON.stringify(placed),session.envelopeId,session.tenantId,initialDocumentId(session.envelopeId),documentHash,session.pageId,session.tenantId,session.tokenHash,Date.now()).run();
   if(saved.meta.changes!==1)return c.json({error:'not_draft'},409);
   return c.json({id:session.envelopeId,status:draft?'draft':'ready'},200);
  }
  if(new Set(roles.map(role=>role.toLowerCase())).size!==roles.length){
   if(!session.sourceTemplateId)return c.json({error:'invalid_roles'},422);
   const source=await c.env.DB.prepare('SELECT roles_json FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{roles_json:string}>();
   let sourceRoles:unknown;try{sourceRoles=JSON.parse(source?.roles_json??'null');}catch{return c.json({error:'invalid_roles'},422);}
   if(!Array.isArray(sourceRoles)||!roles.every((role,index)=>roles.slice(0,index).every(previous=>previous.toLowerCase()!==role.toLowerCase()||(sourceRoles.includes(previous)&&sourceRoles.includes(role)))))return c.json({error:'invalid_roles'},422);
  }
  // A draft saved in place keeps its PDF: its fields are checked against it.
  // The record of what was changed when its PDF was uploaded (pdf-upload.ts), for the template it saves: the staged
  // upload's, the source template's, or this save's own upload's.
  let record:[string|null,string|null]=[null,null];
  let bytes:Uint8Array;if(target){if(form.has('file'))return c.json({error:'source_immutable'},422);const row=await c.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(target,session.tenantId).first<{object_key:string}>();const object=row&&await c.env.ARTIFACTS.get(row.object_key);if(!object||object.size>limit)return c.json({error:'source_unavailable'},409);bytes=new Uint8Array(await object.arrayBuffer());}
  else if(session.stagedObjectKey&&session.stagedSha256){if(form.has('file'))return c.json({error:'source_immutable'},422);try{bytes=await stagedBytes(c.env.ARTIFACTS,session.stagedObjectKey,session.stagedSha256);}catch{return c.json({error:'source_unavailable'},409);}
   const staged=await c.env.DB.prepare('SELECT staged_uploaded_sha256 AS sha,staged_changes_json AS changes FROM editor_sessions WHERE id=? AND tenant_id=?').bind(session.pageId,session.tenantId).first<{sha:string|null;changes:string|null}>();record=[staged?.sha??null,staged?.changes??null];}else if(session.sourceTemplateId){if(form.has('file'))return c.json({error:'source_immutable'},422);if(!session.sourceSha256)return c.json({error:'source_unavailable'},409);try{const row=await c.env.DB.prepare('SELECT object_key,uploaded_sha256,upload_changes_json FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{object_key:string;uploaded_sha256:string|null;upload_changes_json:string|null}>();if(!row)throw new Error('Source unavailable');bytes=await stagedBytes(c.env.ARTIFACTS,row.object_key,session.sourceSha256);record=[row.uploaded_sha256,row.upload_changes_json];}catch{return c.json({error:'source_unavailable'},409);}}else{const file=form.get('file');if(!(file instanceof File)||file.size<1||file.size>limit)return c.json({error:'invalid_file'},422);
   // The fields were placed on the page as the editor showed it, which is the page the rewritten PDF has (pdf-upload.ts).
   try{const prepared=await preparePdfUpload(new Uint8Array(await file.arrayBuffer()),{route:'editor-save',tenantId:session.tenantId,subjectId:session.pageId});bytes=prepared.bytes;record=uploadRecord(prepared);}catch(error){if(error instanceof PdfUploadRefused)return c.json(pdfRefusalBody('invalid_pdf_or_fields',error),422);throw error;}}
  try{const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true});const pages=pdf.getPages();if(!pages.length||pages.length>100||pages.some(p=>((p.getRotation().angle%360)+360)%360!==0))throw new Error('Unsupported rotation');fields=validateTemplateFields(fields,roles,pages.length);assertNoOverlappingFields(fields as import('./fields.ts').TemplateField[]);}catch{return c.json({error:'invalid_pdf_or_fields'},422);}
  if(!draft)try{assertEditorSigningFields(fields as import('./fields.ts').TemplateField[],roles);}catch(error){return c.json({error:'invalid_signing_fields',message:error instanceof Error?error.message:'Invalid signing fields'},422);}
  if(target){
   const row=await c.env.DB.prepare('SELECT status,default_signers_json FROM templates WHERE id=? AND tenant_id=?').bind(target,session.tenantId).first<{status:string;default_signers_json:string}>();
   if(row?.status!=='draft')return c.json({error:'already_saved'},409);
   // The draft as edited: its roles and fields, its default signers for the roles it keeps, and its status. Only while
   // it is a draft, and while this session's editor token is live.
   const live=`EXISTS (SELECT 1 FROM editor_sessions x JOIN access_sessions s ON s.subject_id=x.id AND s.tenant_id=x.tenant_id AND s.origin=x.parent_origin WHERE x.id=? AND x.tenant_id=? AND (x.result_template_id IS NULL OR x.result_template_id=?) AND ${editorOriginAllowed('x.tenant_id','x.parent_origin')} AND s.scope='editor' AND s.token_hash=? AND s.expires_at>?)`;
   const now=Date.now();
   let updated:D1Result;
   try{[updated]=await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE templates SET roles_json=?,fields_json=?,default_signers_json=?,status=? WHERE id=? AND tenant_id=? AND status='draft' AND ${live}`).bind(JSON.stringify(roles),JSON.stringify(fields),JSON.stringify(storedDefaultSigners(row.default_signers_json,roles)),status,target,session.tenantId,session.pageId,session.tenantId,target,session.tokenHash,now),
    c.env.DB.prepare('UPDATE editor_sessions SET result_template_id=? WHERE id=? AND tenant_id=? AND (result_template_id IS NULL OR result_template_id=?) AND changes()=1').bind(target,session.pageId,session.tenantId,target),
   ]);}catch{return c.json({error:'save_failed'},503);}
   if(updated.meta.changes!==1)return c.json({error:'already_saved'},409);
   return c.json({id:target,status},200);
  }
  // The session's name and metadata, else those of the template it edits.
  // The source template's default signers too, for the roles the saved template keeps (a new PDF's are set after
  // the save: POST /api/templates/:id/default-signers).
  let labels={name:session.templateName as string|null,metadata:session.templateMetadataJson,signers:null as string|null};
  if(session.sourceTemplateId){const source=await c.env.DB.prepare('SELECT name,metadata_json,default_signers_json FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{name:string|null;metadata_json:string;default_signers_json:string}>();if(source)labels={name:labels.name??source.name,metadata:labels.metadata??source.metadata_json,signers:source.default_signers_json};}
  const signers=storedDefaultSigners(labels.signers,roles);
  // A new version keeps its source's owner, and replaces it: the source is archived (taken off the lists), if it isn't yet.
  let owner=session.ownerUserId;
  if(session.replacesSource){
   const source=await c.env.DB.prepare('SELECT owner_user_id FROM templates WHERE id=? AND tenant_id=?').bind(session.sourceTemplateId,session.tenantId).first<{owner_user_id:string}>();
   if(!source)return c.json({error:'not_found'},404);
   owner=source.owner_user_id;
  }
  const id=crypto.randomUUID(),key=`templates/${id}/source.pdf`;const stored=await c.env.ARTIFACTS.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});if(!stored)return c.json({error:'storage_conflict'},503);
  // The template row first: nothing references it and its id is returned only after the commit
  // point, a compare-and-set that records it as this page's result while the page is still unsaved
  // and the editor token of this request is still live. A row whose CAS lost is an unreachable,
  // harmless orphan.
  let saved:D1Result;
  try{[,saved]=await c.env.DB.batch([
   c.env.DB.prepare('INSERT INTO templates (id,tenant_id,object_key,roles_json,fields_json,created_at,name,metadata_json,default_signers_json,owner_user_id,status,uploaded_sha256,upload_changes_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,session.tenantId,key,JSON.stringify(roles),JSON.stringify(fields),Date.now(),labels.name,labels.metadata??'{}',JSON.stringify(signers),owner,status,...record),
   c.env.DB.prepare(`UPDATE editor_sessions AS x SET result_template_id=? WHERE x.id=? AND x.tenant_id=? AND x.result_template_id IS NULL AND ${editorOriginAllowed('x.tenant_id','x.parent_origin')} AND EXISTS (SELECT 1 FROM access_sessions s WHERE s.scope='editor' AND s.token_hash=? AND s.subject_id=x.id AND s.tenant_id=x.tenant_id AND s.origin=x.parent_origin AND s.expires_at>?)`).bind(id,session.pageId,session.tenantId,session.tokenHash,Date.now()),
   // Owned by whoever opened the session, shared and tagged as they asked; or, for a new version, shared and tagged as
   // its source was, which it replaces.
   ...(session.replacesSource?[
    c.env.DB.prepare(`INSERT INTO document_shares (tenant_id,resource_type,resource_id,grantee_email_key,grantee_email,role,granted_by,granted_at) SELECT tenant_id,'template',?,grantee_email_key,grantee_email,role,granted_by,granted_at FROM document_shares WHERE tenant_id=? AND resource_type='template' AND resource_id=?`).bind(id,session.tenantId,session.sourceTemplateId),
    c.env.DB.prepare(`INSERT INTO document_tags (tenant_id,user_id,resource_type,resource_id,tag_key,tag) SELECT tenant_id,user_id,'template',?,tag_key,tag FROM document_tags WHERE tenant_id=? AND resource_type='template' AND resource_id=?`).bind(id,session.tenantId,session.sourceTemplateId),
    // Only while the source is the current version: one archived meanwhile (another session replaced it) would get a
    // null status, which the table refuses, and nothing in the batch is written.
    c.env.DB.prepare('UPDATE templates SET status=CASE WHEN archived_at IS NULL THEN status ELSE NULL END,archived_at=? WHERE id=? AND tenant_id=?').bind(Date.now(),session.sourceTemplateId,session.tenantId),
   ]:[
    ...shareInserts(c.env.DB,session.tenantId,'template',id,session.shares,session.ownerUserId,Date.now()),
    ...tagWrites(c.env.DB,session.tenantId,session.ownerUserId,'template',id,session.tags),
   ]),
  ]);}catch{saved={meta:{changes:0}} as D1Result;}
  if(saved.meta.changes!==1){const result=await c.env.DB.prepare('SELECT result_template_id FROM editor_sessions WHERE id=?').bind(session.pageId).first<{result_template_id:string|null}>();if(result?.result_template_id)return c.json({error:'already_saved'},409);
   if(session.replacesSource&&await c.env.DB.prepare('SELECT 1 FROM templates WHERE id=? AND tenant_id=? AND archived_at IS NOT NULL').bind(session.sourceTemplateId,session.tenantId).first())return c.json({error:'not_current'},409);
   return c.json({error:'save_failed'},503);}
  return c.json({id,status},201);
 });
}
