import {createCloudflareOtpMailer,isValidOtpEmailAddress} from './cloudflare-otp-mail.ts';
import {otpCode,otpHash} from './page-authorization.ts';

type EmailBinding=NonNullable<Parameters<typeof createCloudflareOtpMailer>[0]['binding']>;
type IsolatedOtpEnv={DB?:D1Database;SEND_EMAIL?:EmailBinding;ISOLATED_OTP_ENABLED?:string;ISOLATED_OTP_FROM?:string;ISOLATED_OTP_RECIPIENTS?:string;ISOLATED_OTP_SYNTHETIC_SINK_ENABLED?:string;ISOLATED_OTP_SYNTHETIC_SINK?:string;ISOLATED_OTP_PEPPER?:string;ISOLATED_OTP_WINDOW_MS?:string;ISOLATED_OTP_TENANT_LIMIT?:string;ISOLATED_OTP_ACCOUNT_LIMIT?:string};
const integer=(value:string|undefined,min:number,max:number)=>{if(typeof value!=='string'||!/^[1-9]\d*$/.test(value))throw new Error('Isolated OTP unavailable');const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Isolated OTP unavailable');return n;};
const label=(value:unknown):value is string=>typeof value==='string'&&/^[\x21-\x7e]+(?![\s\S])/.test(value)&&isValidOtpEmailAddress(value);
const email=(value:unknown):value is string=>typeof value==='string'&&/^[\x21-\x7e]+(?![\s\S])/.test(value)&&value===value.toLowerCase()&&isValidOtpEmailAddress(value);
export function isolatedOtpDestinationConfig(env:{ISOLATED_OTP_RECIPIENTS?:string;ISOLATED_OTP_SYNTHETIC_SINK_ENABLED?:string;ISOLATED_OTP_SYNTHETIC_SINK?:string}):{sink:string|null;recipients:string[]} {
 if(env.ISOLATED_OTP_SYNTHETIC_SINK_ENABLED==='true') {
  if(env.ISOLATED_OTP_RECIPIENTS!==undefined||!email(env.ISOLATED_OTP_SYNTHETIC_SINK))throw new Error('Isolated OTP unavailable');
  return {sink:env.ISOLATED_OTP_SYNTHETIC_SINK,recipients:[]};
 }
 if(env.ISOLATED_OTP_SYNTHETIC_SINK_ENABLED!==undefined||env.ISOLATED_OTP_SYNTHETIC_SINK!==undefined||typeof env.ISOLATED_OTP_RECIPIENTS!=='string'||env.ISOLATED_OTP_RECIPIENTS.length>1024)throw new Error('Isolated OTP unavailable');
 const recipients:unknown=JSON.parse(env.ISOLATED_OTP_RECIPIENTS);
 if(!Array.isArray(recipients)||recipients.length!==2||!recipients.every(email)||new Set(recipients).size!==2)throw new Error('Isolated OTP unavailable');
 return {sink:null,recipients};
}
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');

/** Unmounted isolated service; trusted caller/session issuance and real-resource authorization are NOT provided. */
export async function sendIsolatedCloudflareOtp(env:IsolatedOtpEnv,token:string,origin:string):Promise<void>{
 try{await sendIsolatedCloudflareOtpOnce(env,token,origin);}catch{throw new Error('Isolated OTP unavailable');}
}
async function sendIsolatedCloudflareOtpOnce(env:IsolatedOtpEnv,token:string,origin:string):Promise<void>{
 if(!env||env.ISOLATED_OTP_ENABLED!=='true'||!env.DB||!env.SEND_EMAIL||!email(env.ISOLATED_OTP_FROM)||typeof env.ISOLATED_OTP_PEPPER!=='string'||new TextEncoder().encode(env.ISOLATED_OTP_PEPPER).length<32||new TextEncoder().encode(env.ISOLATED_OTP_PEPPER).length>256||typeof token!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(token)||typeof origin!=='string')throw new Error('Isolated OTP unavailable');
 try{const url=new URL(origin);if(origin.length>2048||url.protocol!=='https:'||url.origin!==origin)throw new Error();}catch{throw new Error('Isolated OTP unavailable');}
 const destination=isolatedOtpDestinationConfig(env);
 const windowMs=integer(env.ISOLATED_OTP_WINDOW_MS,60000,86400000),tenantLimit=integer(env.ISOLATED_OTP_TENANT_LIMIT,1,1000),accountLimit=integer(env.ISOLATED_OTP_ACCOUNT_LIMIT,1,1000);
 const db=env.DB,pepper=new TextEncoder().encode(env.ISOLATED_OTP_PEPPER),sender=createCloudflareOtpMailer({enabled:'true',from:env.ISOLATED_OTP_FROM,binding:env.SEND_EMAIL}),hash=await digest(token);
 const session=await db.prepare(`SELECT s.tenant_id,s.task_id,t.recipient_email,CAST(unixepoch('subsec')*1000 AS INTEGER) AS now_ms FROM recipient_page_sessions s
  JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
  WHERE s.token_hash=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash) AND s.origin=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations rev WHERE rev.token_hash=s.token_hash) AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000
  AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)`).bind(hash,origin).first<{tenant_id:string;task_id:string;recipient_email:string;now_ms:number}>();
 if(!session||(!label(session.recipient_email)||(!destination.sink&&!destination.recipients.includes(session.recipient_email)))||!Number.isSafeInteger(session.now_ms))throw new Error('Isolated OTP unavailable');
 const now=session.now_ms,otp=otpCode(),otpDigest=await otpHash(pepper,session.task_id,otp,session.recipient_email),reservation=crypto.randomUUID();
 const reserve=(kind:'account'|'tenant',id:string,limit:number)=>[
  db.prepare(`INSERT INTO isolated_otp_send_budgets(scope_kind,scope_id,window_started_at,window_ms,send_limit,send_count,reservation_id) VALUES (?,?,?,?,?,1,?)
   ON CONFLICT(scope_kind,scope_id) DO UPDATE SET window_started_at=CASE WHEN isolated_otp_send_budgets.window_started_at+isolated_otp_send_budgets.window_ms<=excluded.window_started_at THEN excluded.window_started_at ELSE isolated_otp_send_budgets.window_started_at END,
   window_ms=CASE WHEN isolated_otp_send_budgets.window_started_at+isolated_otp_send_budgets.window_ms<=excluded.window_started_at THEN excluded.window_ms ELSE isolated_otp_send_budgets.window_ms END,
   send_limit=CASE WHEN isolated_otp_send_budgets.window_started_at+isolated_otp_send_budgets.window_ms<=excluded.window_started_at THEN excluded.send_limit ELSE isolated_otp_send_budgets.send_limit END,
   send_count=CASE WHEN isolated_otp_send_budgets.window_started_at+isolated_otp_send_budgets.window_ms<=excluded.window_started_at THEN 1 ELSE isolated_otp_send_budgets.send_count+1 END,reservation_id=excluded.reservation_id
   WHERE excluded.window_started_at>=isolated_otp_send_budgets.window_started_at AND (isolated_otp_send_budgets.window_started_at+isolated_otp_send_budgets.window_ms<=excluded.window_started_at OR (isolated_otp_send_budgets.window_ms=excluded.window_ms AND isolated_otp_send_budgets.send_limit=excluded.send_limit AND isolated_otp_send_budgets.send_count<excluded.send_limit))`).bind(kind,id,now,windowMs,limit,reservation),
  db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM isolated_otp_send_budgets WHERE scope_kind=? AND scope_id=? AND reservation_id=?) THEN 1 ELSE 0 END').bind(kind,id,reservation)
 ];
 await db.batch([
  db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
   WHERE s.token_hash=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash) AND s.origin=? AND s.tenant_id=? AND t.id=? AND t.recipient_email=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations rev WHERE rev.token_hash=s.token_hash) AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)) THEN 1 ELSE 0 END`).bind(hash,origin,session.tenant_id,session.task_id,session.recipient_email,now+900000),
  ...reserve('account','',accountLimit),...reserve('tenant',session.tenant_id,tenantLimit),
  db.prepare(`INSERT INTO isolated_otp_quota_reservations(reservation_id,task_id,session_hash,reserved_at)
   SELECT ?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER)
   WHERE (SELECT COUNT(*) FROM isolated_otp_quota_reservations)<10
   AND (SELECT COUNT(*) FROM isolated_otp_quota_reservations WHERE task_id=?)<3
   AND NOT EXISTS (SELECT 1 FROM isolated_otp_quota_reservations WHERE session_hash=?)`).bind(reservation,session.task_id,hash,session.task_id,hash),
  db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM isolated_otp_quota_reservations WHERE reservation_id=?) THEN 1 ELSE 0 END').bind(reservation),
  db.prepare(`INSERT INTO recipient_otp_challenges(task_id,session_hash,otp_hash,expires_at,window_started_at,next_send_at,sends,isolated_issue_id,recipient_email) VALUES (?,?,?,?,?,?,1,?,?)
   ON CONFLICT(task_id) DO UPDATE SET session_hash=excluded.session_hash,otp_hash=excluded.otp_hash,expires_at=excluded.expires_at,recipient_email=excluded.recipient_email,consumed_by=NULL,
    attempts=CASE WHEN recipient_otp_challenges.window_started_at+900000<=excluded.window_started_at THEN 0 ELSE recipient_otp_challenges.attempts END,
    sends=CASE WHEN recipient_otp_challenges.window_started_at+900000<=excluded.window_started_at THEN 1 ELSE recipient_otp_challenges.sends+1 END,
    window_started_at=CASE WHEN recipient_otp_challenges.window_started_at+900000<=excluded.window_started_at THEN excluded.window_started_at ELSE recipient_otp_challenges.window_started_at END,
    next_send_at=excluded.next_send_at,isolated_issue_id=excluded.isolated_issue_id
   WHERE (recipient_otp_challenges.consumed_by IS NULL OR recipient_otp_challenges.session_hash<>excluded.session_hash) AND (recipient_otp_challenges.window_started_at+900000<=excluded.window_started_at OR (recipient_otp_challenges.attempts<5 AND recipient_otp_challenges.sends<3 AND recipient_otp_challenges.next_send_at<=excluded.window_started_at))`).bind(session.task_id,hash,otpDigest,now+300000,now,now+60000,reservation,session.recipient_email),
  db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM recipient_otp_challenges WHERE task_id=? AND session_hash=? AND isolated_issue_id=?) THEN 1 ELSE 0 END').bind(session.task_id,hash,reservation),
  db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id WHERE s.token_hash=? AND s.origin=? AND s.tenant_id=? AND t.id=? AND t.recipient_email=? COLLATE BINARY AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash) AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)) THEN 1 ELSE 0 END`).bind(hash,origin,session.tenant_id,session.task_id,session.recipient_email),
  db.prepare('DELETE FROM recipient_auth_assertions')
 ]);
 const ready=await db.prepare(`SELECT 1 FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN recipient_otp_challenges c ON c.task_id=t.id AND c.session_hash=s.token_hash
  WHERE s.token_hash=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash) AND s.origin=? AND s.tenant_id=? AND t.id=? AND t.recipient_email=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations rev WHERE rev.token_hash=s.token_hash) AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND c.recipient_email=t.recipient_email COLLATE BINARY AND c.isolated_issue_id=? AND c.otp_hash=? AND c.expires_at=? AND c.next_send_at=? AND c.consumed_by IS NULL AND c.attempts<5 AND c.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash)`).bind(hash,origin,session.tenant_id,session.task_id,session.recipient_email,now+900000,reservation,otpDigest,now+300000,now+60000).first();
 if(!ready)throw new Error('Isolated OTP unavailable');
 await sender(destination.sink ?? session.recipient_email,otp);
}

