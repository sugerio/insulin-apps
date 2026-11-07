/** Scoped facts for the isolated candidate's initial signing transaction. */
export type CandidateSigningGuard={sessionHash:string;tenantId:string;envelopeId:string;taskId:string;origin:string};

export function candidateSigningAuthorizationAssertion(db:D1Database,guard:CandidateSigningGuard):D1PreparedStatement{
 return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
  SELECT 1 FROM recipient_page_sessions s
  JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
  JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
  JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
  JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
  WHERE s.token_hash=? AND s.tenant_id=? AND s.envelope_id=? AND s.task_id=? AND s.origin=?
  AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000
  AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND e.status='IN_PROGRESS' AND t.status='ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash)
  AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)
  AND NOT EXISTS (SELECT 1 FROM signature_records r WHERE r.envelope_id=e.id)
 ) THEN 1 ELSE 0 END`).bind(guard.sessionHash,guard.tenantId,guard.envelopeId,guard.taskId,guard.origin);
}

/** Active before recording, signed afterward; predecessor evidence must be asserted in the same batch. */
export function candidateSecondSigningAuthorizationAssertion(db:D1Database,guard:CandidateSigningGuard,predecessorTaskId:string, signedSignatureId?:string):D1PreparedStatement{
 return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
  SELECT 1 FROM recipient_page_sessions s
  JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
  JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
  JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
  JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
  JOIN signature_records r ON r.envelope_id=e.id AND r.sequence=1 AND r.task_id=?
  JOIN tasks prior ON prior.id=r.task_id AND prior.envelope_id=e.id AND prior.status='SIGNED' AND prior.routing_order<t.routing_order
  WHERE s.token_hash=? AND s.tenant_id=? AND s.envelope_id=? AND s.task_id=? AND s.origin=?
  AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000
  AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND e.status='IN_PROGRESS' AND t.status=${signedSignatureId ? "'SIGNED'" : "'ACTIVE'"}
  AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=s.token_hash)
  AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=s.token_hash)
  AND (SELECT count(*) FROM tasks WHERE envelope_id=e.id)=2
  AND (SELECT count(*) FROM signature_records WHERE envelope_id=e.id)=${signedSignatureId ? 2 : 1}
  AND ${signedSignatureId ? "EXISTS (SELECT 1 FROM signature_records WHERE id=? AND task_id=t.id AND envelope_id=e.id AND sequence=2 AND session_hash=s.token_hash AND otp_verified_at=v.verified_at AND otp_recipient_email=v.recipient_email COLLATE BINARY)" : "NOT EXISTS (SELECT 1 FROM signature_records WHERE task_id=t.id)"}
 ) THEN 1 ELSE 0 END`).bind(predecessorTaskId,guard.sessionHash,guard.tenantId,guard.envelopeId,guard.taskId,guard.origin,...(signedSignatureId?[signedSignatureId]:[]));
}
