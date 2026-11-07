import {processPositionedV3Job} from './positioned-v3-processing.ts';
import {managementCredential} from './candidate-recovery-authorization.ts';
import {assertSyntheticRecoveryAuthorization,syntheticRecoveryAuthorizationAssertion,assertSyntheticSigningAuthorization,syntheticSigningAuthorizationAssertion,type SyntheticRecoveryGuard,type SyntheticSigningGuard} from './synthetic-tsa-test-authorization.ts';
import {prepareLocalTestEvidence} from './local-test-evidence.ts';
import {signPositionedV3WithLocalFinalizer} from './synchronous-positioned-v3.ts';
import {verifyAuthorizedSyntheticTimestampCandidate} from './worker-synthetic-tsa-candidate.ts';
import {syntheticTimestampQuery} from './worker-tsa-transport.ts';
import {verifyRfc3161Candidate} from './worker-rfc3161-verifier.ts';

type Transport=Parameters<typeof verifyAuthorizedSyntheticTimestampCandidate>[1];
type Policy=Parameters<typeof verifyRfc3161Candidate>[3];
type Command=Parameters<typeof signPositionedV3WithLocalFinalizer>[2];
const text=new TextEncoder();
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const sha=async(b:Uint8Array)=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(b))));
const unhex=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.length||value.length>max*2||!/^([a-f0-9]{2})+$/.test(value))throw new Error('Invalid synthetic evidence');return Uint8Array.from(value.match(/../g)!,x=>parseInt(x,16));};

