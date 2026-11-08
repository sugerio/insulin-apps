import React, {useEffect, useRef, useState} from 'react';
import {TemplateLaunch} from './TemplateLaunch.ts';
import {TemplateLibrary} from './TemplateLibrary.ts';
const h=React.createElement;
type Task={id:string;recipientName:string;recipientEmail:string;status:string;routingOrder:number};
type Envelope={id:string;templateId?:string;status:string;tasks:Task[]};
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
    :h('p',null,'Sending, reading, IP address and identity verification beyond the local test OTP are not recorded or established.'),
    h('a',{href:`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(c,null,2))}`,download:c.mode==='KMS_TSA'?'certificate.json':'local-test-certificate.json'},'Download certificate JSON'));
}
const headers={'x-local-esign':'1'};
async function request(path:string,init:RequestInit={}) {
  const response=await fetch(`/host${path}`,{...init,headers:{...headers,...init.headers}});
  if(!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response;
}
export function HostPage() {
  const [templateSelection,setTemplateSelection]=useState<{id:string;sequence:number}|undefined>();
  const [envelope,setEnvelope]=useState<Envelope|null>(null),[frame,setFrame]=useState(''),[pdf,setPdf]=useState(''),[message,setMessage]=useState(''),[certificate,setCertificate]=useState<Certificate|null>(null);
  const [pdfKind,setPdfKind]=useState('final-pdf');
  const certificateRequest=useRef(0);
  const selectedId=useRef(''), pdfRequest=useRef(0), viewRequest=useRef(0), createRequest=useRef(0), refreshRequest=useRef(0);
  async function refresh(id:string) {const requestId=++refreshRequest.current;const data=await (await request(`/envelopes/${id}`)).json() as Envelope;if(selectedId.current===id && refreshRequest.current===requestId) {setEnvelope(data);if(data.status!=='COMPLETED'){certificateRequest.current++;setCertificate(null);}}return data;}
  useEffect(()=>{const id=localStorage.getItem('esign-local-envelope');if(id) {selectedId.current=id;const sequence=createRequest.current;refresh(id).catch(()=>{if(selectedId.current===id && createRequest.current===sequence) setMessage('Could not restore envelope. Check local services, then refresh.');});} return ()=>{selectedId.current='';certificateRequest.current++;pdfRequest.current++;viewRequest.current++;createRequest.current++;refreshRequest.current++;};},[]);
  useEffect(()=>()=>{if(pdf) URL.revokeObjectURL(pdf);},[pdf]);
  async function run(fn:()=>Promise<void>, isCurrent?:()=>boolean) {const id=selectedId.current, sequence=createRequest.current;try {setMessage('');await fn();} catch(error) {if(isCurrent ? isCurrent() : selectedId.current===id && createRequest.current===sequence) setMessage(`Local request failed: ${error instanceof Error ? error.message : 'unknown error'}`);}}
  async function action(name:string) {if(!envelope)return;const id=envelope.id, sequence=createRequest.current;viewRequest.current++;setFrame('');await request(`/envelopes/${id}/${name}`,{method:'POST'});if(selectedId.current===id && createRequest.current===sequence){viewRequest.current++;setFrame('');await refresh(id);}}
  async function view(task:Task) {if(!envelope)return;const id=envelope.id, requestId=++viewRequest.current;setFrame('');const result=await (await request(`/envelopes/${id}/tasks/${task.id}/recipient-view`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:window.location.origin})})).json() as {code:string};if(selectedId.current!==id || viewRequest.current!==requestId)return;setFrame(`/#code=${encodeURIComponent(result.code)}`);}
  async function finalPdf(kind="final-pdf") {if(!envelope)return;const id=envelope.id, requestId=++pdfRequest.current;const blob=await (await request(`/envelopes/${id}/${kind}`)).blob();if(selectedId.current!==id || pdfRequest.current!==requestId)return;setPdfKind(kind);setPdf(URL.createObjectURL(blob));}
  async function viewCertificate() {if(!envelope || envelope.status!=='COMPLETED')return;const id=envelope.id, requestId=++certificateRequest.current;const data=await (await request(`/envelopes/${id}/certificate`)).json() as Certificate;if(selectedId.current!==id || certificateRequest.current!==requestId)return;setCertificate(data);}
  return h('main',null,h('h1',null,'Local e-sign test host'),h('p',null,'Synthetic data only. Local simulation, not production, legal evidence, or real email. Templates can use supported positioned Signature fields or the legacy appended signature page.'),
    h(TemplateLibrary,{request,onSelect:(id:string)=>setTemplateSelection(old=>({id,sequence:(old?.sequence??0)+1}))}),
    h('p',{role:'status'},message),
    h(TemplateLaunch,{request,selection:templateSelection,onBegin:()=>{const sequence=++createRequest.current;return ()=>sequence===createRequest.current;},onCreated:async(id:string)=>{const sequence=createRequest.current;selectedId.current=id;pdfRequest.current++;viewRequest.current++;certificateRequest.current++;refreshRequest.current++;setEnvelope({id,status:'PROCESSING',tasks:[]});localStorage.setItem('esign-local-envelope',id);setFrame('');setPdf('');setCertificate(null);await request(`/envelopes/${id}/prepare`,{method:'POST'});if(selectedId.current===id&&createRequest.current===sequence)await refresh(id);}}),
    envelope && h('section',null,h('h2',null,'Envelope ',envelope.id),h('p',null,'Status: ',envelope.status),h('p',null,'Template ID: ',envelope.templateId??'Checking…'),h('p',null,'Existing envelopes do not change when a template is edited. Compare this ID with the confirmed saved template ID; create a new envelope to use a new version.'),h('button',{onClick:()=>run(async()=>{await refresh(envelope.id);}),type:'button'},'Refresh status'),
      h('ol',null,...envelope.tasks.map(task=>h('li',{key:task.id},`${task.recipientName} (${task.recipientEmail}): ${task.status} `,h('button',{type:'button',onClick:()=>run(()=>view(task))},'Open signing view')))),
      h('button',{type:'button',onClick:()=>run(()=>action('prepare'))},'Retry prepare'),h('button',{type:'button',onClick:()=>run(()=>action('process'))},'Process signature'),h('button',{type:'button',onClick:()=>run(()=>action('finalize'))},'Finalize'),
      envelope.status==='COMPLETED' && h(React.Fragment,null,h('button',{type:'button',onClick:()=>run(finalPdf)},'View final PDF'),h('button',{type:'button',onClick:()=>run(()=>finalPdf('delivery-pdf'))},'View delivery PDF with certificate'),h('button',{type:'button',onClick:()=>run(viewCertificate)},'View completion certificate'))),
    h('p',null,'In the signing page, send a test code. Copy its message ID and retrieve it locally using the README mailbox command. After signing, click Process signature and refresh; repeat for each remaining signer, then finalize.'),
    frame && h('iframe',{title:'Recipient signing page',src:frame,width:'100%',height:'800',sandbox:'allow-scripts allow-same-origin allow-forms'}),
    certificate && envelope?.status==='COMPLETED' && h(CompletionCertificate,{certificate}),
    pdf && h('section',null,h('a',{href:pdf,download:pdfKind==='delivery-pdf'?'delivery-local-test.pdf':'signed-local-test.pdf'},pdfKind==='delivery-pdf'?'Download delivery PDF':'Download final PDF'),h('iframe',{title:'Final PDF',src:pdf,width:'100%',height:'700'})));
}
