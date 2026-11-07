/** Captured facts of a verified initial V3 predecessor; this assertion does not verify R2 bytes or authorize a caller. */
export type CandidatePredecessorFacts={
 jobId:string;signatureId:string;envelopeId:string;taskId:string;recipientName:string;role:string;
 inputArtifactId:string;inputHash:string;inputObjectKey:string;inputPageCount:number;payloadJson:string;
 sessionHash:string;otpRecipientEmail:string;otpVerifiedAt:number;consentedAt:number;previousHash:string;eventHash:string;
 outputArtifactId:string;outputObjectKey:string;outputHash:string;
};

export function candidatePredecessorFactsAssertion(db:D1Database,f:CandidatePredecessorFacts):D1PreparedStatement{
 return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
 SELECT 1 FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id
 JOIN signature_events e ON e.signature_id=r.id AND e.envelope_id=r.envelope_id AND e.sequence=r.sequence AND e.event_version=3
 JOIN positioned_signature_inputs p ON p.signature_id=r.id JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id
 JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.task_id=r.task_id AND s.envelope_id=r.envelope_id
 JOIN envelopes env ON env.id=s.envelope_id AND env.tenant_id=s.tenant_id
 JOIN recipient_otp_verifications v ON v.task_id=r.task_id AND v.session_hash=s.token_hash AND v.verified_at=r.otp_verified_at AND v.recipient_email=r.otp_recipient_email COLLATE BINARY AND v.recipient_email=t.recipient_email COLLATE BINARY
 JOIN artifacts a ON a.envelope_id=r.envelope_id AND a.id=r.input_artifact_id JOIN signature_outputs o ON o.job_id=j.id
 WHERE j.id=? AND j.status='DONE' AND r.id=? AND r.envelope_id=? AND r.task_id=? AND r.sequence=1 AND r.recipient_name=?
 AND r.session_hash=? AND r.otp_recipient_email=? COLLATE BINARY AND r.input_artifact_id=? AND r.input_sha256=? AND r.otp_verified_at=? AND r.consented_at=?
 AND e.previous_hash=? AND e.event_hash=? AND p.input_object_key=? AND p.input_page_count=? AND p.payload_json=?
 AND t.status='SIGNED' AND t.role=? AND t.recipient_name=? AND a.sha256=? AND a.object_key=?
 AND o.artifact_id=? AND o.object_key=? AND o.sha256=?) THEN 1 ELSE 0 END`).bind(
 f.jobId,f.signatureId,f.envelopeId,f.taskId,f.recipientName,f.sessionHash,f.otpRecipientEmail,f.inputArtifactId,f.inputHash,f.otpVerifiedAt,f.consentedAt,
 f.previousHash,f.eventHash,f.inputObjectKey,f.inputPageCount,f.payloadJson,f.role,f.recipientName,f.inputHash,f.inputObjectKey,
 f.outputArtifactId,f.outputObjectKey,f.outputHash);
}