type TestOptions={sealKey:Uint8Array;transport:Transport;policy:Policy;clock:()=>number};
function createSyntheticTestFinalizer(options:TestOptions){
 const key=Uint8Array.from(options.sealKey),t=options.transport,p=options.policy;
 const transport={endpoint:t.endpoint,allowedEndpoints:[...t.allowedEndpoints],timeoutMs:t.timeoutMs,authorizeSynthetic:t.authorizeSynthetic,fetch:t.fetch};
 const policyConfig={roots:p.roots.map(r=>Uint8Array.from(r)),maxAgeMs:p.maxAgeMs,maxFutureSkewMs:p.maxFutureSkewMs,allowedPolicies:[...p.allowedPolicies],allowedSignerSpkiSha256:[...p.allowedSignerSpkiSha256],checkRevocation:p.checkRevocation};
 const finalize=async(db:D1Database,bucket:R2Bucket,tenant:string,envelope:string,key:Uint8Array,guard?:SyntheticRecoveryGuard,signingGuard?:SyntheticSigningGuard,candidate?:{assertion:()=>D1PreparedStatement;capture:(prepared:Awaited<ReturnType<typeof prepareLocalTestEvidence>>)=>Promise<()=>D1PreparedStatement[]>})=>{
  const now=options.clock();
  if(!Number.isSafeInteger(now))throw new Error('Invalid trusted clock');
  const policy={...policyConfig,now};
  if(guard){if(guard.tenantId!==tenant||guard.envelopeId!==envelope)throw new Error('Synthetic recovery mismatch');await assertSyntheticRecoveryAuthorization(db,guard,['FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED']);}
  if(signingGuard){if(signingGuard.tenantId!==tenant||signingGuard.envelopeId!==envelope)throw new Error('Synthetic signing mismatch');await assertSyntheticSigningAuthorization(db,signingGuard,['FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED']);}
  const prepared=await prepareLocalTestEvidence(db,bucket,tenant,envelope,key,true);
  if(!prepared.signatures.length||JSON.parse(prepared.seal.manifest).format!=='esign-local-test-manifest-v3')throw new Error('Synthetic v3 evidence required');
  const candidateAssertions=candidate?await candidate.capture(prepared):undefined;
  const testPolicy={now:policy.now,maxAgeMs:policy.maxAgeMs,maxFutureSkewMs:policy.maxFutureSkewMs,allowedPolicies:policy.allowedPolicies};
  const kms=text.encode(prepared.seal.testKmsMac),imprint=new Uint8Array(await crypto.subtle.digest('SHA-256',kms)),objectKey=`envelopes/${envelope}/synthetic-tsa-test.json`;
  const verifyMaterial=async(raw:Uint8Array)=>{
   if(raw.length>200000)throw new Error('Synthetic evidence too large');
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
   if(!value||Object.keys(value).sort().join(',')!=='format,manifest,mockKmsMac,nonceHex,queryHex,responseHex,revocation,rootHex,signerPins,testPolicy,timestampMs' || value.format!=='SYNTHETIC_TSA_TEST_ONLY_V1'||value.manifest!==prepared.seal.manifest||value.mockKmsMac!==prepared.seal.testKmsMac||value.revocation!=='TEST_ONLY_NOT_CHECKED'||(!value.testPolicy||Object.keys(value.testPolicy).sort().join(',')!=='allowedPolicies,maxAgeMs,maxFutureSkewMs,now'||!Number.isSafeInteger(value.testPolicy.now)||value.testPolicy.now>policy.now||JSON.stringify({...value.testPolicy,now:policy.now})!==JSON.stringify(testPolicy))||JSON.stringify(value.rootHex)!==JSON.stringify(policy.roots.map(hex))||JSON.stringify(value.signerPins)!==JSON.stringify(policy.allowedSignerSpkiSha256))throw new Error('Synthetic evidence conflict');
   const nonce=unhex(value.nonceHex,16),query=unhex(value.queryHex,256),response=unhex(value.responseHex,65536);
   if(hex(query)!==hex(syntheticTimestampQuery(imprint,nonce)))throw new Error('Synthetic request mismatch');
   await verifyRfc3161Candidate(response,kms,nonce,{...policy,now:value.testPolicy.now});
   const verified=await verifyRfc3161Candidate(response,kms,nonce,policy);if(value.timestampMs!==verified.time)throw new Error('Synthetic timestamp mismatch');
   return sha(raw);
  };
  let object=await bucket.get(objectKey);
  if(!object){
   if(candidate)await db.batch([candidate.assertion(),...candidateAssertions!(),db.prepare('DELETE FROM recipient_auth_assertions')]);
   if(guard)await assertSyntheticRecoveryAuthorization(db,guard,['FINALIZING']);
   if(signingGuard)await assertSyntheticSigningAuthorization(db,signingGuard,['FINALIZING']);
   const result=await verifyAuthorizedSyntheticTimestampCandidate(kms,transport,policy);
   const raw=text.encode(JSON.stringify({format:'SYNTHETIC_TSA_TEST_ONLY_V1',manifest:prepared.seal.manifest,mockKmsMac:prepared.seal.testKmsMac,nonceHex:hex(result.nonce),queryHex:hex(result.query),responseHex:hex(result.response),rootHex:policy.roots.map(hex),signerPins:policy.allowedSignerSpkiSha256,testPolicy,revocation:'TEST_ONLY_NOT_CHECKED',timestampMs:result.time}));
   await verifyMaterial(raw);
   const stored=await bucket.put(objectKey,raw,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(!stored){object=await bucket.get(objectKey);if(!object)throw new Error('Synthetic evidence conflict');}
   else {
    const createdHash=await sha(raw);
    await db.batch([
     ...(candidate?[candidate.assertion(),...candidateAssertions!()]:[]),
     ...(guard?[syntheticRecoveryAuthorizationAssertion(db,guard,['FINALIZING'])]:[]),
     ...(signingGuard?[syntheticSigningAuthorizationAssertion(db,signingGuard,['FINALIZING'])]:[]),
     db.prepare('INSERT OR IGNORE INTO synthetic_tsa_test_reservations VALUES (?,?,?)').bind(envelope,objectKey,createdHash),
     db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM synthetic_tsa_test_reservations WHERE envelope_id=? AND object_key=? AND sha256=?) THEN 1 ELSE 0 END').bind(envelope,objectKey,createdHash),
     ...(candidate?[candidate.assertion(),...candidateAssertions!()]:[]),
     db.prepare('DELETE FROM recipient_auth_assertions')
    ]);
    object=await bucket.get(objectKey);
   }
  }
  if(!object)throw new Error('Synthetic evidence unavailable');
  const hash=await verifyMaterial(new Uint8Array(await object.arrayBuffer()));
  const reservation=await db.prepare('SELECT sha256 FROM synthetic_tsa_test_reservations WHERE envelope_id=? AND object_key=?').bind(envelope,objectKey).first<{sha256:string}>();
  if(reservation?.sha256!==hash)throw new Error('Synthetic evidence reservation conflict');
  const rechecked=await prepareLocalTestEvidence(db,bucket,tenant,envelope,key,true);
  if(rechecked.seal.manifest!==prepared.seal.manifest||rechecked.seal.testKmsMac!==prepared.seal.testKmsMac||JSON.stringify(rechecked.syntheticV3Guards)!==JSON.stringify(prepared.syntheticV3Guards)||prepared.syntheticV3Guards.length!==prepared.signatures.length)throw new Error('Synthetic signing facts changed');
  const signerAssertions=()=>prepared.signatures.map((r,i)=>{const g=prepared.syntheticV3Guards[i];return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
     SELECT 1 FROM signature_records r JOIN signature_events e ON e.signature_id=r.id AND e.envelope_id=r.envelope_id AND e.sequence=r.sequence AND e.event_version=3
     JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_outputs o ON o.job_id=j.id
     JOIN positioned_signature_inputs p ON p.signature_id=r.id JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id
     JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.task_id=r.task_id AND s.envelope_id=r.envelope_id AND s.tenant_id=?
     JOIN recipient_otp_verifications v ON v.task_id=r.task_id AND v.session_hash=s.token_hash AND v.verified_at=r.otp_verified_at AND v.recipient_email=r.otp_recipient_email COLLATE BINARY AND v.recipient_email=t.recipient_email COLLATE BINARY
     WHERE r.session_hash=? AND r.otp_recipient_email=? COLLATE BINARY AND r.id=? AND r.envelope_id=? AND r.task_id=? AND r.sequence=? AND r.recipient_name=? AND r.input_artifact_id=? AND r.input_sha256=? AND r.otp_verified_at=? AND r.consented_at=?
     AND e.previous_hash=? AND e.event_hash=? AND o.artifact_id=? AND o.object_key=? AND o.sha256=? AND p.payload_json=? AND p.input_object_key=? AND p.input_page_count=?
     AND t.role=? AND t.recipient_name=? AND t.status='SIGNED') THEN 1 ELSE 0 END`).bind(tenant,g.sessionHash,g.otpRecipientEmail,r.id,envelope,r.task_id,r.sequence,r.recipient_name,r.input_artifact_id,r.input_sha256,r.otp_verified_at,r.consented_at,r.previous_hash,r.event_hash,r.artifact_id,r.object_key,r.sha256,g.payloadJson,g.inputObjectKey,g.inputPageCount,g.role,r.recipient_name);});
  const chainAssertion=()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN
     (SELECT COUNT(*) FROM tasks WHERE envelope_id=? AND status='SIGNED')=? AND (SELECT COUNT(*) FROM tasks WHERE envelope_id=?)=?
     AND (SELECT COUNT(*) FROM signature_records WHERE envelope_id=?)=? AND (SELECT COUNT(*) FROM signature_events WHERE envelope_id=?)=?
     AND (SELECT COUNT(*) FROM artifacts WHERE envelope_id=?)=1 AND EXISTS (SELECT 1 FROM artifacts WHERE envelope_id=? AND id=? AND object_key=? AND sha256=?) THEN 1 ELSE 0 END`).bind(envelope,prepared.signatures.length,envelope,prepared.signatures.length,envelope,prepared.signatures.length,envelope,prepared.signatures.length,envelope,envelope,prepared.source.id,prepared.source.object_key,prepared.source.sha256);
  await db.batch([
   ...(candidate?[candidate.assertion(),...candidateAssertions!()]:[]),
   ...(guard?[syntheticRecoveryAuthorizationAssertion(db,guard,['FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED'])]:[]),
   ...(signingGuard?[syntheticSigningAuthorizationAssertion(db,signingGuard,['FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED'])]:[]),
   chainAssertion(),
   ...signerAssertions(),
   db.prepare("INSERT OR IGNORE INTO synthetic_tsa_test_evidence SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM envelopes WHERE id=? AND tenant_id=? AND status IN ('FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED'))").bind(envelope,objectKey,hash,envelope,tenant),
   db.prepare("UPDATE envelopes SET status='SYNTHETIC_TSA_TEST_COMPLETED' WHERE id=? AND tenant_id=? AND status='FINALIZING' AND EXISTS (SELECT 1 FROM synthetic_tsa_test_evidence WHERE envelope_id=? AND object_key=? AND sha256=?)").bind(envelope,tenant,envelope,objectKey,hash),
   db.prepare("INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM envelopes e JOIN synthetic_tsa_test_evidence v ON v.envelope_id=e.id WHERE e.id=? AND e.tenant_id=? AND e.status='SYNTHETIC_TSA_TEST_COMPLETED' AND v.object_key=? AND v.sha256=?) THEN 1 ELSE 0 END").bind(envelope,tenant,objectKey,hash),
   ...(candidate?[candidate.assertion(),...candidateAssertions!(),chainAssertion(),...signerAssertions()]:[]),
   db.prepare('DELETE FROM recipient_auth_assertions')
  ]);
 };
 return {key,finalize};
}

