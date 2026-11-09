// /demo: try the Worker end to end from one page, on the Worker's own origin. Paste a tenant
// management key, upload a synthetic PDF, add up to two signers, then sign each recipient view
// embedded here (/sign). The Worker processes and seals envelopes on its own. The key is kept
// only in this tab's sessionStorage; every request goes straight to this origin's API.
import React,{useEffect,useRef,useState} from 'react';
import {CompletionCertificate} from './HostPage.ts';
import {readSaveResult} from './editor-save-protocol.ts';
const h=React.createElement;

export const KEY_STORAGE='esign-demo-key';
export const RECENT_STORAGE='esign-demo-envelopes';
const ROLES=['signer-1','signer-2'];
const MAX_PDF_BYTES=5*1024*1024;
const POLL_MS=3000;

type Task={id:string;role:string;recipientName:string;recipientEmail:string;status:string;routingOrder:number};
type Envelope={id:string;templateId:string;status:string;tasks:Task[]};
type Signer={name:string;email:string};
type Certificate=Parameters<typeof CompletionCertificate>[0]['certificate'];
type Editor={sessionId:string;url:string;ready:boolean;requestId:string};

export class DemoRequestError extends Error {
  readonly status:number;readonly code:string;
  constructor(status:number,code:string){super(code?`${status} ${code}`:`HTTP ${status}`);this.status=status;this.code=code;}
}

/** Same-origin API calls with the tenant management key. */
export function demoClient(key:string){
  return async(path:string,init:RequestInit={})=>{
    const response=await fetch(path,{...init,cache:'no-store',headers:{...(init.headers as Record<string,string>|undefined),authorization:`Bearer ${key}`}});
    if(!response.ok){let code='';try{code=((await response.json()) as {error?:string}).error??'';}catch{/* not JSON */}throw new DemoRequestError(response.status,code);}
    return response;
  };
}

// Browser storage can be unavailable (private windows, blocked site data): never required.
const store=(kind:'session'|'local')=>{try{return kind==='session'?window.sessionStorage:window.localStorage;}catch{return null;}};
const load=(kind:'session'|'local',name:string)=>{try{return store(kind)?.getItem(name)??'';}catch{return '';}};
const save=(kind:'session'|'local',name:string,value:string|null)=>{try{if(value===null)store(kind)?.removeItem(name);else store(kind)?.setItem(name,value);}catch{/* best effort */}};
const recentIds=()=>{try{const v:unknown=JSON.parse(load('local',RECENT_STORAGE)||'[]');return Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x)).slice(0,10):[];}catch{return [];}};

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const describe=(error:unknown)=>error instanceof DemoRequestError?(error.status===401?'The key was not accepted.':`Request failed (${error.message}).`):(error instanceof Error?error.message:'Request failed.');

