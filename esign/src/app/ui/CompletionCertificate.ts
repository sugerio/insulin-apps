import React from 'react';
/**
 * The completion certificate as the demo page shows it (DemoPage.ts), from
 * `GET /api/envelopes/:id/certificate`: the seal, the envelope and document, each signer's recorded
 * events and the audit trail.
 */
const h=React.createElement;
type Certificate={
  mode:string;
  /** Present for envelopes completed with the managed seal (mode KMS_TSA). */
  seal?:{keyArn:string;publicKeySha256:string;timestampTime:number;tsaUrl:string};
  /** Who did what, when and from where; `sealed` events are covered by the seal. */
  audit?:{sealed:AuditEntry[];afterSeal:AuditEntry[]};
  envelope:{id:string;template_id:string;created_at:number;status:string};
  source:{id:string;sha256:string}; finalArtifactId:string; finalSha256:string;
  recipients:{id:string;role:string;recipient_name:string;recipient_email:string;routing_order:number;status:string}[];
  signatures:{id:string;sequence:number;task_id:string;recipient_name:string;input_artifact_id:string;input_sha256:string;otp_verified_at:number;consented_at:number;previous_hash:string;event_hash:string;artifact_id:string;sha256:string}[];
};
type AuditEntry={id:number;taskId:string|null;type:string;occurredAt:number;ip:string|null;userAgent:string|null};
const AUDIT_LABELS:Record<string,string>={RECIPIENT_VIEW_ISSUED:'Signing link issued',SIGNING_SESSION_OPENED:'Signing page opened',OTP_SENT:'Verification code sent',OTP_VERIFIED:'OTP verified',DOCUMENT_VIEWED:'Document viewed',PAGES_VIEWED:'Pages viewed',SIGNED:'Signed',COMPLETED:'Completed and sealed',COPY_SENT:'Signed copy sent'};
const utc=(value:number)=>Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : 'Not recorded';
export function CompletionCertificate({certificate:c}:{certificate:Certificate}) {
  const field=(label:string,value:string|number)=>h('div',{key:label},h('dt',{style:{fontWeight:'bold'}},label),h('dd',{style:{margin:'0 0 0.75em',overflowWrap:'anywhere'}},value));
  return h('section',{'aria-label':'Certificate of completion',style:{border:'2px solid #333',padding:'1.5rem',margin:'1.5rem 0',overflowWrap:'anywhere'}},
    h('h2',null,'Certificate of completion'),
    ...(c.mode==='KMS_TSA'&&c.seal?[
      h('h3',null,'Sealed: AWS KMS signature + RFC 3161 timestamp'),
      h('p',null,'The evidence below (source, signing events and signed PDF hashes) is signed with an AWS KMS key (ECDSA P-256), and that signature is timestamped by an RFC 3161 time-stamping authority. Revocation of the time-stamping authority certificates is not checked. This certificate is a separate view, not the signed PDF.'),
      h('p',null,'The source, signature records, event links and output hashes are checked against the sealed manifest and stored files. Envelope metadata (including template and creation time) and recipient task details (including email, role and status) are current database values and are not bound by the seal.'),
      h('h3',null,'Seal'),h('dl',null,field('Signing key (AWS KMS)',c.seal.keyArn),field('Key fingerprint (SHA-256 of the public key)',c.seal.publicKeySha256),field('Timestamp (RFC 3161, UTC)',utc(c.seal.timestampTime)),field('Time-stamping authority',c.seal.tsaUrl)),
    ]:[
      h('h3',null,'LOCAL TEST ONLY'),
      h('p',null,'Local simulation only, not a legal guarantee. The local HMAC uses a software key, not a real KMS or TSA. Times are server-recorded, not independently timestamped. This certificate is a separate view, not the signed PDF.'),
      h('p',null,'The source, signature records, event links and output hashes are checked against the local HMAC manifest and stored files. Envelope metadata (including template and creation time) and recipient task details (including email, role and status) are current database values and are not sealed by the manifest. The signer name in each signing record is manifest-bound.')
    ]),
    h('h3',null,'Envelope and document'),h('dl',null,
      field('Envelope ID',c.envelope.id),field('Status',c.envelope.status),field('Template ID (unsealed)',c.envelope.template_id),field('Envelope created, server time (unsealed)',utc(c.envelope.created_at)),
      field('Original filename','Not recorded'),field('Source artifact ID',c.source.id),field('Source SHA-256',c.source.sha256),field('Final artifact ID',c.finalArtifactId),field('Final artifact SHA-256',c.finalSha256)),
    h('h3',null,'Signers and recorded events'),
    ...c.signatures.map(signature=>{const recipient=c.recipients.find(r=>r.id===signature.task_id);return h('section',{key:signature.id},
      h('h4',null,`Signer ${signature.sequence}: `,signature.recipient_name),h('dl',null,
        field('Signing record ID',signature.id),field('Task ID',signature.task_id),
        ...(recipient?[field('Current task name (unsealed)',recipient.recipient_name),field('Test email (unsealed)',recipient.recipient_email),field('Role (unsealed)',recipient.role),field('Routing order (unsealed)',recipient.routing_order),field('Task status (unsealed)',recipient.status)]:[]),
        field('OTP verification recorded, server time',utc(signature.otp_verified_at)),field('Consent and signature accepted, server time',utc(signature.consented_at)),
        field('Signing input artifact ID',signature.input_artifact_id),field('Signing input SHA-256',signature.input_sha256),field('Output artifact ID',signature.artifact_id),field('Output SHA-256',signature.sha256),
        field('Previous event SHA-256',signature.previous_hash || 'None (first event)'),field('Signing event SHA-256',signature.event_hash)));}),
    c.audit?h('section',{'aria-label':'Audit trail'},h('h3',null,'Audit trail'),
      h('table',{style:{borderCollapse:'collapse',width:'100%',fontSize:'0.85rem'}},
        h('thead',null,h('tr',null,...['Time (UTC)','Event','Signer','IP address','Browser',''].map(t=>h('th',{key:t,style:{textAlign:'left',borderBottom:'1px solid #999',padding:'0.25rem'}},t)))),
        h('tbody',null,...[...c.audit.sealed.map(e=>[e,true] as const),...c.audit.afterSeal.map(e=>[e,false] as const)].map(([e,sealed])=>h('tr',{key:e.id},
          ...[utc(e.occurredAt),AUDIT_LABELS[e.type]??e.type,c.recipients.find(r=>r.id===e.taskId)?.recipient_name??'',e.ip??'',e.userAgent??'',sealed||c.mode!=='KMS_TSA'?'':'recorded after sealing'].map((v,i)=>h('td',{key:i,style:{padding:'0.25rem',verticalAlign:'top',overflowWrap:'anywhere'}},v)))))))
    :h('p',null,'Sending, reading, IP address and identity verification beyond the emailed code are not recorded or established.'),
    h('a',{href:`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(c,null,2))}`,download:c.mode==='KMS_TSA'?'certificate.json':'local-test-certificate.json'},'Download certificate JSON'));
}
