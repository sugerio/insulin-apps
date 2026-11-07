import React,{useEffect,useRef,useState} from 'react';
const h=React.createElement;
type Envelope={id:string;status:string;sealStatus:'NOT_SEALED'|'IN_PROGRESS'|'SEALED_LOCAL_TEST'|'INVESTIGATE';workspace?:string;tasks:{id:string;recipientName:string;status:string}[]};
async function request(path:string,init:RequestInit={}) {
 const response=await fetch(`/host/upload${path}`,{...init,headers:{'x-local-esign':'1',...init.headers}});
 if(!response.ok)throw new Error('Request failed. Preserve the instance and evidence; investigate before retrying.');
 return response;
}
export function UploadedHostPage() {
 const [file,setFile]=useState<File|null>(null),[optIn,setOptIn]=useState(false),[envelope,setEnvelope]=useState<Envelope|null>(null),[frame,setFrame]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[pdf,setPdf]=useState('');
 const pdfUrl=useRef(''),pdfGeneration=useRef(0),selectedEnvelope=useRef(''),busyRef=useRef(false);
 function clearPdf(){pdfGeneration.current++;if(pdfUrl.current)URL.revokeObjectURL(pdfUrl.current);pdfUrl.current='';setPdf('');}
 useEffect(()=>()=>{pdfGeneration.current++;if(pdfUrl.current)URL.revokeObjectURL(pdfUrl.current);pdfUrl.current='';},[]);
 async function run(fn:()=>Promise<void>) {if(busyRef.current)return;busyRef.current=true;setBusy(true);try{setMessage('');await fn();}catch(error){setMessage(error instanceof Error?error.message:'Request failed');}finally{busyRef.current=false;setBusy(false);}}
 const lockKey=(id:string)=>`esign-upload-completion-uncertain:${id}`;
 function clearClientLock(id:string) {window.localStorage.removeItem(lockKey(id));if(window.localStorage.getItem(lockKey(id))!==null)throw new Error('Uncertain completion');}
 function lockClient(id:string) {try {window.localStorage.setItem(lockKey(id),'1');} catch {} setEnvelope(current=>current?.id===id?{...current,sealStatus:'INVESTIGATE'}:current);}
 async function refresh(id:string){
  try {
   const value=await (await request(`/envelopes/${id}`)).json() as Envelope;
   if(value.id!==id || !['NOT_SEALED','IN_PROGRESS','SEALED_LOCAL_TEST','INVESTIGATE'].includes(value.sealStatus) || !Array.isArray(value.tasks))throw new Error('Invalid status');
   if(window.localStorage.getItem(lockKey(id)) || value.sealStatus==='INVESTIGATE') {lockClient(id);value.sealStatus='INVESTIGATE';}
   selectedEnvelope.current=value.id;setEnvelope(value);
  } catch {lockClient(id);throw new Error('Status could not be verified. Preserve evidence and investigate; do not retry or re-sign.');}
 }
 async function create(resume=false){if(!resume && !file)throw new Error('Choose a PDF.');clearPdf();const previous=selectedEnvelope.current;selectedEnvelope.current='';try {const value=await (await request(resume?'/resume':'/create',resume?{method:'POST'}:{method:'POST',headers:{'content-type':'application/pdf'},body:file})).json() as {id:string};setFrame('');setOptIn(false);await refresh(value.id);} catch(error) {selectedEnvelope.current=previous;throw error;}}
 async function action(name:string){if(!envelope || envelope.sealStatus!=='NOT_SEALED')return;const id=envelope.id;setFrame('');await request(`/envelopes/${id}/${name}`,{method:'POST'});await refresh(id);}
 async function view(task:string){if(!envelope || envelope.sealStatus!=='NOT_SEALED')return;const value=await (await request(`/envelopes/${envelope.id}/tasks/${task}/recipient-view`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:window.location.origin})})).json() as {code:string};setFrame(`/#code=${encodeURIComponent(value.code)}&upload=${encodeURIComponent(envelope.id)}`);}
 async function seal(){
  if(!envelope || !optIn || envelope.sealStatus==='INVESTIGATE' || envelope.sealStatus==='IN_PROGRESS')return;const id=envelope.id;setFrame('');
  try {window.localStorage.setItem(lockKey(id),'1');if(window.localStorage.getItem(lockKey(id))!=='1')throw new Error('Storage unavailable');}
  catch {lockClient(id);throw new Error('Cannot persist completion state. Preserve evidence and investigate; do not retry.');}
  try {
   const response=await fetch(`/host/upload/envelopes/${id}/complete`,{method:'POST',headers:{'x-local-esign':'1','content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})});
   if(!response.ok) {
    const failure=await response.json() as {sealStatus?:unknown;retryable?:unknown};
    if(response.status===409 && failure?.sealStatus==='NOT_READY' && failure.retryable===true) {
     clearClientLock(id);throw new Error('NOT_READY');
    }
    throw new Error('Uncertain completion');
   }
   const value=await response.json() as {envelopeId:string;workspace:string;sealStatus:string};
   if(value.envelopeId!==id || value.sealStatus!=='SEALED_LOCAL_TEST' || typeof value.workspace!=='string')throw new Error('Uncertain completion');
   const status=await (await request(`/envelopes/${id}`)).json() as Envelope;
   if(status.id!==id || status.sealStatus!=='SEALED_LOCAL_TEST' || !Array.isArray(status.tasks))throw new Error('Uncertain completion');
   clearClientLock(id);setEnvelope(status);
   setMessage(`Real KMS/TSA local test evidence for ${id} is in ${value.workspace}. Independently verify it; this cannot prove the PDF is synthetic.`);
  } catch(error) {
   if(error instanceof Error && error.message==='NOT_READY')throw new Error('Not ready: complete signing and process all signatures before trying again.');
   lockClient(id);throw new Error('Completion could not be verified. Preserve evidence and investigate; do not retry or re-sign.');
  }
 }
 async function delivery(){if(!envelope || selectedEnvelope.current!==envelope.id)return;const id=envelope.id;clearPdf();const generation=pdfGeneration.current;const blob=await (await request(`/envelopes/${id}/existing-delivery-pdf`)).blob();if(generation!==pdfGeneration.current || selectedEnvelope.current!==id)return;const url=URL.createObjectURL(blob);if(pdfUrl.current)URL.revokeObjectURL(pdfUrl.current);pdfUrl.current=url;setPdf(url);}
 return h('main',null,h('h1',null,'Uploaded PDF — local KMS/TSA test'),
  h('p',null,'Synthetic test PDFs only; the service cannot prove a file is synthetic. Not production, legal evidence, real email, or WORM storage. Fixed fictional signers are used.'),
  h('p',null,'Real remote disclosure: AWS KMS receives a SHA-256 digest of the file and signing evidence manifest. DigiCert receives a signature digest and nonce over unencrypted HTTP. The PDF and names or email addresses are not sent in plaintext. TSA licensing and certificate revocation are not verified.'),
  h('label',null,h('input',{type:'checkbox',checked:optIn,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setOptIn(event.target.checked)}),' I authorize disclosure of these test evidence digests to AWS KMS and DigiCert TSA.'),
  h('label',null,'PDF (maximum 1 MiB, at most 100 pages) ',h('input',{type:'file',accept:'application/pdf',disabled:busy,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setFile(event.target.files?.[0] ?? null)})),
  h('button',{type:'button',disabled:busy||!file,onClick:()=>run(()=>create())},'Upload and create test envelope'),
  h('button',{type:'button',disabled:busy,onClick:()=>run(()=>create(true))},'Resume configured instance'),h('p',{role:'status'},message),
  envelope && h('section',null,h('h2',null,'Envelope ',envelope.id),h('p',null,'Signing status: ',envelope.status,' (COMPLETED is mock only; not production completion)'),h('p',null,'Real KMS/TSA local test status: ',envelope.sealStatus),
   h('button',{type:'button',disabled:busy,onClick:()=>run(()=>refresh(envelope.id))},'Refresh status'),
   h('ol',null,...envelope.tasks.map(task=>h('li',{key:task.id},`${task.recipientName}: ${task.status} `,h('button',{type:'button',disabled:busy||envelope.sealStatus!=='NOT_SEALED',onClick:()=>run(()=>view(task.id))},'Open signing view')))),
   h('button',{type:'button',disabled:busy||envelope.sealStatus!=='NOT_SEALED',onClick:()=>run(()=>action('process'))},'Process signature'),
   h('button',{type:'button',disabled:busy||!optIn||envelope.sealStatus==='INVESTIGATE'||envelope.sealStatus==='IN_PROGRESS',onClick:()=>run(seal)},'Complete local KMS/TSA test'),
   h('p',null,'Existing final delivery PDF is a test file. Real sealing is incomplete or unknown; viewing it does not independently prove a seal.'),
   h('button',{type:'button',disabled:busy||envelope.sealStatus==='IN_PROGRESS',onClick:()=>run(delivery)},'View existing test delivery PDF')),
  frame && envelope?.sealStatus==='NOT_SEALED' && h('iframe',{title:'Uploaded test recipient signing page',src:frame,width:'100%',height:'800',sandbox:'allow-scripts allow-same-origin allow-forms'}),
  pdf && h('section',null,h('a',{href:pdf,download:'delivery-local-test.pdf'},'Download test delivery PDF'),h('iframe',{title:'Uploaded test delivery PDF',src:pdf,width:'100%',height:'700'}))); 
}
