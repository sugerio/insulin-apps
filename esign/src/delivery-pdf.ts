import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { finalizeLocalTestEvidence } from './local-test-evidence.ts';

const hash = async (bytes: Uint8Array | ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? Uint8Array.from(bytes) : bytes)), n=>n.toString(16).padStart(2,'0')).join('');

import { AUDIT, auditTrail, type AuditEvent } from './audit.ts';
import { describeHostAuthentication, parseHostAuthentication, sendFacts } from './signer-facts.ts';

/**
 * The certificate layout of new envelopes. Each envelope keeps the layout it was made with
 * (envelope_certificate_versions; none means 1), because a stored certificate is rebuilt on
 * every read and must come out byte for byte the same. Version 2 adds the document's name, the
 * sender, who named each signer, how each signer was identified, their IP and device, and a
 * summary of the events (opened, pages viewed, identity confirmed, signed).
 */
export const CERTIFICATE_VERSION = 2;

async function certificateVersion(db: D1Database, envelopeId: string): Promise<number> {
  const row = await db.prepare('SELECT version FROM envelope_certificate_versions WHERE envelope_id = ?').bind(envelopeId).first<{ version: number }>();
  return row?.version ?? 1;
}

/**
 * The events a version-2 certificate summarizes: none can happen after the last signature, so the
 * summary is fixed. (COMPLETED is recorded only by the managed seal, after sealing.)
 */
const SUMMARY_EVENTS: ReadonlySet<string> = new Set([AUDIT.sessionOpened, AUDIT.pagesViewed, AUDIT.otpVerified, AUDIT.signed]);

/** How a signer was identified, from their OTP_VERIFIED event: the host's sign-in, then the emailed code. */
export function identification(detail: Record<string, unknown> | null | undefined): string {
  const auth = parseHostAuthentication(detail?.hostAuthentication);
  return auth && auth !== 'invalid' ? `${describeHostAuthentication(auth)}; email one-time code` : 'Email one-time code';
}
type DeliveryRow={task_id?:string;sequence:number;recipient_name:string;input_sha256:string;sha256:string;event_hash:string;otp_verified_at:number;consented_at:number;object_key:string};
/** Verified evidence for the delivery PDF, and how its certificate pages describe the seal. */
export type DeliveryEvidence={verify():Promise<{source:{id:string;sha256:string};signatures:DeliveryRow[];finalSha256:string;audit?:{sealed:AuditEvent[];afterSeal:AuditEvent[]}}|void>;banner:string;notes:string[];name:string;format:string};
const localDelivery=(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string,key:Uint8Array):DeliveryEvidence=>({
  verify:()=>finalizeLocalTestEvidence(db,bucket,tenantId,envelopeId,key,true),
  banner:'LOCAL TEST ONLY',
  notes:['LOCAL TEST ONLY - Local simulation; not a legal guarantee or independent timestamp.','Local HMAC uses a software key, not a managed KMS or independent TSA.','The original local evidence manifest does not seal this delivery PDF.'],
  name:'local-delivery-v3',format:'esign-local-delivery-v3',
});

/** A separate delivery artifact; the original evidence manifest never includes it. Pass the local test seal key, or the evidence of another seal. */
const AUDIT_SIGNED='SIGNED';

/** The signer's title and company on a SIGNED event ("" for older signatures, which had none). */
export function authorityFact(detail: Record<string, unknown> | null | undefined): string {
  const title=typeof detail?.title==='string'?detail.title:'', company=typeof detail?.onBehalfOf==='string'?detail.onBehalfOf:'';
  if(!title&&!company)return '';
  return [title?`as ${title}`:'',company?`on behalf of ${company}${detail?.authorityConfirmed===true?' (authority confirmed)':''}`:''].filter(Boolean).join(', ');
}

/** The authority fact of a signer's own SIGNED event ("" when they signed for nobody, or for an older signature). */
export function signerAuthority(events: readonly AuditEvent[], taskId: string | undefined): string {
  if(!taskId)return '';
  return authorityFact(events.find(event=>event.taskId===taskId&&event.type===AUDIT_SIGNED)?.detail);
}

