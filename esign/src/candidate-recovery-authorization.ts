export const managementCredential = `k.key_hash = ? AND k.revoked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions s WHERE s.token_hash = k.key_hash)
  AND NOT EXISTS (SELECT 1 FROM recipient_page_codes c WHERE c.code_hash = k.key_hash)
  AND NOT EXISTS (SELECT 1 FROM editor_sessions s WHERE s.token_hash = k.key_hash)
  AND NOT EXISTS (SELECT 1 FROM editor_page_tokens t WHERE t.token_hash = k.key_hash)
  AND NOT EXISTS (SELECT 1 FROM editor_codes c WHERE c.code_hash = k.key_hash)
  AND NOT EXISTS (SELECT 1 FROM editor_page_entries e WHERE e.code_hash = k.key_hash)`;

export type CandidateRecoveryGuard = {keyHash:string;tenantId:string;envelopeId:string};

/** Must be used both before and after processing writes in the same D1 batch. */
export function candidateRecoveryAuthorizationAssertion(db:D1Database,guard:CandidateRecoveryGuard):D1PreparedStatement {
 return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
  SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id
  WHERE ${managementCredential} AND k.tenant_id=? AND e.id=? AND e.status IN ('IN_PROGRESS','FINALIZING')
 ) THEN 1 ELSE 0 END`).bind(guard.keyHash,guard.tenantId,guard.envelopeId);
}