/** One-use verification. The preliminary read supplies HMAC inputs only; the batch rechecks all authority. */
export async function verifyIsolatedCloudflareOtp(env:IsolatedOtpEnv,token:string,origin:string,otp:string):Promise<boolean>{
 try {
  if (!env || env.ISOLATED_OTP_ENABLED!=='true' || !env.DB || !env.SEND_EMAIL || !email(env.ISOLATED_OTP_FROM) || typeof env.ISOLATED_OTP_PEPPER!=='string' || new TextEncoder().encode(env.ISOLATED_OTP_PEPPER).length<32 || new TextEncoder().encode(env.ISOLATED_OTP_PEPPER).length>256) throw new Error();
  integer(env.ISOLATED_OTP_WINDOW_MS,60000,86400000);integer(env.ISOLATED_OTP_TENANT_LIMIT,1,1000);integer(env.ISOLATED_OTP_ACCOUNT_LIMIT,1,1000);
  const destination=isolatedOtpDestinationConfig(env);
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||typeof otp!=='string'||!/^\d{6}$/.test(otp)||typeof origin!=='string'||origin.length>2048) return false;
  const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)return false;
  const db=env.DB,sessionHash=await digest(token);
  const row=await db.prepare(`SELECT t.id AS task_id,t.recipient_email FROM recipient_page_sessions s JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id WHERE s.token_hash=?`).bind(sessionHash).first<{task_id:string;recipient_email:string}>();
  if(!row||(!label(row.recipient_email)||(!destination.sink&&!destination.recipients.includes(row.recipient_email))))return false;
  const hash=await otpHash(new TextEncoder().encode(env.ISOLATED_OTP_PEPPER),row.task_id,otp,row.recipient_email),nonce=crypto.randomUUID();
  const results=await db.batch([
   db.prepare(`UPDATE recipient_otp_challenges SET attempts=attempts+1,consumed_by=CASE WHEN otp_hash=? THEN ? ELSE NULL END
    WHERE task_id=? AND session_hash=? AND isolated_issue_id IS NOT NULL AND recipient_email=? COLLATE BINARY AND consumed_by IS NULL AND attempts<5 AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
    AND EXISTS (SELECT 1 FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
     WHERE s.token_hash=recipient_otp_challenges.session_hash AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash) AND s.task_id=recipient_otp_challenges.task_id AND s.origin=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations rev WHERE rev.token_hash=s.token_hash) AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.recipient_email=recipient_otp_challenges.recipient_email COLLATE BINARY AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash))`).bind(hash,nonce,row.task_id,sessionHash,row.recipient_email,origin),
   db.prepare(`INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) SELECT c.task_id,c.session_hash,CAST(unixepoch('subsec')*1000 AS INTEGER),c.recipient_email FROM recipient_otp_challenges c JOIN recipient_page_sessions s ON s.token_hash=c.session_hash AND s.task_id=c.task_id JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id WHERE c.task_id=? AND c.session_hash=? AND c.consumed_by=? AND c.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations rev WHERE rev.token_hash=s.token_hash) AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND s.origin=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND c.recipient_email=? COLLATE BINARY AND t.recipient_email=c.recipient_email COLLATE BINARY AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=s.token_hash) ON CONFLICT(task_id) DO UPDATE SET session_hash=excluded.session_hash,verified_at=excluded.verified_at,recipient_email=excluded.recipient_email`).bind(row.task_id,sessionHash,nonce,origin,row.recipient_email),
   db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN changes()=0 AND EXISTS (SELECT 1 FROM recipient_otp_challenges WHERE task_id=? AND consumed_by=?) THEN 0 ELSE 1 END`).bind(row.task_id,nonce),
   db.prepare('DELETE FROM recipient_auth_assertions')
  ]);
  return results[1].meta.changes===1;
 } catch { throw new Error('Isolated OTP unavailable'); }
}