export async function deliveryPdf(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string,source:Uint8Array|DeliveryEvidence) {
  const described=source instanceof Uint8Array?localDelivery(db,bucket,tenantId,envelopeId,source):source;
  const evidence=await described.verify();
  if(!evidence) throw new Error('Evidence unavailable');
  const last=evidence.signatures[evidence.signatures.length-1];
  const input=await bucket.get(last.object_key);
  if(!input) throw new Error('Final PDF missing');
  const inputBytes=await input.arrayBuffer();
  if(await hash(inputBytes)!==evidence.finalSha256) throw new Error('Final PDF mismatch');
  const pdf=await PDFDocument.load(inputBytes,{updateMetadata:false,throwOnInvalidObject:true});
  const font:PDFFont=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink=rgb(0.12,0.16,0.22), muted=rgb(0.40,0.44,0.50);
  let page!:PDFPage; let y=0;
  function newPage() {
    page=pdf.addPage([612,792]);
    page.drawText(described.banner, {x:50,y:758,size:10,font:bold,color:ink});
    y=735;
  }
  function ensure(height:number) { if(y-height<55) newPage(); }
  function wrapLines(value:string,width:number,size=10,face=font) {
    const lines:string[]=[];let part='';
    for(const ch of value) {
      if(face.widthOfTextAtSize(part+ch,size)>width && part) { lines.push(part);part=''; }
      part+=ch;
    }
    if(part) lines.push(part);
    return lines;
  }
  function wrapped(value:string,x:number,width:number,size=10,face=font,color=ink) {
    for(const part of wrapLines(value,width,size,face)) {
      ensure(15);page.drawText(part,{x,y,size,font:face,color});y-=15;
    }
  }
  function heading(value:string) {ensure(28);y-=10;wrapped(value,50,512,13,bold);y-=4;}
  function field(label:string,value:string,width=382) {
    ensure(15);const top=y;
    page.drawText(label,{x:50,y,size:10,font,color:muted});
    wrapped(value,180,width);if(y===top)y-=15;
    y-=3;
  }
  newPage();
  wrapped('Certificate of completion',50,512,22,bold);
  y-=6;
  wrapped(`Envelope ${envelopeId}`,50,512,10,font,muted);
  y-=5;page.drawLine({start:{x:50,y},end:{x:562,y},thickness:2,color:ink});y-=8;
  // The standard PDF font only has Latin-1; keep host and browser strings to printable ASCII.
  const ascii=(value:string)=>value.replace(/[^\x20-\x7e]/g,'?');
  const version=await certificateVersion(db,envelopeId);
  // Version 2 facts: fixed at creation (sender, named by, document name) or recorded before completion.
  const v2=version>=2?await (async()=>{
    const facts=await sendFacts(db,envelopeId);
    const doc=await db.prepare('SELECT document_name FROM envelope_documents WHERE envelope_id = ?').bind(envelopeId).first<{document_name:string}>();
    const created=await db.prepare('SELECT created_at FROM envelopes WHERE id = ?').bind(envelopeId).first<{created_at:number}>();
    const events=(evidence.audit?evidence.audit.sealed:await auditTrail(db,envelopeId)).filter(event=>SUMMARY_EVENTS.has(event.type));
    return {...facts,documentName:doc?.document_name??null,createdAt:created?.created_at??null,events};
  })():null;
  heading('Document');
  if(v2?.documentName)field('Name',ascii(v2.documentName));
  if(v2?.sender)field('Sent by',ascii(`${v2.sender.name}${v2.sender.email?` (${v2.sender.email})`:''}${v2.sender.organization?`, ${v2.sender.organization}`:''}`));
  field('Original SHA-256',evidence.source!.sha256);
  field('Signed SHA-256',evidence.finalSha256);
  heading('Signers');
  for(const row of evidence.signatures) {
    field(`Signer ${row.sequence}`,row.recipient_name);
    if(v2) {
      const own=(type:string)=>v2.events.find(event=>event.taskId===row.task_id&&event.type===type);
      const named=row.task_id?v2.namedBy.get(row.task_id):undefined;
      if(named)field('Named by',ascii(named));
      field('Identified by',ascii(identification(own(AUDIT.otpVerified)?.detail)));
      const signed=own(AUDIT.signed);
      const device=[signed?.ip?`IP ${signed.ip}`:'',signed?.userAgent?ascii(signed.userAgent).slice(0,160):''].filter(Boolean).join(' · ');
      if(device)field('IP / device',device);
    }
    field('Input SHA-256',row.input_sha256);
    field('Output SHA-256',row.sha256);
    field('Event SHA-256',row.event_hash);
  }
  if(v2) {
    // A plain-language summary of what happened, oldest first (CS-PRM-042's certificate).
    heading('Events summary (UTC)');
    const names=new Map(evidence.signatures.map(row=>[row.task_id,row.recipient_name]));
    const time=(at:number)=>new Date(at).toISOString().replace(/\.\d{3}Z$/,'Z');
    const opened=new Set<string>();
    // Pages each signer viewed: one line, at the event that brought the count to its total for them.
    const pagesSeen=new Map<string,Set<number>>(), lastViews=new Map<string,number>();
    for(const event of v2.events) if(event.type===AUDIT.pagesViewed&&event.taskId) {
      const seen=pagesSeen.get(event.taskId)??new Set<number>();
      for(const p of Array.isArray(event.detail?.pages)?event.detail.pages as unknown[]:[]) if(Number.isSafeInteger(p)) seen.add(p as number);
      pagesSeen.set(event.taskId,seen);lastViews.set(event.taskId,event.id);
    }
    if(v2.createdAt!==null)field(time(v2.createdAt),ascii(`Sent${v2.sender?` by ${v2.sender.name}`:''}`));
    for(const event of v2.events) {
      const who=event.taskId?names.get(event.taskId)??'':'';
      if(event.type===AUDIT.sessionOpened) {
        // The first time each signer opened it.
        if(!event.taskId||opened.has(event.taskId))continue;
        opened.add(event.taskId);field(time(event.occurredAt),ascii(`Opened by ${who}`));
      } else if(event.type===AUDIT.pagesViewed) {
        if(!event.taskId||lastViews.get(event.taskId)!==event.id)continue;
        const total=Number(event.detail?.total);
        field(time(event.occurredAt),ascii(`Viewed ${pagesSeen.get(event.taskId)?.size??0}${Number.isSafeInteger(total)?` of ${total}`:''} pages: ${who}`));
      } else if(event.type===AUDIT.otpVerified)field(time(event.occurredAt),ascii(`Identity confirmed: ${who}`));
      else if(event.type===AUDIT.signed)field(time(event.occurredAt),ascii(`Signed by ${who}${authorityFact(event.detail)?` ${authorityFact(event.detail)}`:''}`));
    }
  }
  heading('Events (UTC)');
  // Without a sealed audit trail (local test evidence), each signer's title and company go with
  // their events; SIGNED events never change, so a stored PDF stays reproducible.
  const signedEvents=evidence.audit?[]:(await auditTrail(db,envelopeId)).filter(event=>event.type===AUDIT_SIGNED);
  for(const row of evidence.signatures) {
    // Keep the complete name and both event timestamps together on one page.
    const authority=signerAuthority(signedEvents,row.task_id).replace(/[^\x20-\x7e]/g,'?');
    const eventHeight=Math.max(1,wrapLines(row.recipient_name,340).length)*15+3+2*18+(authority?wrapLines(authority,340).length*15+3:0);
    if(eventHeight>680) throw new Error('Signer event group too large');
    ensure(eventHeight);
    field(`Signer ${row.sequence}`,row.recipient_name,340);
    field('OTP verified',new Date(row.otp_verified_at).toISOString());
    field('Consent / signed',new Date(row.consented_at).toISOString());
    if(authority)field('Signed',authority,340);
  }
  if(evidence.audit) {
    heading('Audit trail (UTC)');
    const names=new Map(evidence.signatures.map(row=>[row.task_id,row.recipient_name]));
    // Only the sealed events: they are fixed, so this PDF, once stored and sent, can be reproduced exactly.
    // Events recorded after sealing (such as the copies sent) are on the certificate.
    for(const event of evidence.audit.sealed) {
      const who=event.taskId?names.get(event.taskId):undefined;
      const facts=[event.type.replace(/_/g,' ').toLowerCase()+(who?` · ${who}`:''),event.type===AUDIT_SIGNED?ascii(authorityFact(event.detail)):'',event.ip?`IP ${event.ip}`:'',event.userAgent?ascii(event.userAgent).slice(0,160):''].filter(Boolean);
      // Keep one event's rows together on a page.
      ensure(18*facts.length+18);
      facts.forEach((fact,i)=>field(i===0?new Date(event.occurredAt).toISOString().replace('.000Z','Z'):'',fact));
    }
  }
  y-=8;
  for(const note of described.notes) wrapped(note,50,512,10,font,muted);
  const bytes=await pdf.save({useObjectStreams:false});
  const sha256=await hash(bytes), objectKey=`envelopes/${envelopeId}/${described.name}.pdf`, metadataKey=`envelopes/${envelopeId}/${described.name}.json`;
  const metadata={format:described.format,envelopeId,finalSha256:evidence.finalSha256,sha256};
  const metaBytes=new TextEncoder().encode(JSON.stringify(metadata));
  async function putChecked(objectKey:string,data:Uint8Array,contentType:string) {
    const stored=await bucket.put(objectKey,data,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType}});
    if(!stored) {const existing=await bucket.get(objectKey);if(!existing || await hash(await existing.arrayBuffer())!==await hash(data)) throw new Error('Delivery conflict');}
  }
  await putChecked(objectKey,bytes,'application/pdf');
  await putChecked(metadataKey,metaBytes,'application/json');
  return {bytes,metadata};
}
