import { PDFDocument } from 'pdf-lib';
import { canonicalSignatureEvent } from './signature-event.ts';
import { assertRenderableRecipientNames } from './recipient-name.ts';

/** Fieldless v1 signing transition; positioned signatures use a separate v2 snapshot. */
type SignatureCommand = { token: string; origin: string; now: number; artifactId: string; artifactHash: string; consent: boolean };
export async function recordSignature(db: D1Database, bucket: R2Bucket, cmd: SignatureCommand): Promise<string> {
  if (cmd.consent !== true || !/^[a-f0-9]{64}$/.test(cmd.token)) throw new Error('Invalid signing request');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cmd.token))), n => n.toString(16).padStart(2, '0')).join('');
  const signatureId = crypto.randomUUID();
  const snapshot = await db.prepare(`SELECT s.envelope_id, t.id AS task_id, t.recipient_name, t.recipient_email, v.verified_at FROM recipient_page_sessions s
    JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id
    JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE s.token_hash=?`)
    .bind(hash).first<{envelope_id:string; task_id:string; recipient_name:string; recipient_email:string; verified_at:number}>();
  if (!snapshot) throw new Error('Unverified session');
  const recipients = (await db.prepare('SELECT id, recipient_name FROM tasks WHERE envelope_id=?')
    .bind(snapshot.envelope_id).all<{id:string;recipient_name:string}>()).results;
  await assertRenderableRecipientNames(recipients.map(recipient => recipient.recipient_name));
  const previous = await db.prepare('SELECT sequence, event_hash FROM signature_events WHERE envelope_id=? ORDER BY sequence DESC LIMIT 1')
    .bind(snapshot.envelope_id).first<{sequence:number; event_hash:string}>();
  const sequence = (previous?.sequence ?? 0) + 1, previousHash = previous?.event_hash ?? '';
  const input = sequence === 1
    ? await db.prepare('SELECT object_key, NULL AS page_count, NULL AS slot FROM artifacts WHERE envelope_id=? AND id=? AND sha256=?')
      .bind(snapshot.envelope_id,cmd.artifactId,cmd.artifactHash).first<{object_key:string;page_count:number|null;slot:number|null}>()
    : await db.prepare(`SELECT o.object_key,l.page_count,l.slot FROM signature_records r
      JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE'
      JOIN signature_outputs o ON o.job_id=j.id JOIN signature_layouts l ON l.job_id=o.job_id
      WHERE r.envelope_id=? AND r.sequence=? AND o.artifact_id=? AND o.sha256=?
      AND typeof(l.page_count)='integer' AND l.page_count>1 AND typeof(l.slot)='integer' AND l.slot BETWEEN 0 AND 7`)
      .bind(snapshot.envelope_id,sequence-1,cmd.artifactId,cmd.artifactHash).first<{object_key:string;page_count:number|null;slot:number|null}>();
  if (!input) throw new Error('Input layout unavailable');
  const object = await bucket.get(input.object_key);
  if (!object) throw new Error('Input missing');
  const bytes = await object.arrayBuffer();
  const inputHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), n=>n.toString(16).padStart(2,'0')).join('');
  if (inputHash !== cmd.artifactHash) throw new Error('Input hash mismatch');
  const pdf = await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});
  if (pdf.getPageCount() < 1 || (sequence > 1 && pdf.getPageCount() !== input.page_count)) throw new Error('Input layout mismatch');
  // UTF-8 JSON array with this fixed field order; genesis previous hash is the empty string.
  const canonical = canonicalSignatureEvent({envelopeId:snapshot.envelope_id,sequence,previousHash,signatureId,taskId:snapshot.task_id,recipientName:snapshot.recipient_name,artifactId:cmd.artifactId,artifactHash:cmd.artifactHash,otpVerifiedAt:snapshot.verified_at,consentedAt:cmd.now});
  const eventHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))), n => n.toString(16).padStart(2, '0')).join('');
  await db.batch([
    db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN
      (SELECT COUNT(*) FROM tasks WHERE envelope_id=?)=? THEN 1 ELSE 0 END`).bind(snapshot.envelope_id, recipients.length),
    ...recipients.map(recipient => db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS
      (SELECT 1 FROM tasks WHERE envelope_id=? AND id=? AND recipient_name=?) THEN 1 ELSE 0 END`)
      .bind(snapshot.envelope_id, recipient.id, recipient.recipient_name)),
    db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
      SELECT 1 FROM recipient_page_sessions s JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
      JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
      JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
      JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
      WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND v.verified_at<=? AND t.recipient_email=? COLLATE BINARY
      AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM signature_records WHERE task_id=t.id)
      AND (EXISTS (SELECT 1 FROM artifacts a WHERE a.envelope_id=e.id AND a.id=? AND a.sha256=? AND NOT EXISTS (SELECT 1 FROM signature_records r WHERE r.envelope_id=e.id))
        OR EXISTS (SELECT 1 FROM signature_outputs so JOIN signature_jobs j ON j.id=so.job_id JOIN signature_records r ON r.id=j.signature_id
          JOIN signature_layouts l ON l.job_id=so.job_id
          WHERE r.envelope_id=e.id AND r.sequence=(SELECT MAX(sequence) FROM signature_records WHERE envelope_id=e.id)
          AND so.artifact_id=? AND so.sha256=? AND j.status='DONE'
          AND typeof(l.page_count)='integer' AND l.page_count>1 AND typeof(l.slot)='integer' AND l.slot BETWEEN 0 AND 7))
    ) THEN 1 ELSE 0 END`).bind(hash, cmd.origin, cmd.now, cmd.now, snapshot.recipient_email, cmd.artifactId, cmd.artifactHash, cmd.artifactId, cmd.artifactHash),
    sequence === 1
      ? db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS
          (SELECT 1 FROM artifacts WHERE envelope_id=? AND id=? AND sha256=? AND object_key=?) THEN 1 ELSE 0 END`)
        .bind(snapshot.envelope_id,cmd.artifactId,cmd.artifactHash,input.object_key)
      : db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
          SELECT 1 FROM signature_records r JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE'
          JOIN signature_outputs o ON o.job_id=j.id JOIN signature_layouts l ON l.job_id=o.job_id
          WHERE r.envelope_id=? AND r.sequence=? AND o.artifact_id=? AND o.sha256=? AND o.object_key=?
          AND l.page_count=? AND l.slot=? AND typeof(l.page_count)='integer' AND typeof(l.slot)='integer'
        ) THEN 1 ELSE 0 END`).bind(snapshot.envelope_id,sequence-1,cmd.artifactId,cmd.artifactHash,input.object_key,input.page_count,input.slot),
    db.prepare(`INSERT INTO signature_records (id,envelope_id,task_id,sequence,session_hash,recipient_name,input_artifact_id,input_sha256,otp_verified_at,consented_at,otp_recipient_email)
      SELECT ?,s.envelope_id,t.id,COALESCE((SELECT MAX(sequence) FROM signature_records WHERE envelope_id=s.envelope_id),0)+1,s.token_hash,t.recipient_name,?,?,v.verified_at,?,v.recipient_email
      FROM recipient_page_sessions s JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id
      JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE s.token_hash=?`)
      .bind(signatureId, cmd.artifactId, cmd.artifactHash, cmd.now, hash),
    db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (
      SELECT 1 FROM signature_records r WHERE r.id=? AND r.envelope_id=? AND r.task_id=? AND r.sequence=?
      AND r.recipient_name=? AND r.input_artifact_id=? AND r.input_sha256=? AND r.otp_verified_at=? AND r.consented_at=?
      AND COALESCE((SELECT event_hash FROM signature_events WHERE envelope_id=r.envelope_id ORDER BY sequence DESC LIMIT 1),'')=?
      AND COALESCE((SELECT MAX(sequence) FROM signature_events WHERE envelope_id=r.envelope_id),0)=?-1
    ) THEN 1 ELSE 0 END`).bind(signatureId, snapshot.envelope_id, snapshot.task_id, sequence, snapshot.recipient_name,
      cmd.artifactId, cmd.artifactHash, snapshot.verified_at, cmd.now, previousHash, sequence),
    ...(sequence > 1 ? [db.prepare('INSERT INTO signature_input_layouts (signature_id,object_key,page_count,slot) VALUES (?,?,?,?)')
      .bind(signatureId,input.object_key,input.page_count,input.slot)] : []),
    db.prepare('INSERT INTO signature_events (signature_id,envelope_id,sequence,previous_hash,event_hash) VALUES (?,?,?,?,?)')
      .bind(signatureId, snapshot.envelope_id, sequence, previousHash, eventHash),
    db.prepare("UPDATE tasks SET status='SIGNED' WHERE id=(SELECT task_id FROM signature_records WHERE id=?) AND status='ACTIVE'").bind(signatureId),
    db.prepare("INSERT INTO signature_jobs (id,signature_id,status) VALUES (?,?,'PENDING')").bind(crypto.randomUUID(), signatureId),
    db.prepare('DELETE FROM recipient_auth_assertions'),
  ]);
  return signatureId;
}
