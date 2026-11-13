import React from 'react';
/**
 * The completion certificate as the envelope page shows it (member/EnvelopePage.ts), from
 * `GET /api/envelopes/:id/certificate`: the seal, the envelope and document, each signer's recorded
 * events and the audit trail.
 */
const h=React.createElement;
type Certificate={
  mode:string;
  /** Present for envelopes completed with the managed seal (mode KEY_TSA). */
  seal?:{keyId:string;timestampTime:number;tsaUrl:string};
  /** Each signer as their sealed signing record says: the email the code was sent to, the role, the consent text. */
  identities?:{signatureId:string;email:string;role:string;disclosure?:{version:string;sha256:string};authority?:{title?:string;onBehalfOf?:string}}[];
  /** Who did what, when and from where; `sealed` events are covered by the seal. */
  audit?:{sealed:AuditEntry[];afterSeal:AuditEntry[]};
  envelope:{id:string;template_id:string;created_at:number;status:string};
  source:{id:string;sha256:string}; finalArtifactId:string; finalSha256:string;
  recipients:{id:string;role:string;recipient_name:string;recipient_email:string;routing_order:number;status:string}[];
  signatures:{id:string;sequence:number;task_id:string;recipient_name:string;input_artifact_id:string;input_sha256:string;otp_verified_at:number;consented_at:number;previous_hash:string;event_hash:string;artifact_id:string;sha256:string}[];
};
type AuditEntry={id:number;taskId:string|null;type:string;occurredAt:number;ip:string|null;userAgent:string|null};
export const AUDIT_LABELS:Record<string,string>={RECIPIENT_VIEW_ISSUED:'Signing link issued (by the sender)',SIGNING_SESSION_OPENED:'Signing page opened',OTP_SENT:'Verification code sent',OTP_VERIFIED:'OTP verified',DOCUMENT_VIEWED:'Document viewed',PAGES_VIEWED:'Pages viewed',SIGNED:'Signed',COMPLETED:'Sealed and completed',COPY_SENT:'Signed copy sent',COPY_DOWNLOADED:'Signed copy downloaded',DECLINED:'Declined',VOIDED:'Voided',EXPIRED:'Deadline passed'};
const utc=(value:number)=>Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : 'Not recorded';
export function CompletionCertificate({certificate:c}:{certificate:Certificate}) {
  const field=(label:string,value:string|number)=>h('div',{key:label,className:'flex flex-col gap-0.5'},h('dt',{className:'text-xs font-medium text-muted-foreground'},label),h('dd',{className:'text-sm break-all'},value));
  return h('section',{'aria-label':'Certificate of completion',className:'flex flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm break-words [&_dl]:grid [&_dl]:gap-3 sm:[&_dl]:grid-cols-2 [&_h3]:pt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm [&_h4]:font-medium [&>p]:text-sm [&>p]:text-muted-foreground'},
    h('h2',{className:'text-lg font-semibold'},'Certificate of completion'),
    ...(c.mode==='KEY_TSA'&&c.seal?[
      h('h3',null,'Sealed: Esign seal key signature + RFC 3161 timestamp'),
      h('p',null,'The evidence below (source, signing events and signed PDF hashes) is signed with Esign\'s seal key (ECDSA P-256), and that signature is timestamped by an RFC 3161 time-stamping authority. Revocation of the time-stamping authority certificates is not checked. This certificate is a separate view, not the signed PDF.'),
      h('p',null,'The source, signature records, event links and output hashes are checked against the sealed manifest and stored files. Each signer\'s name, email address, role and consent text are part of their sealed signing record. Envelope metadata (including template and creation time) and each task\'s current routing order and status are database values and are not bound by the seal.'),
      h('h3',null,'Seal'),h('dl',null,field('Seal key fingerprint (SHA-256 of the public key)',c.seal.keyId),field('Timestamp (RFC 3161, UTC)',utc(c.seal.timestampTime)),field('Time-stamping authority',c.seal.tsaUrl)),
    ]:[
      h('h3',null,'LOCAL TEST ONLY'),
      h('p',null,'Local simulation only, not a legal guarantee. The local HMAC uses a test key, not Esign\'s seal key or a real TSA. Times are server-recorded, not independently timestamped. This certificate is a separate view, not the signed PDF.'),
      h('p',null,'The source, signature records, event links and output hashes are checked against the local HMAC manifest and stored files. Envelope metadata (including template and creation time) and each task\'s current routing order and status are current database values and are not sealed by the manifest. Each signer\'s name, email address, role and consent text are bound with their signing record.')
    ]),
    h('h3',null,'Envelope and document'),h('dl',null,
      field('Envelope ID',c.envelope.id),field('Status',c.envelope.status),field('Template ID (unsealed)',c.envelope.template_id),field('Envelope created, server time (unsealed)',utc(c.envelope.created_at)),
      field('Source artifact ID',c.source.id),field('Source SHA-256',c.source.sha256),field('Final artifact ID',c.finalArtifactId),field('Final artifact SHA-256',c.finalSha256)),
    h('h3',null,'Signers and recorded events'),
    ...c.signatures.map(signature=>{const recipient=c.recipients.find(r=>r.id===signature.task_id), identity=c.identities?.find(i=>i.signatureId===signature.id), signedAs=[identity?.authority?.title,identity?.authority?.onBehalfOf].filter(Boolean).join(', ');return h('section',{key:signature.id,className:'flex flex-col gap-3 rounded-lg border p-4'},
      h('h4',null,`Signer ${signature.sequence}: `,signature.recipient_name),h('dl',null,
        field('Signing record ID',signature.id),field('Task ID',signature.task_id),
        ...(identity?[field('Email, where the code was sent (sealed)',identity.email),field('Role (sealed)',identity.role),
          ...(identity.disclosure?[field('Consent text agreed to (sealed)',`Version ${identity.disclosure.version}, SHA-256 ${identity.disclosure.sha256}`)]:[]),
          ...(signedAs?[field('Signed as (sealed)',signedAs)]:[])]:[]),
        ...(recipient?[field('Current task name (unsealed)',recipient.recipient_name),
          ...(identity?[]:[field('Current email (unsealed)',recipient.recipient_email),field('Current role (unsealed)',recipient.role)]),
          field('Routing order (unsealed)',recipient.routing_order),field('Task status (unsealed)',recipient.status)]:[]),
        field('OTP verification recorded, server time',utc(signature.otp_verified_at)),field('Consent and signature accepted, server time',utc(signature.consented_at)),
        field('Signing input artifact ID',signature.input_artifact_id),field('Signing input SHA-256',signature.input_sha256),field('Output artifact ID',signature.artifact_id),field('Output SHA-256',signature.sha256),
        field('Previous event SHA-256',signature.previous_hash || 'None (first event)'),field('Signing event SHA-256',signature.event_hash)));}),
    c.audit?h('section',{'aria-label':'Audit trail',className:'flex flex-col gap-2'},h('h3',null,'Audit trail'),
      h('div',{className:'overflow-x-auto'},h('table',{className:'w-full text-xs'},
        h('thead',null,h('tr',{className:'border-b'},...['Time (UTC)','Event','Signer','IP address','Browser',''].map(t=>h('th',{key:t,className:'p-2 text-left font-medium'},t)))),
        h('tbody',null,...[...c.audit.sealed.map(e=>[e,true] as const),...c.audit.afterSeal.map(e=>[e,false] as const)].map(([e,sealed])=>h('tr',{key:e.id,className:'border-b last:border-0'},
          ...[utc(e.occurredAt),AUDIT_LABELS[e.type]??e.type,c.recipients.find(r=>r.id===e.taskId)?.recipient_name??'',e.ip??'',e.userAgent??'',sealed||c.mode!=='KEY_TSA'?'':e.type==='COMPLETED'?'records the seal':'recorded after sealing'].map((v,i)=>h('td',{key:i,className:'p-2 align-top break-all'},v))))))),
      h('p',{className:'text-xs text-muted-foreground'},'For a signing link issued, the signer is who the link is for; the IP address and browser are those of whoever issued it (a member, or the host product\'s server), not the signer\'s.'))
    :h('p',null,'Sending, reading, IP address and identity verification beyond the emailed code are not recorded or established.'),
    h('a',{className:'w-fit text-sm font-medium underline underline-offset-4',href:`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(c,null,2))}`,download:c.mode==='KEY_TSA'?'certificate.json':'local-test-certificate.json'},'Download certificate JSON'));
}
