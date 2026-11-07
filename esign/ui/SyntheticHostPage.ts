import React,{useEffect,useState} from 'react';
const h=React.createElement;
type Envelope={id:string;status:string;tasks:{id:string;recipientName:string;status:string}[]};
async function request(path:string,init:RequestInit={}) {
 const response=await fetch(`/host/synthetic${path}`,{...init,headers:{'x-local-esign':'1',...init.headers}});
 if(!response.ok)throw new Error('Request failed; preserve the local instance and evidence for investigation.');
 return response;
}
export function SyntheticHostPage() {
 const [envelope,setEnvelope]=useState<Envelope|null>(null),[frame,setFrame]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[pdf,setPdf]=useState('');
 useEffect(()=>()=>{if(pdf)URL.revokeObjectURL(pdf);},[pdf]);
 async function run(fn:()=>Promise<void>) {if(busy)return;setBusy(true);try {setMessage('');await fn();}catch(error){setMessage(error instanceof Error?error.message:'Request failed.');}finally {setBusy(false);}}
 async function refresh(id:string){const value=await (await request(`/envelopes/${id}`)).json() as Envelope;if(value.id!==id)throw new Error('Envelope mismatch');setEnvelope(value);}
 async function create(){const value=await (await request('/create',{method:'POST'})).json() as {id:string};await refresh(value.id);}
 async function action(name:string){if(!envelope)return;const id=envelope.id;setFrame('');await request(`/envelopes/${id}/${name}`,{method:'POST'});await refresh(id);}
 async function view(task:string){if(!envelope)return;const value=await (await request(`/envelopes/${envelope.id}/tasks/${task}/recipient-view`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:window.location.origin})})).json() as {code:string};setFrame(`/#code=${encodeURIComponent(value.code)}&synthetic=1`);}
 async function seal(){if(!envelope)return;const id=envelope.id;const value=await (await request(`/envelopes/${id}/seal`,{method:'POST'})).json() as {envelopeId:string;workspace:string};if(value.envelopeId!==id)throw new Error('Envelope mismatch');setMessage(`KMS/TSA synthetic evidence created for ${id}. Independently verify the fingerprint and evidence workspace ${value.workspace}; revocation and TSA licensing are not checked.`);}
 async function delivery(){if(!envelope)return;const blob=await (await request(`/envelopes/${envelope.id}/delivery-pdf`)).blob();setPdf(URL.createObjectURL(blob));}
 return h('main',null,h('h1',null,'Server-generated synthetic envelope — real KMS/TSA test'),
  h('p',null,'Synthetic data only. This isolated test generates its own blank PDF and fictional signers; it cannot seal uploaded or existing envelopes. Not production, legal proof, real email, or WORM storage.'),
  h('p',null,'Explicit opt-in is required on the local service. KMS receives only the manifest digest; DigiCert receives only a signature imprint and nonce over HTTP. TSA licensing and certificate revocation are not checked.'),
  h('button',{type:'button',disabled:busy,onClick:()=>run(create)},'Create synthetic envelope'),h('p',{role:'status'},message),
  envelope && h('section',null,h('h2',null,'Envelope ',envelope.id),h('p',null,'Mock status: ',envelope.status,' (not real sealed status)'),
   h('button',{type:'button',disabled:busy,onClick:()=>run(()=>refresh(envelope.id))},'Refresh status'),
   h('ol',null,...envelope.tasks.map(task=>h('li',{key:task.id},`${task.recipientName}: ${task.status} `,h('button',{type:'button',disabled:busy,onClick:()=>run(()=>view(task.id))},'Open signing view')))),
   h('button',{type:'button',disabled:busy,onClick:()=>run(()=>action('process'))},'Process signature'),
   h('button',{type:'button',disabled:busy,onClick:()=>run(()=>action('finalize'))},'Finalize mock completion'),
   envelope.status==='COMPLETED' && h(React.Fragment,null,h('button',{type:'button',disabled:busy,onClick:()=>run(delivery)},'View frozen delivery PDF'),h('button',{type:'button',disabled:busy,onClick:()=>run(seal)},'Seal this synthetic envelope with KMS and TSA'))),
  frame && h('iframe',{title:'Synthetic recipient signing page',src:frame,width:'100%',height:'800',sandbox:'allow-scripts allow-same-origin allow-forms'}),
  pdf && h('iframe',{title:'Synthetic delivery PDF',src:pdf,width:'100%',height:'700'}));
}
