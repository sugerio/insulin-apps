import {signatureGeometry} from './positioned-signature-geometry.ts';
import {PDFDocument} from 'pdf-lib';
import {canonicalSignatureEvent} from './signature-event.ts';
import {validatePositionedSnapshot} from './positioned-signature-snapshot.ts';
import {validatePositionedPdf} from './positioned-template.ts';

const hash=async(data:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(data))),n=>n.toString(16).padStart(2,'0')).join('');
type Row={status:string;signature_id:string;envelope_id:string;task_id:string;recipient_name:string;consented_at:number;otp_verified_at:number;input_sha256:string;input_artifact_id:string;sequence:number;previous_hash:string;event_hash:string;input_object_key:string;input_page_count:number;payload_json:string};
export async function processPositionedSignatureJob(db:D1Database,bucket:R2Bucket,jobId:string):Promise<void>{
 const row=await db.prepare(`SELECT j.status,r.id AS signature_id,r.envelope_id,r.task_id,r.recipient_name,r.consented_at,r.otp_verified_at,r.input_sha256,r.input_artifact_id,r.sequence,e.previous_hash,e.event_hash,p.input_object_key,p.input_page_count,p.payload_json FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN signature_events e ON e.signature_id=r.id AND e.event_version=2 JOIN positioned_signature_inputs p ON p.signature_id=r.id WHERE j.id=?`).bind(jobId).first<Row>();
 if(!row||!['PENDING','DONE'].includes(row.status))throw new Error('Positioned job unavailable');
 const previous=row.sequence===1?null:await db.prepare('SELECT event_hash FROM signature_events WHERE envelope_id=? AND sequence=? AND event_version=2').bind(row.envelope_id,row.sequence-1).first<{event_hash:string}>();
 if(row.sequence===1?row.previous_hash!=='':!previous||row.previous_hash!==previous.event_hash)throw new Error('Event chain mismatch');
 const payload=validatePositionedSnapshot(JSON.parse(row.payload_json),row.input_page_count);
 const canonical=canonicalSignatureEvent({envelopeId:row.envelope_id,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.signature_id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at},payload);
 if(await hash(new TextEncoder().encode(canonical))!==row.event_hash)throw new Error('Event mismatch');
 const source=await bucket.get(row.input_object_key);if(!source)throw new Error('Missing input');const bytes=new Uint8Array(await source.arrayBuffer());if(await hash(bytes)!==row.input_sha256)throw new Error('Input mismatch');
 const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});validatePositionedPdf(pdf);if(pdf.getPageCount()!==row.input_page_count)throw new Error('Page count mismatch');
 for(const field of payload.fields){const object=await bucket.get(`envelopes/${row.envelope_id}/signature-images/${row.signature_id}/${field.id}.png`);if(!object)throw new Error('Missing image');const image=new Uint8Array(await object.arrayBuffer());if(await hash(image)!==field.imageHash)throw new Error('Image mismatch');const png=await pdf.embedPng(image);const page=pdf.getPage(field.page-1),r=field.rect,boxW=r.width*page.getWidth(),boxH=r.height*page.getHeight(),scale=Math.min(boxW/png.width,boxH/png.height);const g=signatureGeometry(page,field,image);if(JSON.stringify(g)!==JSON.stringify(field.geometry))throw new Error('Signature geometry mismatch');page.drawImage(png,{x:g.x,y:page.getHeight()-g.y-g.height,width:g.width,height:g.height});}
 if(row.status==='DONE'){
  const output=await db.prepare('SELECT object_key,sha256 FROM signature_outputs WHERE job_id=?').bind(jobId).first<{object_key:string;sha256:string}>();const existing=output&&await bucket.get(output.object_key);if(!output||!existing||await hash(new Uint8Array(await existing.arrayBuffer()))!==output.sha256)throw new Error('Output integrity failure');return;
 }
 const output=await pdf.save({useObjectStreams:false}),outputHash=await hash(output),artifactId=`signed:${row.signature_id}`,key=`envelopes/${row.envelope_id}/${artifactId}.pdf`;
 const stored=await bucket.put(key,output,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}});if(!stored){const existing=await bucket.get(key);if(!existing||await hash(new Uint8Array(await existing.arrayBuffer()))!==outputHash)throw new Error('Output conflict');}
 await db.batch([
  db.prepare(`INSERT INTO signature_outputs (job_id,artifact_id,object_key,sha256) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM signature_jobs WHERE id=? AND status='PENDING') ON CONFLICT(job_id) DO NOTHING`).bind(jobId,artifactId,key,outputHash,jobId),
  db.prepare("INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM signature_outputs WHERE job_id=? AND artifact_id=? AND object_key=? AND sha256=?) THEN 1 ELSE 0 END").bind(jobId,artifactId,key,outputHash),
  db.prepare(`UPDATE tasks SET status='ACTIVE' WHERE id=(SELECT t.id FROM tasks t WHERE t.envelope_id=? AND t.status='PENDING' ORDER BY t.routing_order LIMIT 1) AND EXISTS (SELECT 1 FROM signature_jobs j JOIN signature_outputs o ON o.job_id=j.id WHERE j.id=? AND j.status='PENDING' AND o.sha256=?) AND NOT EXISTS (SELECT 1 FROM tasks WHERE envelope_id=? AND status='ACTIVE')`).bind(row.envelope_id,jobId,outputHash,row.envelope_id),
  db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id=? AND status='IN_PROGRESS' AND EXISTS (SELECT 1 FROM signature_jobs j JOIN signature_outputs o ON o.job_id=j.id WHERE j.id=? AND j.status='PENDING' AND o.sha256=?) AND NOT EXISTS (SELECT 1 FROM tasks WHERE envelope_id=? AND status IN ('ACTIVE','PENDING'))").bind(row.envelope_id,jobId,outputHash,row.envelope_id),
  db.prepare("UPDATE signature_jobs SET status='DONE' WHERE id=? AND status='PENDING' AND EXISTS (SELECT 1 FROM signature_outputs WHERE job_id=? AND artifact_id=? AND object_key=? AND sha256=?)").bind(jobId,jobId,artifactId,key,outputHash),
  db.prepare("INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM signature_jobs j JOIN signature_outputs o ON o.job_id=j.id WHERE j.id=? AND j.status='DONE' AND o.artifact_id=? AND o.object_key=? AND o.sha256=?) THEN 1 ELSE 0 END").bind(jobId,artifactId,key,outputHash),db.prepare('DELETE FROM recipient_auth_assertions')
 ]);
}
