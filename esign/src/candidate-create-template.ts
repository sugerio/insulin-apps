import {PDFDocument} from 'pdf-lib';
import {managementCredential} from './candidate-recovery-authorization.ts';
import {putCandidatePreparationObject} from './candidate-preparation-object.ts';
import {positionedV3Fields} from './positioned-v3-snapshot.ts';
import {validatePositionedPdf,validatePositionedPlacement} from './positioned-template.ts';

const hash=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
const hashText=(text:string)=>hash(new TextEncoder().encode(text));

type TemplateEnv = {DB:D1Database;ARTIFACTS:R2Bucket;CANDIDATE_TEMPLATE_WINDOW_MS?:string;CANDIDATE_TEMPLATE_TENANT_LIMIT?:string;CANDIDATE_TEMPLATE_DATABASE_LIMIT?:string;CANDIDATE_TEMPLATE_RETAINED_LIMIT?:string;CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT?:string};
export function candidateTemplatePolicy(env: TemplateEnv): number[] {
 const raw=[env.CANDIDATE_TEMPLATE_WINDOW_MS,env.CANDIDATE_TEMPLATE_TENANT_LIMIT,env.CANDIDATE_TEMPLATE_DATABASE_LIMIT,env.CANDIDATE_TEMPLATE_RETAINED_LIMIT,env.CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT];
 if(raw.some(v=>!v||!/^[1-9][0-9]*$/.test(v)))throw new Error('Unavailable');
 const [windowMs,tenantLimit,databaseLimit,retainedLimit,tenantRetainedLimit]=raw.map(Number);
 if(!Number.isSafeInteger(windowMs)||windowMs<60000||windowMs>86400000||[tenantLimit,databaseLimit].some(n=>!Number.isSafeInteger(n)||n<1||n>1000)||[retainedLimit,tenantRetainedLimit].some(n=>!Number.isSafeInteger(n)||n<1||n>10000))throw new Error('Unavailable');
 return [windowMs,tenantLimit,databaseLimit,retainedLimit,tenantRetainedLimit];
}
/** Reservations are retained even after failure. */
export async function createCandidateTemplate(env:TemplateEnv,credential:string|{kind:'editor';token:string;origin:string},key:string,input:Uint8Array,rawRoles:unknown,rawFields:unknown):Promise<{id:string}> {
 const [windowMs,tenantLimit,databaseLimit,retainedLimit,tenantRetainedLimit]=candidateTemplatePolicy(env);
 const editor=typeof credential==='string'?null:credential,token=typeof credential==='string'?credential:credential.token;
 if(!/^[A-Za-z0-9_-]{32,256}$/.test(token)||!/^[A-Za-z0-9_-]{1,128}$/.test(key)||!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>5*1024*1024)throw new Error('Invalid request');
 if(!Array.isArray(rawRoles)||rawRoles.length!==2||rawRoles.some(r=>typeof r!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(r))||new Set(rawRoles).size!==2)throw new Error('Invalid roles');
 const bytes=new Uint8Array(input),db=env.DB,keyHash=await hashText(token);
 const editorQuery=`SELECT e.tenant_id,b.roles_json,e.page_id FROM editor_page_tokens t JOIN editor_page_entries e ON e.page_id=t.page_id JOIN candidate_editor_bindings b ON b.page_id=e.page_id JOIN api_keys k ON k.key_hash=b.key_hash AND k.tenant_id=e.tenant_id JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE t.token_hash=? AND e.parent_origin=? AND t.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND e.preset_roles_json=b.roles_json AND NOT EXISTS (SELECT 1 FROM candidate_editor_revocations r WHERE r.page_id=e.page_id) AND ${managementCredential.replace('k.key_hash = ?', 'k.key_hash = b.key_hash')}`;
 const auth=editor?await db.prepare(editorQuery).bind(keyHash,editor.origin).first<{tenant_id:string;roles_json:string;page_id:string}>():await db.prepare(`SELECT k.tenant_id FROM api_keys k WHERE ${managementCredential}`).bind(keyHash).first<{tenant_id:string;roles_json?:string;page_id?:string}>();if(!auth)throw new Error('Unauthorized');
 if(editor && auth.roles_json!==JSON.stringify(rawRoles))throw new Error('Invalid roles');
 const pdf=await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false});validatePositionedPdf(pdf);
 const fields=positionedV3Fields(rawFields,rawRoles,pdf.getPageCount());validatePositionedPlacement(pdf,fields);
 const rolesJson=JSON.stringify(rawRoles),fieldsJson=JSON.stringify(fields),sourceHash=await hash(bytes),requestHash=await hashText(JSON.stringify([sourceHash,rolesJson,fieldsJson]));
 const id=await hashText(JSON.stringify(['candidate-template',auth.tenant_id,key])),objectKey=`candidate-templates/${id}/source.pdf`;
 const authorization=editor?`EXISTS (SELECT 1 FROM (${editorQuery}) WHERE tenant_id=? AND roles_json=? AND page_id=?)`:`EXISTS (SELECT 1 FROM api_keys k WHERE ${managementCredential} AND k.tenant_id=?)`;
 const authArgs=editor?[keyHash,editor.origin,auth.tenant_id,auth.roles_json!,auth.page_id!]:[keyHash,auth.tenant_id];
 const binding=editor?`EXISTS (SELECT 1 FROM candidate_editor_template_bindings b WHERE b.page_id=? AND b.tenant_id=? AND b.idempotency_key=? AND b.request_hash=? AND b.template_id=?)`:`NOT EXISTS (SELECT 1 FROM candidate_editor_template_bindings b WHERE b.tenant_id=? AND b.idempotency_key=?)`;
 const bindingArgs=editor?[auth.page_id!,auth.tenant_id,key,requestHash,id]:[auth.tenant_id,key];
 const replay=async()=>{
  const row=await db.prepare(`SELECT c.request_hash,c.template_id,c.object_key,c.source_sha256,c.roles_json,c.fields_json,t.object_key live_key,t.roles_json live_roles,t.fields_json live_fields FROM candidate_created_templates c JOIN templates t ON t.id=c.template_id AND t.tenant_id=c.tenant_id WHERE ${authorization} AND ${binding} AND c.tenant_id=? AND c.idempotency_key=?`).bind(...authArgs,...bindingArgs,auth.tenant_id,key).first<{request_hash:string;template_id:string;object_key:string;source_sha256:string;roles_json:string;fields_json:string;live_key:string;live_roles:string;live_fields:string}>();
  if(!row)return null;
  if(row.request_hash!==requestHash||row.template_id!==id||row.object_key!==objectKey||row.source_sha256!==sourceHash||row.roles_json!==rolesJson||row.fields_json!==fieldsJson||row.live_key!==objectKey||row.live_roles!==rolesJson||row.live_fields!==fieldsJson)throw new Error('Template conflict');
  const object=await env.ARTIFACTS.get(objectKey);if(!object||object.size!==bytes.length||await hash(new Uint8Array(await object.arrayBuffer()))!==sourceHash)throw new Error('Template conflict');
  const authorized=await db.prepare(`SELECT 1 WHERE ${authorization} AND ${binding}`).bind(...authArgs,...bindingArgs).first();if(!authorized)throw new Error('Unauthorized');
  return {id};
 };
 const guard=()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN ${authorization} THEN 1 ELSE 0 END`).bind(...authArgs);
 const bindingGuard=()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN ${binding} THEN 1 ELSE 0 END`).bind(...bindingArgs);
 const reserved=async()=>{
  const reservationBinding=editor?`EXISTS (SELECT 1 FROM candidate_editor_template_bindings b WHERE b.page_id=? AND b.tenant_id=? AND b.idempotency_key=? AND b.template_id=?)`:binding;
  const reservationBindingArgs=editor?[auth.page_id!,auth.tenant_id,key,id]:bindingArgs;
  const row=await db.prepare(`SELECT r.request_hash,r.template_id,r.object_key FROM candidate_template_reservations r WHERE ${authorization} AND ${reservationBinding} AND r.tenant_id=? AND r.idempotency_key=?`).bind(...authArgs,...reservationBindingArgs,auth.tenant_id,key).first<{request_hash:string;template_id:string;object_key:string}>();
  if(!row)return false;
  if(row.request_hash!==requestHash||row.template_id!==id||row.object_key!==objectKey)throw new Error('Template conflict');
  return true;
 };
 if(!await reserved()){
  const marker=crypto.randomUUID();
  const budget=(scope:string,scopeId:string,limit:number)=>db.prepare(`INSERT INTO candidate_template_budgets VALUES (?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),?,?,?,1,?) ON CONFLICT(scope,scope_id) DO UPDATE SET started_at=CASE WHEN started_at+window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN excluded.started_at ELSE started_at END,window_ms=excluded.window_ms,issue_limit=excluded.issue_limit,retained_limit=excluded.retained_limit,issue_count=CASE WHEN started_at+window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN 1 ELSE issue_count+1 END,reservation=excluded.reservation WHERE started_at+window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) OR (window_ms=excluded.window_ms AND issue_limit=excluded.issue_limit AND retained_limit=excluded.retained_limit AND issue_count<excluded.issue_limit)`).bind(scope,scopeId,windowMs,limit,scope==='tenant'?tenantRetainedLimit:retainedLimit,marker);
  const capacity=()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN (SELECT count(*) FROM candidate_template_reservations)+(SELECT count(*) FROM candidate_created_templates c WHERE NOT EXISTS (SELECT 1 FROM candidate_template_reservations r WHERE r.tenant_id=c.tenant_id AND r.idempotency_key=c.idempotency_key))<=? AND (SELECT count(*) FROM candidate_template_reservations WHERE tenant_id=?)+(SELECT count(*) FROM candidate_created_templates c WHERE c.tenant_id=? AND NOT EXISTS (SELECT 1 FROM candidate_template_reservations r WHERE r.tenant_id=c.tenant_id AND r.idempotency_key=c.idempotency_key))<=? AND EXISTS (SELECT 1 FROM candidate_template_budgets WHERE scope='tenant' AND scope_id=? AND reservation=?) AND EXISTS (SELECT 1 FROM candidate_template_budgets WHERE scope='database' AND scope_id='shared' AND reservation=?) THEN 1 ELSE 0 END`).bind(retainedLimit,auth.tenant_id,auth.tenant_id,tenantRetainedLimit,auth.tenant_id,marker,marker);
  try{await db.batch([guard(),budget('tenant',auth.tenant_id,tenantLimit),budget('database','shared',databaseLimit),db.prepare('INSERT INTO candidate_template_reservations VALUES (?,?,?,?,?)').bind(auth.tenant_id,key,requestHash,id,objectKey),...(editor?[db.prepare('INSERT INTO candidate_editor_template_bindings VALUES (?,?,?,?,?)').bind(auth.page_id,auth.tenant_id,key,requestHash,id)]:[]),capacity(),guard(),bindingGuard(),db.prepare('DELETE FROM recipient_auth_assertions')]);}catch(error){if(!await reserved())throw error;}
 }
 if(!await reserved())throw new Error('Unauthorized');
 const prior=await replay();if(prior)return prior;
 if(!await reserved())throw new Error('Unauthorized');
 await putCandidatePreparationObject(env.ARTIFACTS,objectKey,bytes,sourceHash);
 try {await db.batch([guard(),bindingGuard(),db.prepare('INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,fields_json) VALUES (?,?,?,?,?,?)').bind(id,auth.tenant_id,objectKey,rolesJson,Date.now(),fieldsJson),db.prepare('INSERT INTO candidate_created_templates VALUES (?,?,?,?,?,?,?,?)').bind(auth.tenant_id,key,requestHash,id,objectKey,sourceHash,rolesJson,fieldsJson),guard(),bindingGuard(),db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM candidate_created_templates c JOIN templates t ON t.id=c.template_id AND t.tenant_id=c.tenant_id WHERE c.tenant_id=? AND c.idempotency_key=? AND c.request_hash=? AND c.template_id=? AND c.object_key=? AND c.source_sha256=? AND c.roles_json=? AND c.fields_json=? AND t.object_key=c.object_key AND t.roles_json=c.roles_json AND t.fields_json=c.fields_json) THEN 1 ELSE 0 END`).bind(auth.tenant_id,key,requestHash,id,objectKey,sourceHash,rolesJson,fieldsJson),db.prepare('DELETE FROM recipient_auth_assertions')]);}catch(error){const raced=await replay();if(raced)return raced;throw error;}
 return {id};
}
