import {candidateSecondAssertions} from './candidate-verified-predecessor.ts';
import type {CandidatePredecessorFacts} from './candidate-predecessor-facts.ts';
import {candidateSigningAuthorizationAssertion,type CandidateSigningGuard} from './candidate-signing-authorization.ts';

/** A fixed experimental bound, not a production retention or archival policy. */
export class CandidateAttemptSlotsExhausted extends Error {}
export async function reserveCandidateAttempt(db:D1Database,guard:CandidateSigningGuard,requestHash:string,predecessor?:CandidatePredecessorFacts):Promise<string>{
 if(!/^[a-f0-9]{64}$/.test(requestHash))throw new Error('Invalid attempt');
 const {tenantId,envelopeId,taskId}=guard;
 await db.batch([
  ...(predecessor?candidateSecondAssertions(db,guard,predecessor):[candidateSigningAuthorizationAssertion(db,guard)]),
  db.prepare(`INSERT INTO candidate_v3_attempt_slots (tenant_id,envelope_id,task_id,request_hash,slot)
   SELECT ?,?,?,?,n FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5)
   WHERE NOT EXISTS (SELECT 1 FROM candidate_v3_attempt_slots WHERE tenant_id=? AND envelope_id=? AND task_id=? AND slot=n)
   AND NOT EXISTS (SELECT 1 FROM candidate_v3_attempt_slots WHERE tenant_id=? AND envelope_id=? AND task_id=? AND request_hash=?) ORDER BY n LIMIT 1`).bind(tenantId,envelopeId,taskId,requestHash,tenantId,envelopeId,taskId,tenantId,envelopeId,taskId,requestHash),
  ...(predecessor?candidateSecondAssertions(db,guard,predecessor):[candidateSigningAuthorizationAssertion(db,guard)]),db.prepare('DELETE FROM recipient_auth_assertions')
 ]);
 const row=await db.prepare('SELECT slot FROM candidate_v3_attempt_slots WHERE tenant_id=? AND envelope_id=? AND task_id=? AND request_hash=?').bind(tenantId,envelopeId,taskId,requestHash).first<{slot:number}>();
 if(!row)throw new CandidateAttemptSlotsExhausted('Investigation required');
 const data=new TextEncoder().encode(JSON.stringify(['candidate-v3-attempt-slot',tenantId,envelopeId,taskId,row.slot]));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
}
