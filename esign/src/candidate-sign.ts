import {candidateRecipientSessionValid} from './candidate-recipient-access.ts';
import {candidateTemplateBinding} from './candidate-template-binding.ts';
import {processPositionedV3Job,PositionedV3ProviderUncertain} from './positioned-v3-processing.ts';
import {InvalidPositionedV3Input} from './positioned-v3-snapshot.ts';
import {PositionedV3TextDoesNotFitError} from './positioned-v3-text-fit.ts';
import {SignatureGeometryConflict} from './positioned-signature-geometry.ts';
import {recordPositionedV3Signature,InvalidDatePreview,PreviewConflict} from './positioned-v3-record.ts';

export class CandidateRecipientAccessError extends Error {}
export class CandidateSignError extends Error { constructor(public status:400|409){super('Invalid request');} }
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
function map(value:unknown):Record<string,string>{
 if(value===undefined)return {};
 if(!value||typeof value!=='object'||Array.isArray(value))throw new CandidateSignError(400);
 const entries=Object.entries(value);
 if(entries.length>100||entries.some(([k,v])=>!/^[A-Za-z0-9_-]{1,64}$/.test(k)||typeof v!=='string'||v.length>512))throw new CandidateSignError(400);
 return Object.fromEntries(entries.sort(([a],[b])=>a<b?-1:a>b?1:0)) as Record<string,string>;
}
export async function acceptCandidateSignature(db:D1Database,bucket:R2Bucket,input:Record<string,unknown>):Promise<{signatureId:string;status:'PENDING'|'PROCESSED_UNSEALED'}>{
 if(Object.keys(input).some(k=>!['token','origin','artifactId','artifactHash','consent','idempotencyKey','values','signaturePreviews','textPreviews','datePreviewIds'].includes(k)) || input.consent!==true || typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token) || typeof input.origin!=='string'||input.origin.length>2048 || typeof input.artifactId!=='string'||! /^(?:[A-Za-z0-9_-]{1,128}|signed:[A-Za-z0-9_-]{1,121}|d0:[A-Za-z0-9_-]{1,128})$/.test(input.artifactId) || typeof input.artifactHash!=='string'||!/^[a-f0-9]{64}$/.test(input.artifactHash) || typeof input.idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))throw new CandidateSignError(400);
 let url:URL;try{url=new URL(input.origin);}catch{throw new CandidateSignError(400);}if(url.protocol!=='https:'||url.origin!==input.origin)throw new CandidateSignError(400);
 const token=input.token,origin=input.origin,sessionHash=await digest(token),values=map(input.values),signaturePreviews=map(input.signaturePreviews),textPreviews=map(input.textPreviews),datePreviewIds=map(input.datePreviewIds);
 const key=`candidate-v3-sign:${input.idempotencyKey}`;
 const requestHash=await digest(JSON.stringify(['candidate-v3-sign-v1',sessionHash,origin,input.artifactId,input.artifactHash,values,signaturePreviews,textPreviews,datePreviewIds]));
 // This query is also the replay authorization: never disclose an id after revocation or credential collision.
 const session=await db.prepare(`SELECT s.tenant_id,s.envelope_id,s.task_id,e.status AS envelope_status,t.status AS task_status,CAST(unixepoch('subsec')*1000 AS INTEGER) AS now FROM recipient_page_sessions s
 JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
 JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
 WHERE s.token_hash=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000
 AND ${candidateTemplateBinding} AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND e.status IN ('IN_PROGRESS','FINALIZING') AND t.status IN ('ACTIVE','SIGNED')
 AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=s.token_hash) AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=s.token_hash)`).bind(sessionHash,origin).first<{tenant_id:string;envelope_id:string;task_id:string;envelope_status:string;task_status:string;now:number}>();
 if(!session){if(await candidateRecipientSessionValid(db,sessionHash,origin,true))throw new Error('Unavailable');throw new CandidateRecipientAccessError();}
 const find=()=>db.prepare(`SELECT i.request_hash,i.response_json,j.id AS job_id,j.status AS job_status FROM idempotency_keys i JOIN signature_records r ON r.id=json_extract(i.response_json,'$.signatureId') JOIN signature_jobs j ON j.signature_id=r.id AND j.status IN ('PENDING','DONE') JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.tenant_id=i.tenant_id AND s.envelope_id=r.envelope_id AND s.task_id=r.task_id JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE ${candidateTemplateBinding} AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND v.verified_at=r.otp_verified_at AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND t.status='SIGNED' AND ((j.status='PENDING' AND e.status='IN_PROGRESS') OR (j.status='DONE' AND e.status IN ('IN_PROGRESS','FINALIZING'))) AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=s.token_hash) AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=s.token_hash) AND i.tenant_id=? AND i.idempotency_key=? AND r.envelope_id=? AND r.task_id=? AND r.session_hash=?`).bind(origin,session.tenant_id,key,session.envelope_id,session.task_id,sessionHash).first<{request_hash:string;response_json:string;job_id:string;job_status:string}>();
 let stored=await find();
 if(!stored && (session.envelope_status!=='IN_PROGRESS' || session.task_status!=='ACTIVE'))throw new Error('Unavailable');
 if(!stored){try{await recordPositionedV3Signature(db,bucket,{token,origin,now:session.now,artifactId:input.artifactId,artifactHash:input.artifactHash,values,signaturePreviews,textPreviews,datePreviewIds,localTestIdempotency:{key,requestHash},candidateSigningGuard:{sessionHash,tenantId:session.tenant_id,envelopeId:session.envelope_id,taskId:session.task_id,origin}});}catch(error){stored=await find();if(!stored){if(error instanceof InvalidDatePreview||error instanceof InvalidPositionedV3Input||error instanceof PositionedV3TextDoesNotFitError||error instanceof SignatureGeometryConflict)throw new CandidateSignError(400);if(error instanceof PreviewConflict)throw new CandidateSignError(409);throw error;}} stored=stored??await find();}
 if(!stored||stored.request_hash!==requestHash)throw new CandidateSignError(409);
 const signatureId=JSON.parse(stored.response_json).signatureId;if(typeof signatureId!=='string')throw new Error('Invalid record');
 {
  const expected=stored;
  try { await processPositionedV3Job(db,bucket,stored.job_id,undefined,undefined,undefined,{envelopeId:session.envelope_id,taskId:session.task_id,assertion:()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_keys i JOIN signature_records r ON r.id=json_extract(i.response_json,'$.signatureId') JOIN signature_jobs j ON j.signature_id=r.id JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.tenant_id=i.tenant_id AND s.envelope_id=r.envelope_id AND s.task_id=r.task_id JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE ${candidateTemplateBinding} AND s.token_hash=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND v.verified_at=r.otp_verified_at AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND t.status='SIGNED' AND e.status IN ('IN_PROGRESS','FINALIZING') AND j.id=? AND ((j.status='PENDING' AND e.status='IN_PROGRESS') OR (j.status='DONE' AND e.status IN ('IN_PROGRESS','FINALIZING'))) AND i.tenant_id=? AND i.idempotency_key=? AND i.request_hash=? AND i.response_json=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=s.token_hash) AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=s.token_hash)) THEN 1 ELSE 0 END`).bind(sessionHash,origin,expected.job_id,session.tenant_id,key,requestHash,expected.response_json)});
  return {signatureId,status:'PROCESSED_UNSEALED'};
  } catch (error) {
   if(error instanceof PositionedV3ProviderUncertain)return {signatureId,status:'PENDING'};
   // Processing failures can be integrity or authorization conflicts, not only provider outages.
   // Keep the outcome unknown; an exact replay can verify a committed result.
   throw new Error('Unavailable');
  }
 }
}
