/** Tenant-scoped recovery credential, derived only from an authenticated local-test API key. */
export type SyntheticRecoveryGuard={tenantId:string;envelopeId:string;keyHash:string};
export type SyntheticSigningGuard={tenantId:string;envelopeId:string;sessionHash:string;origin:string};
const syntheticStatuses=['IN_PROGRESS','FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED'] as const;
export function syntheticSigningAuthorizationAssertion(db:D1Database,guard:SyntheticSigningGuard,statuses:readonly string[]):D1PreparedStatement{
 if(!statuses.length||statuses.some(s=>!syntheticStatuses.includes(s as typeof syntheticStatuses[number])))throw new Error('Invalid synthetic signing status');
 const placeholders=statuses.map(()=>'?').join(',');
 return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
  SELECT 1 FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
  JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id JOIN recipient_otp_verifications v ON v.task_id=s.task_id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
  WHERE s.token_hash=? AND s.tenant_id=? AND s.envelope_id=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND e.status IN (${placeholders})
  AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)
 ) THEN 1 ELSE 0 END`).bind(guard.sessionHash,guard.tenantId,guard.envelopeId,guard.origin,...statuses);
}
export async function assertSyntheticSigningAuthorization(db:D1Database,guard:SyntheticSigningGuard,statuses:readonly string[]):Promise<void>{
 if(!statuses.length||statuses.some(s=>!syntheticStatuses.includes(s as typeof syntheticStatuses[number])))throw new Error('Invalid synthetic signing status');
 const placeholders=statuses.map(()=>'?').join(',');
 const row=await db.prepare(`SELECT 1 FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
  JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id JOIN recipient_otp_verifications v ON v.task_id=s.task_id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
  WHERE s.token_hash=? AND s.tenant_id=? AND s.envelope_id=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND e.status IN (${placeholders})
  AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)`).bind(guard.sessionHash,guard.tenantId,guard.envelopeId,guard.origin,...statuses).first();
 if(!row)throw new Error('Synthetic signing session unavailable');
}
export function syntheticRecoveryAuthorizationAssertion(db:D1Database,guard:SyntheticRecoveryGuard,statuses:readonly string[]):D1PreparedStatement{
 if(!statuses.length||statuses.some(s=>!['IN_PROGRESS','FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED'].includes(s)))throw new Error('Invalid synthetic recovery status');
 const placeholders=statuses.map(()=>'?').join(',');
 return db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
  SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id
  WHERE k.key_hash=? AND k.tenant_id=? AND k.revoked_at IS NULL AND e.id=? AND e.status IN (${placeholders})
  AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions s WHERE s.token_hash=k.key_hash)
 ) THEN 1 ELSE 0 END`).bind(guard.keyHash,guard.tenantId,guard.envelopeId,...statuses);
}
export async function assertSyntheticRecoveryAuthorization(db:D1Database,guard:SyntheticRecoveryGuard,statuses:readonly string[]):Promise<void>{
 if(!statuses.length||statuses.some(s=>!['IN_PROGRESS','FINALIZING','SYNTHETIC_TSA_TEST_COMPLETED'].includes(s)))throw new Error('Invalid synthetic recovery status');
 const placeholders=statuses.map(()=>'?').join(',');
 const row=await db.prepare(`SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id
 WHERE k.key_hash=? AND k.tenant_id=? AND k.revoked_at IS NULL AND e.id=? AND e.status IN (${placeholders})
 AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions s WHERE s.token_hash=k.key_hash)`).bind(guard.keyHash,guard.tenantId,guard.envelopeId,...statuses).first();
 if(!row)throw new Error('Synthetic recovery unavailable');
}
