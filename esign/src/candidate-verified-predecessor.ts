import {candidatePredecessorFactsAssertion,type CandidatePredecessorFacts} from './candidate-predecessor-facts.ts';
import {candidateSecondSigningAuthorizationAssertion,type CandidateSigningGuard} from './candidate-signing-authorization.ts';
import {processPositionedV3Job} from './positioned-v3-processing.ts';

export async function captureVerifiedCandidatePredecessor(db:D1Database,bucket:R2Bucket,envelopeId:string,authorization?:()=>D1PreparedStatement):Promise<CandidatePredecessorFacts>{
 const f=await db.prepare(`SELECT j.id AS jobId,r.id AS signatureId,r.envelope_id AS envelopeId,r.task_id AS taskId,r.recipient_name AS recipientName,t.role AS role,
 r.input_artifact_id AS inputArtifactId,r.input_sha256 AS inputHash,p.input_object_key AS inputObjectKey,p.input_page_count AS inputPageCount,p.payload_json AS payloadJson,
 r.session_hash AS sessionHash,r.otp_recipient_email AS otpRecipientEmail,r.otp_verified_at AS otpVerifiedAt,r.consented_at AS consentedAt,e.previous_hash AS previousHash,e.event_hash AS eventHash,
 o.artifact_id AS outputArtifactId,o.object_key AS outputObjectKey,o.sha256 AS outputHash
 FROM signature_records r JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_outputs o ON o.job_id=j.id
 JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id JOIN signature_events e ON e.signature_id=r.id AND e.envelope_id=r.envelope_id AND e.sequence=1 AND e.event_version=3
 JOIN positioned_signature_inputs p ON p.signature_id=r.id WHERE r.envelope_id=? AND r.sequence=1`).bind(envelopeId).first<CandidatePredecessorFacts>();
 if(!f||f.envelopeId!==envelopeId||!f.otpRecipientEmail)throw new Error('Unavailable predecessor');
 await processPositionedV3Job(db,bucket,f.jobId,undefined,undefined,undefined,{envelopeId,taskId:f.taskId,assertion:authorization ?? (()=>candidatePredecessorFactsAssertion(db,f))});
 await db.batch([...(authorization?[authorization()]:[]),candidatePredecessorFactsAssertion(db,f),db.prepare('DELETE FROM recipient_auth_assertions')]);
 return f;
}

/** Capture D1 facts first, then verify their exact DONE output and source bytes read-only. */
export async function verifiedCandidatePredecessor(db:D1Database,bucket:R2Bucket,guard:CandidateSigningGuard,signedSignatureId?:string):Promise<CandidatePredecessorFacts>{
 const f=await captureVerifiedCandidatePredecessor(db,bucket,guard.envelopeId);
 await db.batch([candidateSecondSigningAuthorizationAssertion(db,guard,f.taskId,signedSignatureId),candidatePredecessorFactsAssertion(db,f),db.prepare('DELETE FROM recipient_auth_assertions')]);
 return f;
}

export function candidateSecondAssertions(db:D1Database,guard:CandidateSigningGuard,f:CandidatePredecessorFacts,signedSignatureId?:string):D1PreparedStatement[]{
 if(f.envelopeId!==guard.envelopeId||f.taskId===guard.taskId)throw new Error('Predecessor scope mismatch');
 return [candidateSecondSigningAuthorizationAssertion(db,guard,f.taskId,signedSignatureId),candidatePredecessorFactsAssertion(db,f)];
}
