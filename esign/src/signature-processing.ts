import { PDFDocument, StandardFonts } from 'pdf-lib';
import { processPositionedSignatureJob } from './positioned-signature-processing.ts';
import { assertRenderableRecipientNames } from './recipient-name.ts';
import { SIGNATURE_NAME_FONT_SIZE, SIGNATURE_PAGE_MARGIN, SIGNATURE_PAGE_SIZE, signatureNameLine } from './signature-page-layout.ts';

export class SignatureInputLayoutMissingError extends Error {
  constructor() { super('Unsupported or invalid signature layout: input snapshot missing'); }
}

/** Explicit local retry primitive; no scheduler or production evidence guarantee. */
export async function processSignatureJob(db: D1Database, bucket: R2Bucket, jobId: string): Promise<void> {
  const version=await db.prepare('SELECT e.event_version,p.signature_id AS positioned_id FROM signature_jobs j JOIN signature_events e ON e.signature_id=j.signature_id LEFT JOIN positioned_signature_inputs p ON p.signature_id=e.signature_id WHERE j.id=?').bind(jobId).first<{event_version:number;positioned_id:string|null}>();
  if(!version)throw new Error('Signature event missing');
  if(version.event_version===2)return processPositionedSignatureJob(db,bucket,jobId);
  if(version.positioned_id)throw new Error('Unexpected positioned input');
  if(version.event_version!==1)throw new Error('Unsupported event version');
  const row = await db.prepare(`SELECT j.status, r.id AS signature_id, r.envelope_id, r.task_id, r.recipient_name, r.consented_at, r.input_sha256, r.input_artifact_id, r.sequence,
    COALESCE((SELECT a.object_key FROM artifacts a WHERE a.id=r.input_artifact_id AND a.envelope_id=r.envelope_id),
      (SELECT o.object_key FROM signature_outputs o JOIN signature_jobs pj ON pj.id=o.job_id JOIN signature_records pr ON pr.id=pj.signature_id WHERE o.artifact_id=r.input_artifact_id AND pr.envelope_id=r.envelope_id)) AS input_key
    FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id WHERE j.id=?`).bind(jobId).first<{status:string;signature_id:string;envelope_id:string;task_id:string;recipient_name:string;consented_at:number;input_sha256:string;input_artifact_id:string;sequence:number;input_key:string | null}>();
  if (!row) throw new Error('Job missing');
  if (row.status === 'DONE') return;
  if (row.status !== 'PENDING' || (row.sequence === 1 && !row.input_key)) throw new Error('Job unavailable');
  const capturedInput = row.sequence > 1 ? await db.prepare('SELECT object_key FROM signature_input_layouts WHERE signature_id=?').bind(row.signature_id).first<{object_key:string}>() : null;
  if (row.sequence > 1 && !capturedInput) throw new SignatureInputLayoutMissingError();
  await assertRenderableRecipientNames([row.recipient_name]);
  const source = await bucket.get(capturedInput?.object_key ?? row.input_key!);
  if (!source) throw new Error('Input missing');
  const bytes = await source.arrayBuffer();
  const sha = async (data: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data instanceof Uint8Array ? Uint8Array.from(data) : data)), n=>n.toString(16).padStart(2,'0')).join('');
  if (await sha(bytes) !== row.input_sha256) throw new Error('Input hash mismatch');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  let slot = 0;
  if (row.sequence === 1) {
    const original = await db.prepare('SELECT id FROM artifacts WHERE id=? AND envelope_id=? AND sha256=?').bind(row.input_artifact_id,row.envelope_id,row.input_sha256).first();
    if (!original) throw new Error('Invalid first input');
  } else {
    const previous = await db.prepare('SELECT object_key,page_count,slot FROM signature_input_layouts WHERE signature_id=?')
      .bind(row.signature_id).first<{object_key:string;page_count:number;slot:number}>();
    if (!previous || previous.page_count !== pdf.getPageCount() || previous.slot < 0 || previous.slot > 7) throw new Error('Unsupported or invalid signature layout');
    slot = previous.slot + 1;
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = row.sequence === 1 || slot === 8 ? pdf.addPage(SIGNATURE_PAGE_SIZE) : pdf.getPage(pdf.getPageCount()-1);
  if (slot === 8) slot = 0;
  if (slot === 0) page.drawText('Electronic signature', {x:50,y:page.getHeight()-70,size:18,font});
  const y = page.getHeight()-105-slot*80;
  page.drawText(signatureNameLine(row.recipient_name), {x:SIGNATURE_PAGE_MARGIN,y,size:SIGNATURE_NAME_FONT_SIZE,font});
  page.drawText(`Time (UTC): ${new Date(row.consented_at).toISOString()}`, {x:50,y:y-25,size:12,font});
  const output = await pdf.save({useObjectStreams:false});
  const outputHash = await sha(output), artifactId = `signed:${row.signature_id}`, key = `envelopes/${row.envelope_id}/${artifactId}.pdf`;
  const stored = await bucket.put(key, output, {onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});
  if (!stored) {
    const existing = await bucket.get(key);
    if (!existing || await sha(await existing.arrayBuffer()) !== outputHash) throw new Error('Output conflict');
  }
  await db.batch([
    db.prepare(`INSERT INTO signature_outputs (job_id,artifact_id,object_key,sha256)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM signature_jobs WHERE id=? AND status='PENDING')
      ON CONFLICT(job_id) DO NOTHING`).bind(jobId, artifactId, key, outputHash, jobId),
    db.prepare(`INSERT INTO signature_layouts (job_id,page_count,slot)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM signature_outputs WHERE job_id=? AND artifact_id=? AND object_key=? AND sha256=?)
      ON CONFLICT(job_id) DO NOTHING`).bind(jobId,pdf.getPageCount(),slot,jobId,artifactId,key,outputHash),
    db.prepare("INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM signature_layouts WHERE job_id=? AND page_count=? AND slot=?) THEN 1 ELSE 0 END").bind(jobId,pdf.getPageCount(),slot),
    db.prepare('DELETE FROM recipient_auth_assertions'),
    db.prepare(`UPDATE tasks SET status='ACTIVE' WHERE id=(SELECT t.id FROM tasks t WHERE t.envelope_id=? AND t.status='PENDING' ORDER BY t.routing_order LIMIT 1)
      AND EXISTS (SELECT 1 FROM signature_jobs j JOIN signature_outputs o ON o.job_id=j.id WHERE j.id=? AND j.status='PENDING' AND o.sha256=?) AND NOT EXISTS (SELECT 1 FROM tasks WHERE envelope_id=? AND status='ACTIVE')`).bind(row.envelope_id,jobId,outputHash,row.envelope_id),
    db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id=? AND status='IN_PROGRESS' AND EXISTS (SELECT 1 FROM signature_jobs j JOIN signature_outputs o ON o.job_id=j.id WHERE j.id=? AND j.status='PENDING' AND o.sha256=?) AND NOT EXISTS (SELECT 1 FROM tasks WHERE envelope_id=? AND status IN ('ACTIVE','PENDING'))").bind(row.envelope_id,jobId,outputHash,row.envelope_id),
    db.prepare("UPDATE signature_jobs SET status='DONE' WHERE id=? AND status='PENDING' AND EXISTS (SELECT 1 FROM signature_outputs WHERE job_id=? AND artifact_id=? AND object_key=? AND sha256=?)").bind(jobId,jobId,artifactId,key,outputHash),
    db.prepare("INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM signature_jobs j JOIN signature_outputs o ON o.job_id=j.id WHERE j.id=? AND j.status='DONE' AND o.artifact_id=? AND o.object_key=? AND o.sha256=?) THEN 1 ELSE 0 END").bind(jobId,artifactId,key,outputHash),
    db.prepare('DELETE FROM recipient_auth_assertions'),
  ]);
}
