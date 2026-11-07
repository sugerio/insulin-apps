/** Internal, experimental primitives. Not an HTTP authorization boundary by themselves. */
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
function validOrigin(origin: string): boolean {
  try { const url = new URL(origin); return url.origin === origin && (url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))); } catch { return false; }
}
export async function otpHash(pepper: Uint8Array, taskId: string, otp: string, recipientEmail:string): Promise<string> {
  if (pepper.length < 32) throw new Error('OTP key too short');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['esign-otp-recipient-v1',taskId,recipientEmail,otp]))));
}
export function otpCode(): string {
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= 4294000000);
  return String(values[0] % 1000000).padStart(6, '0');
}
type View = { tenantId: string; envelopeId: string; taskId: string; origin: string; now: number };
export async function issueRecipientCode(db: D1Database, view: View): Promise<string> {
  if (!validOrigin(view.origin)) throw new Error('Invalid origin');
  const code = randomToken();
  const result = await db.prepare(`INSERT INTO recipient_page_codes (code_hash, tenant_id, envelope_id, task_id, origin, expires_at)
    SELECT ?, e.tenant_id, e.id, t.id, ?, ? FROM envelopes e JOIN tasks t ON t.envelope_id=e.id
    JOIN tenant_page_origins o ON o.tenant_id=e.tenant_id AND o.origin=?
    WHERE e.id=? AND e.tenant_id=? AND t.id=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations WHERE code_hash=?)`)
    .bind(await digest(code), view.origin, view.now + 120000, view.origin, view.envelopeId, view.tenantId, view.taskId, await digest(code)).run();
  if (result.meta.changes !== 1) throw new Error('Recipient unavailable');
  return code;
}
export async function exchangeRecipientCode(db: D1Database, code: string, origin: string, now: number): Promise<string> {
  if (!validOrigin(origin) || !/^[a-f0-9]{64}$/.test(code)) throw new Error('Invalid code');
  const hash = await digest(code), token = randomToken(), tokenHash = await digest(token);
  await db.batch([
    db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM recipient_page_codes c JOIN envelopes e ON e.id=c.envelope_id AND e.tenant_id=c.tenant_id JOIN tasks t ON t.id=c.task_id AND t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=c.tenant_id AND o.origin=c.origin WHERE c.code_hash=? AND c.origin=? AND c.used_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND c.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE') THEN 1 ELSE 0 END`).bind(hash, origin, now),
    db.prepare('INSERT INTO recipient_page_sessions SELECT ?, tenant_id, envelope_id, task_id, origin, ? FROM recipient_page_codes WHERE code_hash=?').bind(tokenHash, now + 900000, hash),
    db.prepare('UPDATE recipient_page_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=recipient_page_codes.code_hash)').bind(now, hash),
    db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN changes()=1 AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=?) AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations WHERE code_hash=?) THEN 1 ELSE 0 END').bind(tokenHash,hash),
    db.prepare('DELETE FROM recipient_auth_assertions'),
  ]);
  return token;
}
async function session(db: D1Database, token: string, origin: string, now: number): Promise<{task_id:string; recipient_email:string}> {
  if (!validOrigin(origin) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid session');
  const row = await db.prepare(`SELECT t.id AS task_id, t.recipient_email FROM recipient_page_sessions s JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE'`).bind(await digest(token), origin, now).first<{task_id:string;recipient_email:string}>();
  if (!row) throw new Error('Invalid session');
  return row;
}
export async function authorizeRecipientSession(db: D1Database, token: string, origin: string, now: number): Promise<string> { return (await session(db, token, origin, now)).task_id; }
export async function sendRecipientOtp(db: D1Database, token: string, origin: string, now: number, pepper: Uint8Array, send: (email:string, otp:string) => Promise<void>): Promise<void> {
  const s = await session(db, token, origin, now), otp = otpCode(), sessionHash = await digest(token);
  const result = await db.prepare(`INSERT INTO recipient_otp_challenges (task_id, session_hash, otp_hash, expires_at, window_started_at, next_send_at, sends, recipient_email)
    SELECT t.id, s.token_hash, ?, ?, ?, ?, 1, t.recipient_email FROM recipient_page_sessions s JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.recipient_email=? COLLATE BINARY
    ON CONFLICT(task_id) DO UPDATE SET session_hash=excluded.session_hash, otp_hash=excluded.otp_hash, expires_at=excluded.expires_at, recipient_email=excluded.recipient_email, consumed_by=NULL,
      attempts=CASE WHEN recipient_otp_challenges.window_started_at + 900000 <= excluded.window_started_at THEN 0 ELSE recipient_otp_challenges.attempts END,
      sends=CASE WHEN recipient_otp_challenges.window_started_at + 900000 <= excluded.window_started_at THEN 1 ELSE recipient_otp_challenges.sends+1 END,
      window_started_at=CASE WHEN recipient_otp_challenges.window_started_at + 900000 <= excluded.window_started_at THEN excluded.window_started_at ELSE recipient_otp_challenges.window_started_at END,
      next_send_at=excluded.next_send_at
    WHERE (recipient_otp_challenges.consumed_by IS NULL OR recipient_otp_challenges.session_hash <> excluded.session_hash) AND (recipient_otp_challenges.window_started_at + 900000 <= excluded.window_started_at OR
      (recipient_otp_challenges.attempts<5 AND recipient_otp_challenges.sends<3 AND recipient_otp_challenges.next_send_at<=excluded.window_started_at))`)
    .bind(await otpHash(pepper, s.task_id, otp,s.recipient_email), now + 300000, now, now + 60000, sessionHash, origin, now,s.recipient_email).run();
  if (result.meta.changes !== 1) throw new Error('OTP unavailable');
  await send(s.recipient_email, otp);
}
export async function verifyRecipientOtp(db: D1Database, token: string, origin: string, now: number, pepper: Uint8Array, otp: string): Promise<boolean> {
  if (!/^\d{6}$/.test(otp)) return false;
  const s = await session(db, token, origin, now), sessionHash = await digest(token), nonce = randomToken();
  const hash = await otpHash(pepper, s.task_id, otp,s.recipient_email);
  const results = await db.batch([
    db.prepare(`UPDATE recipient_otp_challenges SET attempts=attempts+1, consumed_by=CASE WHEN otp_hash=? THEN ? ELSE NULL END WHERE task_id=? AND session_hash=? AND expires_at>? AND attempts<5 AND consumed_by IS NULL AND recipient_email=? COLLATE BINARY AND EXISTS (SELECT 1 FROM recipient_page_sessions s JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.recipient_email=recipient_otp_challenges.recipient_email COLLATE BINARY)`).bind(hash, nonce, s.task_id, sessionHash, now, s.recipient_email, sessionHash, origin, now),
    db.prepare('INSERT INTO recipient_otp_verifications (task_id, session_hash, verified_at, recipient_email) SELECT c.task_id, c.session_hash, ?, c.recipient_email FROM recipient_otp_challenges c JOIN tasks t ON t.id=c.task_id WHERE c.task_id=? AND c.consumed_by=? AND c.recipient_email IS NOT NULL AND c.recipient_email=t.recipient_email COLLATE BINARY ON CONFLICT(task_id) DO UPDATE SET session_hash=excluded.session_hash, verified_at=excluded.verified_at, recipient_email=excluded.recipient_email').bind(now, s.task_id, nonce),
  ]);
  if (results[1].meta.changes === 1) return true;
  // A lost response may be retried only by the same still-authorized session with the same OTP.
  const verified = await db.prepare(`SELECT 1 FROM recipient_otp_challenges c
    JOIN recipient_otp_verifications v ON v.task_id=c.task_id AND v.session_hash=c.session_hash
    JOIN recipient_page_sessions s ON s.token_hash=v.session_hash AND s.task_id=v.task_id
    JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
    JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
    JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
    WHERE c.task_id=? AND c.session_hash=? AND c.otp_hash=? AND c.consumed_by IS NOT NULL
      AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND c.recipient_email IS NOT NULL AND c.recipient_email=t.recipient_email COLLATE BINARY AND v.recipient_email=t.recipient_email COLLATE BINARY`)
    .bind(s.task_id,sessionHash,hash,origin,now).first();
  return !!verified;
}