/** Unmounted synthetic-only signer; a management credential is never a signing credential. */
export function createSyntheticTsaV3TestSigner(options:TestOptions):(db:D1Database,bucket:R2Bucket,cmd:Command)=>Promise<{mode:'LOCAL_TEST_ONLY';signatureId:string;status:'IN_PROGRESS'|'SYNTHETIC_TSA_TEST_COMPLETED'}>{
 const {key,finalize}=createSyntheticTestFinalizer(options);
 return (db,bucket,cmd)=>signPositionedV3WithLocalFinalizer(db,bucket,cmd,key,'SYNTHETIC_TSA_TEST_COMPLETED',(db,bucket,tenant,envelope,key,signingGuard)=>finalize(db,bucket,tenant,envelope,key,undefined,signingGuard));
}

/** Private local-test recovery only. It never creates a signature, consent, OTP or recipient session. */
export function createSyntheticTsaV3TestRecovery(options:TestOptions):(db:D1Database,bucket:R2Bucket,request:{tenantId:string;envelopeId:string;authorization:string})=>Promise<{mode:'LOCAL_TEST_ONLY';status:'IN_PROGRESS'|'SYNTHETIC_TSA_TEST_COMPLETED'}>{
 const {key,finalize}=createSyntheticTestFinalizer(options);
 return async(db,bucket,request)=>{
  if(!request||typeof request.tenantId!=='string'||!request.tenantId||typeof request.envelopeId!=='string'||!request.envelopeId||typeof request.authorization!=='string')throw new Error('Synthetic recovery unavailable');
  const bearer=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.authorization);if(!bearer)throw new Error('Synthetic recovery unavailable');
  const keyHash=await sha(text.encode(bearer[1])),guard={tenantId:request.tenantId,envelopeId:request.envelopeId,keyHash};
  await assertSyntheticRecoveryAuthorization(db,guard,['IN_PROGRESS','FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED']);
  let envelope=await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(guard.envelopeId,guard.tenantId).first<{status:string}>();
  if(envelope?.status==='IN_PROGRESS'){
   const pending=await db.prepare(`SELECT j.id FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN signature_events ev ON ev.signature_id=r.id AND ev.envelope_id=r.envelope_id AND ev.sequence=r.sequence AND ev.event_version=3 WHERE r.envelope_id=? AND j.status='PENDING' ORDER BY r.sequence LIMIT 1`).bind(guard.envelopeId).first<{id:string}>();
   if(!pending)throw new Error('No pending synthetic job');
   await processPositionedV3Job(db,bucket,pending.id,guard);
   await assertSyntheticRecoveryAuthorization(db,guard,['IN_PROGRESS','FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED']);
   envelope=await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(guard.envelopeId,guard.tenantId).first<{status:string}>();
   if(envelope?.status==='IN_PROGRESS')return {mode:'LOCAL_TEST_ONLY',status:'IN_PROGRESS'};
  }
  if(envelope?.status!=='FINALIZING'&&envelope?.status!=='SYNTHETIC_TSA_TEST_COMPLETED')throw new Error('Synthetic recovery unavailable');
  await finalize(db,bucket,guard.tenantId,guard.envelopeId,key,guard);
  return {mode:'LOCAL_TEST_ONLY',status:'SYNTHETIC_TSA_TEST_COMPLETED'};
 };
}

