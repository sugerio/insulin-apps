import {assertSyntheticSigningAuthorization,type SyntheticSigningGuard} from './synthetic-tsa-test-authorization.ts';
import {recordPositionedV3Signature} from './positioned-v3-record.ts';
import {retryPositionedV3Signature} from './positioned-v3-retry.ts';
import {processPositionedV3Job} from './positioned-v3-processing.ts';
import {finalizeLocalTestEvidence} from './local-test-evidence.ts';

type Command={token:string;origin:string;now:number;artifactId:string;artifactHash:string;consent:boolean;values:unknown;datePreviewIds?:unknown;signaturePreviews?:unknown;textPreviews?:unknown;idempotencyKey:string};
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
function map(value:unknown):Record<string,string>{
 if(value===undefined)return {};
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid local inputs');
 const entries=Object.entries(value);if(entries.length>100||entries.some(([k,v])=>!/^[A-Za-z0-9_-]{1,64}$/.test(k)||typeof v!=='string'||v.length>512))throw new Error('Invalid local inputs');
 return Object.fromEntries(entries.sort(([a],[b])=>a<b?-1:a>b?1:0)) as Record<string,string>;
}
/** Unmounted local experiment; returned completion is an HMAC mock, never a production seal. */
export async function signPositionedV3SynchronouslyLocalTest(db:D1Database,bucket:R2Bucket,input:Command,sealKey:Uint8Array):Promise<{mode:'LOCAL_TEST_ONLY';signatureId:string;status:'IN_PROGRESS'|'COMPLETED_LOCAL_TEST'}>{
 return signPositionedV3WithLocalFinalizer(db,bucket,input,sealKey,'COMPLETED_LOCAL_TEST',async(db,bucket,tenant,envelope,key)=>{await finalizeLocalTestEvidence(db,bucket,tenant,envelope,key);});
}
/** Unmounted local-test seam; callers must never use mock completion as production evidence. */
export async function signPositionedV3WithLocalFinalizer<S extends 'COMPLETED_LOCAL_TEST'|'SYNTHETIC_TSA_TEST_COMPLETED'>(db:D1Database,bucket:R2Bucket,input:Command,sealKey:Uint8Array,completed:S,finalize:(db:D1Database,bucket:R2Bucket,tenant:string,envelope:string,key:Uint8Array,guard?:SyntheticSigningGuard)=>Promise<void>):Promise<{mode:'LOCAL_TEST_ONLY';signatureId:string;status:'IN_PROGRESS'|S}>{
 if(!input||input.consent!==true||!/^[a-f0-9]{64}$/.test(input.token)||!/^[a-f0-9]{64}$/.test(input.artifactHash)||!Number.isSafeInteger(input.now)||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)||sealKey.length<32)throw new Error('Invalid local signing request');
 const cmd={token:input.token,origin:input.origin,now:input.now,artifactId:input.artifactId,artifactHash:input.artifactHash,values:map(input.values),datePreviewIds:map(input.datePreviewIds),signaturePreviews:map(input.signaturePreviews),textPreviews:map(input.textPreviews)};
 const key=`local-v3-sign:${input.idempotencyKey}`,keyCopy=Uint8Array.from(sealKey),tokenHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(cmd.token)));
 const session=await db.prepare(`SELECT s.tenant_id,s.envelope_id FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id JOIN recipient_otp_verifications v ON v.task_id=s.task_id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND v.verified_at<=?`).bind(tokenHash,cmd.origin,cmd.now,cmd.now).first<{tenant_id:string;envelope_id:string}>();
 if(!session)throw new Error('Local session unavailable');
 const signingGuard=completed==='SYNTHETIC_TSA_TEST_COMPLETED'?{tenantId:session.tenant_id,envelopeId:session.envelope_id,sessionHash:tokenHash,origin:cmd.origin}:undefined;
 if(signingGuard)await assertSyntheticSigningAuthorization(db,signingGuard,['IN_PROGRESS','FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED']);
 const requestHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['local-v3-sign-v1',tokenHash,cmd.origin,cmd.artifactId,cmd.artifactHash,cmd.values,cmd.datePreviewIds,cmd.signaturePreviews,cmd.textPreviews]))));
 const find=()=>db.prepare('SELECT request_hash,response_json FROM idempotency_keys WHERE tenant_id=? AND idempotency_key=?').bind(session.tenant_id,key).first<{request_hash:string;response_json:string}>();
 let stored=await find();
 if(!stored){try{await recordPositionedV3Signature(db,bucket,{...cmd,localTestIdempotency:{key,requestHash},syntheticSigningGuard:signingGuard});}catch(error){stored=await find();if(!stored)throw error;}stored=stored??await find();}
 if(!stored||stored.request_hash!==requestHash)throw new Error('Idempotency conflict');
 let id:unknown;try{id=JSON.parse(stored.response_json).signatureId;}catch{throw new Error('Invalid idempotency record');}
 if(typeof id!=='string'||await retryPositionedV3Signature(db,bucket,cmd)!==id)throw new Error('Local signature replay rejected');
 const job=await db.prepare('SELECT id FROM signature_jobs WHERE signature_id=?').bind(id).first<{id:string}>();if(!job)throw new Error('Local job missing');
 await processPositionedV3Job(db,bucket,job.id,undefined,signingGuard);
 const envelope=await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(session.envelope_id,session.tenant_id).first<{status:string}>();
 if(envelope?.status==='IN_PROGRESS')return {mode:'LOCAL_TEST_ONLY',signatureId:id,status:'IN_PROGRESS'};
 if(envelope?.status!=='FINALIZING'&&envelope?.status!==(completed==='COMPLETED_LOCAL_TEST'?'COMPLETED':completed))throw new Error('Local envelope unavailable');
 if(signingGuard)await assertSyntheticSigningAuthorization(db,signingGuard,['FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED']);
 await finalize(db,bucket,session.tenant_id,session.envelope_id,keyCopy,signingGuard);
 return {mode:'LOCAL_TEST_ONLY',signatureId:id,status:completed};
}
