/** Diagnostic only: never grants access; the operation's stricter atomic checks remain authoritative. */
export async function candidateRecipientSessionValid(db:D1Database,tokenHash:string,origin:string,signing:boolean):Promise<boolean>{
 const row=await db.prepare(`SELECT 1 FROM recipient_page_sessions s
 JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
 JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
 JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
 JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
 WHERE s.token_hash=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
 AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
 AND e.status IN ('IN_PROGRESS'${signing ? ",'FINALIZING'" : ''}) AND t.status IN ('ACTIVE'${signing ? ",'SIGNED'" : ''})
 AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=s.token_hash)
 AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=s.token_hash)`).bind(tokenHash,origin).first();
 return !!row;
}