export function DemoPage(){
  const [keyInput,setKeyInput]=useState(''),[key,setKey]=useState(()=>load('session',KEY_STORAGE)),[tenant,setTenant]=useState('');
  const [file,setFile]=useState<File|null>(null),[mode,setMode]=useState<'page'|'fields'>('page'),[twoSigners,setTwoSigners]=useState(true);
  const [signers,setSigners]=useState<Signer[]>([{name:'',email:''},{name:'',email:''}]);
  const [editor,setEditor]=useState<Editor|null>(null),[templateId,setTemplateId]=useState('');
  const [envelope,setEnvelope]=useState<Envelope|null>(null),[recent,setRecent]=useState<string[]>(recentIds);
  const [frame,setFrame]=useState(''),[pdf,setPdf]=useState<{url:string;name:string}|null>(null),[certificate,setCertificate]=useState<Certificate|null>(null);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const attempt=useRef<{body:string;key:string}|null>(null),editorFrame=useRef<HTMLIFrameElement|null>(null);
  const call=demoClient(key);
  const roles=twoSigners?ROLES:ROLES.slice(0,1);

  async function run(work:()=>Promise<void>){setBusy(true);setMessage('');try{await work();}catch(error){setMessage(describe(error));}finally{setBusy(false);}}

  // A stored key is checked on load. Only the service rejecting it drops it: a check that is
  // interrupted (a reload, the network) keeps it for the next load.
  useEffect(()=>{if(!key||tenant)return;let live=true;
    call('/v1/me').then(r=>r.json() as Promise<{tenantId:string}>).then(me=>{if(live)setTenant(me.tenantId);}).catch(error=>{if(!live)return;
      if(error instanceof DemoRequestError&&error.status===401){save('session',KEY_STORAGE,null);setMessage('The saved key was not accepted. Paste it again.');}
      else setMessage('Could not reach the service. Reload the page to try again, or paste the key.');
      setKey('');});
    return()=>{live=false;};},[key]);
  useEffect(()=>()=>{if(pdf)URL.revokeObjectURL(pdf.url);},[pdf]);

  async function refresh(id:string){const data=await (await call(`/v1/envelopes/${id}`)).json() as Envelope;setEnvelope(data);return data;}
  // While an envelope is open and not completed, follow its status: the Worker advances it.
  useEffect(()=>{if(!envelope||envelope.status==='COMPLETED')return;const id=envelope.id;const timer=setInterval(()=>{refresh(id).catch(()=>{});},POLL_MS);return()=>clearInterval(timer);},[envelope?.id,envelope?.status,key]);

  function connect(){const value=keyInput.trim();if(!/^[A-Za-z0-9_-]{32,256}$/.test(value)){setMessage('Paste the tenant management key.');return;}
    void run(async()=>{const me=await (await demoClient(value)('/v1/me')).json() as {tenantId:string};save('session',KEY_STORAGE,value);setKeyInput('');setTenant(me.tenantId);setKey(value);});}
  function disconnect(){save('session',KEY_STORAGE,null);setKey('');setTenant('');setEnvelope(null);setFrame('');setEditor(null);setTemplateId('');}

  function pdfError(){if(!file)return 'Choose a PDF.';if(file.size>MAX_PDF_BYTES)return 'The PDF must be 5 MB or smaller.';return '';}
  function chooseFile(next:File|null){setFile(next);setTemplateId('');setEditor(null);attempt.current=null;}

  async function createTemplate():Promise<string>{
    const form=new FormData();form.set('file',file!);form.set('roles',JSON.stringify(roles));
    return ((await (await call('/v1/templates',{method:'POST',body:form})).json()) as {id:string}).id;
  }
  function openEditor(){const invalid=pdfError();if(invalid){setMessage(invalid);return;}
    void run(async()=>{
      const session=await (await call('/v1/template-editing-sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:window.location.origin,roles})})).json() as {sessionId:string;url:string};
      const url=new URL(session.url);
      if(url.origin!==window.location.origin||url.pathname!==`/editor/page/${session.sessionId}`)throw new Error('Unexpected editor address.');
      await call(`/v1/template-editing-sessions/${session.sessionId}/source`,{method:'POST',headers:{'content-type':'application/pdf'},body:file!});
      setTemplateId('');setEditor({sessionId:session.sessionId,url:url.href,ready:false,requestId:''});
    });}
  function saveFields(){if(!editor||!editor.ready||editor.requestId||!editorFrame.current?.contentWindow)return;
    const requestId=crypto.randomUUID();setEditor({...editor,requestId});setMessage('Saving the fields…');
    editorFrame.current.contentWindow.postMessage({type:'esign.editor.save',requestId},window.location.origin);}
  useEffect(()=>{if(!editor)return;
    const listen=(event:MessageEvent)=>{const source=editorFrame.current?.contentWindow;if(!source||event.source!==source||event.origin!==window.location.origin)return;
      if(event.data?.type==='esign.editor.ready'){setEditor(old=>old&&{...old,ready:true});return;}
      if(!editor.requestId)return;const result=readSaveResult(event,window.location.origin,source,editor.requestId);if(!result)return;
      if(result.type==='esign.editor.save-error'){setEditor(old=>old&&{...old,requestId:''});setMessage(result.message);return;}
      void run(async()=>{const saved=await (await call(`/v1/template-editing-sessions/${editor.sessionId}`)).json() as {templateId:string|null};
        if(saved.templateId!==result.templateId)throw new Error('The editor and the server disagree on the saved template; open the editor again.');
        setTemplateId(result.templateId);setEditor(null);setMessage('Fields saved. Send it for signature.');});};
    window.addEventListener('message',listen);return()=>window.removeEventListener('message',listen);},[editor,key]);

  function send(){const invalid=pdfError();if(invalid){setMessage(invalid);return;}
    if(mode==='fields'&&!templateId){setMessage('Place and save the signature fields first.');return;}
    const people=signers.slice(0,roles.length);
    if(people.some(s=>!s.name.trim()||!EMAIL.test(s.email.trim()))){setMessage('Enter a name and an email address for each signer.');return;}
    void run(async()=>{
      const template=mode==='fields'?templateId:await createTemplate();
      const body=JSON.stringify({templateId:template,recipients:people.map((s,i)=>({role:roles[i],name:s.name.trim(),email:s.email.trim()}))});
      // Retrying the same send reuses its idempotency key, so a lost response cannot send twice.
      if(!attempt.current||attempt.current.body!==body)attempt.current={body,key:crypto.randomUUID()};
      const {id}=await (await call('/v1/envelopes',{method:'POST',headers:{'content-type':'application/json','idempotency-key':attempt.current.key},body})).json() as {id:string};
      attempt.current=null;const next=[id,...recent.filter(x=>x!==id)].slice(0,10);setRecent(next);save('local',RECENT_STORAGE,JSON.stringify(next));
      setFrame('');setPdf(null);setCertificate(null);await refresh(id);setMessage('Sent. Open each signer\'s page below.');
    });}
  function open(id:string){void run(async()=>{setFrame('');setPdf(null);setCertificate(null);await refresh(id);});}
  function sign(task:Task){if(!envelope)return;void run(async()=>{
    const {code}=await (await call(`/v1/envelopes/${envelope.id}/tasks/${task.id}/recipient-view`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:window.location.origin})})).json() as {code:string};
    setFrame(`/sign#code=${encodeURIComponent(code)}`);});}
  function download(){if(!envelope)return;void run(async()=>{const blob=await (await call(`/v1/envelopes/${envelope.id}/delivery-pdf`)).blob();setPdf({url:URL.createObjectURL(blob),name:'signed-with-certificate.pdf'});});}
  function showCertificate(){if(!envelope)return;void run(async()=>{setCertificate(await (await call(`/v1/envelopes/${envelope.id}/certificate`)).json() as Certificate);});}

  const field=(label:string,input:React.ReactElement)=>h('label',{style:{display:'block',margin:'0.4rem 0'}},label,' ',input);
  if(!key||!tenant)return h('main',{style:{maxWidth:720,margin:'2rem auto',fontFamily:'sans-serif'}},
    h('h1',null,'E-sign demo'),h('p',null,'Synthetic test documents only. Not a production signature service.'),
    field('Tenant management key',h('input',{type:'password','aria-label':'Tenant management key',value:keyInput,autoComplete:'off',onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setKeyInput(e.target.value)})),
    h('button',{type:'button',disabled:busy||!!key,onClick:connect},key?'Checking the key…':'Connect'),
    h('p',null,'The key stays in this browser tab only and is sent only to this site.'),
    h('p',{role:'status'},message));

  const counted=signers.slice(0,roles.length);
  return h('main',{style:{maxWidth:960,margin:'2rem auto',fontFamily:'sans-serif'}},
    h('h1',null,'E-sign demo'),
    h('p',null,'Tenant ',h('strong',null,tenant),' ',h('button',{type:'button',onClick:disconnect},'Disconnect')),
    h('p',null,'Synthetic test documents only. Verification codes are emailed to this environment\'s test mailbox, not to the signers.'),
    h('section',{'aria-label':'New document'},h('h2',null,'1. Document and signers'),
      field('PDF',h('input',{type:'file',accept:'application/pdf','aria-label':'PDF',disabled:busy,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>chooseFile(e.target.files?.[0]??null)})),
      h('fieldset',null,h('legend',null,'Where signatures go'),
        h('label',{style:{display:'block'}},h('input',{type:'radio',name:'mode',checked:mode==='page',onChange:()=>{setMode('page');setEditor(null);setTemplateId('');}}),' On a signature page added after the last page'),
        h('label',{style:{display:'block'}},h('input',{type:'radio',name:'mode',checked:mode==='fields',onChange:()=>setMode('fields')}),' In signature fields I place on the document')),
      h('label',{style:{display:'block',margin:'0.4rem 0'}},h('input',{type:'checkbox',checked:twoSigners,disabled:!!editor||!!templateId,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{setTwoSigners(e.target.checked);attempt.current=null;}}),' Two signers, in order'),
      ...counted.map((s,i)=>h('fieldset',{key:i},h('legend',null,`Signer ${i+1}`),
        field('Name',h('input',{'aria-label':`Signer ${i+1} name`,value:s.name,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,name:e.target.value}:x))})),
        field('Email',h('input',{type:'email','aria-label':`Signer ${i+1} email`,value:s.email,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,email:e.target.value}:x))})))),
      mode==='fields'&&!templateId&&h('button',{type:'button',disabled:busy,onClick:openEditor},editor?'Restart the editor':'Place signature fields'),
      mode==='fields'&&templateId&&h('p',null,'Signature fields saved.'),
      h('button',{type:'button',disabled:busy||(mode==='fields'&&!templateId),onClick:send},'Send for signature'),
      editor&&h('section',{'aria-label':'Signature field editor'},
        h('p',null,`Give each signer at least one Signature field (roles: ${roles.join(', ')}), then save. A new field starts in the top corner: move it (drag, or arrow keys) so that fields do not overlap.`),
        h('button',{type:'button',disabled:!editor.ready||!!editor.requestId,onClick:saveFields},editor.requestId?'Saving…':'Save fields'),
        h('iframe',{ref:editorFrame,title:'Signature field editor',src:editor.url,width:'100%',height:'760'}))),
    h('p',{role:'status'},message),
    recent.length>0&&h('section',{'aria-label':'Recent envelopes'},h('h2',null,'Recent envelopes'),
      h('ul',null,...recent.map(id=>h('li',{key:id},h('button',{type:'button',disabled:busy,onClick:()=>open(id)},id))))),
    envelope&&h('section',{'aria-label':'Envelope'},h('h2',null,'2. Sign'),
      h('p',null,'Envelope ',envelope.id,': ',h('strong',null,envelope.status)),
      h('ol',null,...envelope.tasks.map(task=>h('li',{key:task.id},`${task.recipientName} <${task.recipientEmail}>: ${task.status} `,
        task.status==='ACTIVE'&&h('button',{type:'button',disabled:busy,onClick:()=>sign(task)},`Open ${task.recipientName}'s signing page`)))),
      envelope.status==='COMPLETED'&&h('p',null,
        h('button',{type:'button',disabled:busy,onClick:download},'View signed PDF with certificate'),' ',
        h('button',{type:'button',disabled:busy,onClick:showCertificate},'View completion certificate')),
      frame&&h('div',null,h('button',{type:'button',onClick:()=>setFrame('')},'Close the signing page'),
        h('iframe',{title:'Recipient signing page',src:frame,width:'100%',height:'800',sandbox:'allow-scripts allow-same-origin allow-forms'}))),
    pdf&&h('section',null,h('a',{href:pdf.url,download:pdf.name},`Download ${pdf.name}`),h('iframe',{title:'Signed PDF',src:pdf.url,width:'100%',height:'760'})),
    certificate&&envelope?.status==='COMPLETED'&&h(CompletionCertificate,{certificate}));
}
