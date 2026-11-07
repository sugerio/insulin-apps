import {PDFDocument} from 'pdf-lib';
import {positionedFields,validatePositionedPdf,validatePositionedPlacement} from './positioned-template.ts';
import {positionedV3Fields} from './positioned-v3-snapshot.ts';
import {assertNoOverlappingFields,type TemplateField} from './template-fields.ts';
import {renderTypedSignature} from './typed-signature-image.ts';
import {signatureGeometry,assertSignatureGeometrySafe} from './positioned-signature-geometry.ts';
import {signaturePreviewHash} from './positioned-signature-preview.ts';
import {internalDemoSinkPolicy,internalDemoStrictRecipientAllowed} from './internal-demo-sink-policy.ts';
import type {InternalDemoOtpEnv} from './internal-demo-otp.ts';

type Env=InternalDemoOtpEnv & {ARTIFACTS?:R2Bucket};
type Identity={subject:string;email:string};
type Facts={tenant_id:string;envelope_id:string;task_id:string;role:string;recipient_name:string;recipient_email:string;roles_json:string;fields_json:string;artifact_id:string;object_key:string;sha256:string;session_expiry:number;otp_verified_at:number;challenge_hash:string;challenge_consumed_by:string;reservation_id:string};
const hex=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(value))),x=>x.toString(16).padStart(2,'0')).join('');
export async function internalDemoDocumentSnapshot(env:Env,token:string,origin:string,identity:Identity):Promise<Facts> {
 if(!/^[a-f0-9]{64}$/.test(token))throw Error('Unavailable');
 const sink=internalDemoSinkPolicy(env);if(sink?(sink.subject!==identity.subject||sink.address!==identity.email):!internalDemoStrictRecipientAllowed(env,identity.email))throw Error('Unavailable');
 const mode=sink?"b.mode='SINK_TEST' AND b.task_label=t.recipient_email COLLATE BINARY":"b.mode='STRICT' AND b.email=t.recipient_email COLLATE BINARY";
 const row=await env.DB.prepare(`SELECT s.tenant_id,s.envelope_id,s.task_id,t.role,t.recipient_name,t.recipient_email,p.roles_json,p.fields_json,a.id AS artifact_id,a.object_key,a.sha256,s.expires_at AS session_expiry,v.verified_at AS otp_verified_at,c.otp_hash AS challenge_hash,c.consumed_by AS challenge_consumed_by,q.reservation_id AS reservation_id FROM recipient_page_sessions s JOIN internal_demo_recipient_bindings b ON b.token_hash=s.token_hash JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id JOIN artifacts a ON a.envelope_id=e.id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY JOIN recipient_otp_challenges c ON c.task_id=t.id AND c.session_hash=s.token_hash AND c.recipient_email=t.recipient_email COLLATE BINARY AND c.consumed_by IS NOT NULL AND c.isolated_issue_id IS NOT NULL JOIN isolated_otp_quota_reservations q ON q.reservation_id=c.isolated_issue_id AND q.task_id=t.id AND q.session_hash=s.token_hash WHERE s.token_hash=? AND s.origin=? AND b.subject=? COLLATE BINARY AND b.email=? COLLATE BINARY AND ${mode} AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash) AND NOT EXISTS(SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash) AND NOT EXISTS(SELECT 1 FROM signature_records r WHERE r.envelope_id=e.id)`).bind(await hex(new TextEncoder().encode(token)),origin,identity.subject,identity.email).first<Facts>();
 if(!row||!/^d0:/.test(row.artifact_id)||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Unavailable');return row;
}
export async function initialDemoDocument(env:Env,token:string,origin:string,identity:Identity){
 if(!env.ARTIFACTS)throw Error('Unavailable');
 const facts=await internalDemoDocumentSnapshot(env,token,origin,identity),object=await env.ARTIFACTS.get(facts.object_key);if(!object||object.size<5||object.size>5*1024*1024)throw Error('Unavailable');
 const bytes=new Uint8Array(await object.arrayBuffer());if(await hex(bytes)!==facts.sha256)throw Error('Unavailable');
 const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});if(!pdf.getPageCount()||pdf.getPageCount()>100)throw Error('Unavailable');
 const roles:unknown=JSON.parse(facts.roles_json),raw:unknown=JSON.parse(facts.fields_json);if(!Array.isArray(roles)||!roles.every(x=>typeof x==='string')||!roles.includes(facts.role)||!Array.isArray(raw))throw Error('Unavailable');
 const v3=raw.some((f:any)=>f?.type==='Date signed'||f?.type==='Title');let all:TemplateField[]=[];
 if(raw.length){all=v3?positionedV3Fields(raw,roles,pdf.getPageCount()):positionedFields(facts.fields_json,roles,pdf.getPageCount());assertNoOverlappingFields(all);validatePositionedPdf(pdf);validatePositionedPlacement(pdf,all);}
 const fields=all.filter(f=>f.role===facts.role);
 const recheck=async()=>{if(JSON.stringify(await internalDemoDocumentSnapshot(env,token,origin,identity))!==JSON.stringify(facts))throw Error('Unavailable');};
 await recheck();return {facts,bytes,pdf,all,fields,v3,recheck};
}
export async function initialDemoSignaturePreview(doc:Awaited<ReturnType<typeof initialDemoDocument>>,fieldId:unknown,text:unknown){
 const field=doc.fields.find(f=>f.id===fieldId&&f.type==='Signature');if(!field||typeof text!=='string')throw Error('Invalid preview');
 const image=Uint8Array.from(await renderTypedSignature(text)),page=doc.pdf.getPage(field.page-1),geometry=signatureGeometry(page,field,image);assertSignatureGeometrySafe(page,field,geometry,doc.all);
 const receipt=await signaturePreviewHash(doc.facts.sha256,doc.facts.roles_json,doc.facts.fields_json,field.id,text,await hex(image),geometry);await doc.recheck();
 return {image,receipt,width:geometry.width/(field.rect.width*page.getWidth()),height:geometry.height/(field.rect.height*page.getHeight())};
}