/** Unmounted dependency-injected candidate test only; no production TSA or signing claim. */
export function createCandidateSyntheticTsaTestFinalizer(options:TestOptions){
 if(options.transport.endpoint!=='https://tsa.example.test/rfc3161'||options.transport.allowedEndpoints.length!==1||options.transport.allowedEndpoints[0]!==options.transport.endpoint)throw new Error('Synthetic test endpoint required');
 const {key,finalize}=createSyntheticTestFinalizer(options);
 return async(db:D1Database,bucket:R2Bucket,request:{tenantId:string;envelopeId:string;authorization:string}):Promise<{mode:'LOCAL_TEST_ONLY';status:'SYNTHETIC_TSA_TEST_COMPLETED'}>=>{
  const bearer=typeof request?.authorization==='string'?/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.authorization):null;
  if(!bearer||!request.tenantId||!request.envelopeId)throw new Error('Candidate synthetic test unavailable');
  const keyHash=await sha(text.encode(bearer[1])),tenant=request.tenantId,envelope=request.envelopeId;
  const assertion=()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id WHERE ${managementCredential} AND k.tenant_id=? AND e.id=? AND e.status IN ('FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED')) THEN 1 ELSE 0 END`).bind(keyHash,tenant,envelope);
  await db.batch([assertion(),db.prepare('DELETE FROM recipient_auth_assertions')]);
  await finalize(db,bucket,tenant,envelope,key,undefined,undefined,{assertion,capture:async prepared=>{
   if(prepared.signatures.length!==2)throw new Error('Two candidate signatures required');
   const rows=(await db.prepare(`SELECT r.id,r.task_id,r.sequence,r.session_hash,r.consented_at,r.otp_verified_at,s.expires_at,s.origin,t.routing_order,j.id AS job_id,i.idempotency_key,i.request_hash,i.response_json,a.slot
    FROM signature_records r JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.tenant_id=? AND s.envelope_id=r.envelope_id AND s.task_id=r.task_id
    JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE'
    JOIN idempotency_keys i ON i.tenant_id=? AND i.idempotency_key LIKE 'candidate-v3-sign:%' AND json_extract(i.response_json,'$.signatureId')=r.id
    JOIN candidate_v3_attempt_slots a ON a.tenant_id=i.tenant_id AND a.envelope_id=r.envelope_id AND a.task_id=r.task_id AND a.request_hash=i.request_hash
    WHERE r.envelope_id=? ORDER BY r.sequence`).bind(tenant,tenant,envelope).all<{id:string;task_id:string;sequence:number;session_hash:string;consented_at:number;otp_verified_at:number;expires_at:number;origin:string;routing_order:number;job_id:string;idempotency_key:string;request_hash:string;response_json:string;slot:number}>()).results;
   if(rows.length!==2||rows.some((r,i)=>r.id!==prepared.signatures[i].id||r.sequence!==i+1||!Number.isSafeInteger(r.consented_at)||!Number.isSafeInteger(r.otp_verified_at)||r.otp_verified_at<=0||r.otp_verified_at>r.consented_at||r.consented_at>Date.now()||r.expires_at<=r.consented_at)||rows[0].routing_order>=rows[1].routing_order)throw new Error('Candidate provenance unavailable');
   for(const r of rows){
    if(await sha(text.encode(JSON.stringify(['candidate-v3-attempt-slot',tenant,envelope,r.task_id,r.slot])))!==r.id)throw new Error('Candidate attempt mismatch');
    await processPositionedV3Job(db,bucket,r.job_id,undefined,undefined,undefined,{envelopeId:envelope,taskId:r.task_id,assertion});
   }
   return ()=>rows.map(r=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
    SELECT 1 FROM signature_records r JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.tenant_id=? AND s.envelope_id=r.envelope_id AND s.task_id=r.task_id
    JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE'
    JOIN idempotency_keys i ON i.tenant_id=? AND i.idempotency_key=? AND i.request_hash=? AND i.response_json=? AND json_extract(i.response_json,'$.signatureId')=r.id
    JOIN candidate_v3_attempt_slots a ON a.tenant_id=i.tenant_id AND a.envelope_id=r.envelope_id AND a.task_id=r.task_id AND a.request_hash=i.request_hash AND a.slot=?
    WHERE r.id=? AND r.envelope_id=? AND r.task_id=? AND r.sequence=? AND r.session_hash=? AND r.consented_at=? AND r.otp_verified_at=? AND s.expires_at=? AND s.origin=? AND t.routing_order=? AND j.id=?
    AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations v WHERE v.token_hash=r.session_hash AND (typeof(v.revoked_at)<>'integer' OR v.revoked_at<=r.consented_at))
    AND (SELECT COUNT(*) FROM tasks WHERE envelope_id=r.envelope_id)=2 AND (SELECT COUNT(*) FROM signature_records WHERE envelope_id=r.envelope_id)=2
   ) THEN 1 ELSE 0 END`).bind(tenant,tenant,r.idempotency_key,r.request_hash,r.response_json,r.slot,r.id,envelope,r.task_id,r.sequence,r.session_hash,r.consented_at,r.otp_verified_at,r.expires_at,r.origin,r.routing_order,r.job_id));
  }});
  return {mode:'LOCAL_TEST_ONLY',status:'SYNTHETIC_TSA_TEST_COMPLETED'};
 };
}
