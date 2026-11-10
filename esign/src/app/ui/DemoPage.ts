// The app's home page for an organization's members: try E-sign end to end from one page. Upload a
// synthetic PDF, add up to two signers, then sign each recipient view embedded here (/sign). The
// signing request processes and seals each envelope. Every request goes to this origin's API as the
// signed-in member (the platform identity), so what it shows is the organization's.
import React,{useEffect,useRef,useState} from 'react';
import {CompletionCertificate} from './CompletionCertificate.ts';
import {readSaveResult} from './editor-save-protocol.ts';
import {readSigningHostMessage} from './signing-host-protocol.ts';
const h=React.createElement;

export const RECENT_STORAGE='esign-demo-envelopes';
const ROLES=['signer-1','signer-2'];
const MAX_PDF_BYTES=5*1024*1024;
const POLL_MS=3000;

type Task={id:string;role:string;recipientName:string;recipientEmail:string;status:string;routingOrder:number};
type Envelope={id:string;templateId:string;status:string;tasks:Task[]};
/** A signer, with the facts a host gives about them: their title, the company they sign for, what follows their signature. */
type Signer={name:string;email:string;title:string;company:string;after:string};
/** What a host says about the document and who sent it (synthetic examples, editable). */
type DocumentFacts={name:string;version:string;published:string;senderName:string;senderCompany:string};
const SAMPLE_DOCUMENT:DocumentFacts={name:'Mutual Non-Disclosure Agreement',version:'v1',published:'',senderName:'Sam Seller',senderCompany:'Example Seller Inc.'};
/** How the host says the signer signed in before it opened their page; recorded as the host's statement. */
const SIGN_IN_OPTIONS:[string,string,{method:string;provider?:string}|null][]=[
  ['none','None',null],
  ['google','Google Workspace',{method:'SSO',provider:'Google Workspace'}],
  ['microsoft','Microsoft',{method:'SSO',provider:'Microsoft'}],
  ['sso','Enterprise SSO',{method:'ENTERPRISE_SSO',provider:'Enterprise SSO'}],
  ['password','Password',{method:'PASSWORD',provider:'Email and password'}],
];
/** The envelope a send creates: the document facts and each signer's, leaving out what is empty. */
export function envelopeRequest(templateId:string,roles:string[],people:Signer[],doc:DocumentFacts){
  const text=(v:string)=>v.trim();
  const published=text(doc.published)&&!Number.isNaN(Date.parse(text(doc.published)))?new Date(text(doc.published)).toISOString():'';
  return {templateId,
    recipients:people.map((s,i)=>{const after=s.after.split('\n').map(text).filter(Boolean);return {role:roles[i],name:text(s.name),email:text(s.email),
      ...(text(s.title)?{title:text(s.title)}:{}),...(text(s.company)?{onBehalfOf:text(s.company)}:{}),...(after.length?{afterSigning:after}:{})};}),
    ...(text(doc.name)?{documentName:text(doc.name)}:{}),
    ...(text(doc.version)?{documentVersion:{label:text(doc.version),...(published?{publishedAt:published}:{})}}:{}),
    ...(text(doc.senderName)?{sender:{name:text(doc.senderName),...(text(doc.senderCompany)?{organization:text(doc.senderCompany)}:{})}}:{})};
}
type Certificate=Parameters<typeof CompletionCertificate>[0]['certificate'];
type Editor={sessionId:string;url:string;ready:boolean;requestId:string};

export class DemoRequestError extends Error {
  readonly status:number;readonly code:string;
  constructor(status:number,code:string){super(code?`${status} ${code}`:`HTTP ${status}`);this.status=status;this.code=code;}
}

/** Same-origin API calls as the signed-in member. */
export function demoClient(){
  return async(path:string,init:RequestInit={})=>{
    const response=await fetch(path,{...init,cache:'no-store',credentials:'same-origin',headers:{...(init.headers as Record<string,string>|undefined)}});
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
const describe=(error:unknown)=>error instanceof DemoRequestError?(error.status===401?'Sign in to use E-sign.':error.status===403?'Your role in E-sign doesn\'t allow that.':`Request failed (${error.message}).`):(error instanceof Error?error.message:'Request failed.');

export function DemoPage(){
  const [tenant,setTenant]=useState(''),[canManage,setCanManage]=useState(false);
  const [file,setFile]=useState<File|null>(null),[mode,setMode]=useState<'page'|'fields'>('page'),[twoSigners,setTwoSigners]=useState(true);
  const [signers,setSigners]=useState<Signer[]>([{name:'',email:'',title:'',company:'',after:''},{name:'',email:'',title:'',company:'',after:''}]);
  const [doc,setDoc]=useState<DocumentFacts>(SAMPLE_DOCUMENT),[signIn,setSignIn]=useState('none');
  const [editor,setEditor]=useState<Editor|null>(null),[templateId,setTemplateId]=useState('');
  const [envelope,setEnvelope]=useState<Envelope|null>(null),[recent,setRecent]=useState<string[]>(recentIds);
  const [frame,setFrame]=useState<{url:string;task:Task}|null>(null),[pdf,setPdf]=useState<{url:string;name:string}|null>(null),[certificate,setCertificate]=useState<Certificate|null>(null);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const attempt=useRef<{body:string;key:string}|null>(null),editorFrame=useRef<HTMLIFrameElement|null>(null),signingFrame=useRef<HTMLIFrameElement|null>(null);
  const call=demoClient();
  const roles=twoSigners?ROLES:ROLES.slice(0,1);

  async function run(work:()=>Promise<void>){setBusy(true);setMessage('');try{await work();}catch(error){setMessage(describe(error));}finally{setBusy(false);}}

  // Who is signed in, and in which organization: the platform identity.
  useEffect(()=>{let live=true;
    call('/api/me').then(r=>r.json() as Promise<{organizationId:string;permissions:string[]}>).then(me=>{if(!live)return;setTenant(me.organizationId);setCanManage(me.permissions.includes('esign.manage'));})
      .catch(error=>{if(live)setMessage(describe(error));});
    return()=>{live=false;};},[]);
  useEffect(()=>()=>{if(pdf)URL.revokeObjectURL(pdf.url);},[pdf]);

  async function refresh(id:string){const data=await (await call(`/api/envelopes/${id}`)).json() as Envelope;setEnvelope(data);return data;}
  // While an envelope is open and not completed, follow its status: the Worker advances it.
  useEffect(()=>{if(!envelope||envelope.status==='COMPLETED')return;const id=envelope.id;const timer=setInterval(()=>{refresh(id).catch(()=>{});},POLL_MS);return()=>clearInterval(timer);},[envelope?.id,envelope?.status,tenant]);


  function pdfError(){if(!file)return 'Choose a PDF.';if(file.size>MAX_PDF_BYTES)return 'The PDF must be 5 MB or smaller.';return '';}
  function chooseFile(next:File|null){setFile(next);setTemplateId('');setEditor(null);attempt.current=null;}

  async function createTemplate():Promise<string>{
    const form=new FormData();form.set('file',file!);form.set('roles',JSON.stringify(roles));
    return ((await (await call('/api/templates',{method:'POST',body:form})).json()) as {id:string}).id;
  }
  function openEditor(){const invalid=pdfError();if(invalid){setMessage(invalid);return;}
    void run(async()=>{
      const session=await (await call('/api/template-editing-sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:window.location.origin,roles})})).json() as {sessionId:string;url:string};
      const url=new URL(session.url);
      if(url.origin!==window.location.origin||url.pathname!==`/editor/page/${session.sessionId}`)throw new Error('Unexpected editor address.');
      await call(`/api/template-editing-sessions/${session.sessionId}/source`,{method:'POST',headers:{'content-type':'application/pdf'},body:file!});
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
      void run(async()=>{const saved=await (await call(`/api/template-editing-sessions/${editor.sessionId}`)).json() as {templateId:string|null};
        if(saved.templateId!==result.templateId)throw new Error('The editor and the server disagree on the saved template; open the editor again.');
        setTemplateId(result.templateId);setEditor(null);setMessage('Fields saved. Send it for signature.');});};
    window.addEventListener('message',listen);return()=>window.removeEventListener('message',listen);},[editor,tenant]);

  function send(){const invalid=pdfError();if(invalid){setMessage(invalid);return;}
    if(mode==='fields'&&!templateId){setMessage('Place and save the signature fields first.');return;}
    const people=signers.slice(0,roles.length);
    if(people.some(s=>!s.name.trim()||!EMAIL.test(s.email.trim()))){setMessage('Enter a name and an email address for each signer.');return;}
    void run(async()=>{
      const template=mode==='fields'?templateId:await createTemplate();
      const body=JSON.stringify(envelopeRequest(template,roles,people,doc));
      // Retrying the same send reuses its idempotency key, so a lost response cannot send twice.
      if(!attempt.current||attempt.current.body!==body)attempt.current={body,key:crypto.randomUUID()};
      const {id}=await (await call('/api/envelopes',{method:'POST',headers:{'content-type':'application/json','idempotency-key':attempt.current.key},body})).json() as {id:string};
      attempt.current=null;const next=[id,...recent.filter(x=>x!==id)].slice(0,10);setRecent(next);save('local',RECENT_STORAGE,JSON.stringify(next));
      setFrame(null);setPdf(null);setCertificate(null);await refresh(id);setMessage('Sent. Open each signer\'s page below.');
    });}
  function open(id:string){void run(async()=>{setFrame(null);setPdf(null);setCertificate(null);await refresh(id);});}
  function sign(task:Task){if(!envelope)return;void run(async()=>{
    // The sign-in the host states, when one is chosen: the signer's email domain, now.
    const chosen=SIGN_IN_OPTIONS.find(([id])=>id===signIn)?.[2];
    const hostAuthentication=chosen?{...chosen,domain:task.recipientEmail.split('@').pop()?.toLowerCase(),signedInAt:new Date().toISOString()}:undefined;
    const {code}=await (await call(`/api/envelopes/${envelope.id}/tasks/${task.id}/recipient-view`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:window.location.origin,...(hostAuthentication?{hostAuthentication}:{})})})).json() as {code:string};
    // This page is the host: the signing page reports to it when the signer closes, signs or declines.
    setFrame({url:`/sign#code=${encodeURIComponent(code)}&host=${encodeURIComponent(window.location.origin)}`,task});});}
  // The signing page's own messages: Cancel closes it; signing or declining closes it and reads the envelope again.
  useEffect(()=>{if(!frame||!envelope)return;const id=envelope.id,name=frame.task.recipientName;
    const listen=(event:MessageEvent)=>{const msg=readSigningHostMessage(event,window.location.origin,signingFrame.current?.contentWindow);if(!msg)return;
      setFrame(null);
      if(msg.type==='esign.signing.finished')void run(async()=>{await refresh(id);setMessage(msg.outcome==='signed'?`${name} signed.`:`${name} declined.`);});};
    window.addEventListener('message',listen);return()=>window.removeEventListener('message',listen);},[frame,envelope?.id,tenant]);
  function download(){if(!envelope)return;void run(async()=>{const blob=await (await call(`/api/envelopes/${envelope.id}/delivery-pdf`)).blob();setPdf({url:URL.createObjectURL(blob),name:'signed-with-certificate.pdf'});});}
  function showCertificate(){if(!envelope)return;void run(async()=>{setCertificate(await (await call(`/api/envelopes/${envelope.id}/certificate`)).json() as Certificate);});}

  const field=(label:string,input:React.ReactElement)=>h('label',{style:{display:'block',margin:'0.4rem 0'}},label,' ',input);
  if(!tenant)return h('main',{style:{maxWidth:720,margin:'2rem auto',fontFamily:'sans-serif'}},
    h('h1',null,'E-sign'),h('p',{role:'status'},message||'Loading…'));
  if(!canManage)return h('main',{style:{maxWidth:720,margin:'2rem auto',fontFamily:'sans-serif'}},
    h('h1',null,'E-sign'),h('p',null,'Your role can see envelopes but not send them. Ask an admin of your organization for the Editor role, or a custom role that sends and manages envelopes.'));

  const counted=signers.slice(0,roles.length);
  return h('main',{style:{maxWidth:960,margin:'2rem auto',fontFamily:'sans-serif'}},
    h('h1',null,'E-sign'),
    h('p',null,'Try a signing from start to finish: upload a PDF, name up to two signers, and sign each one\'s page below. Use synthetic documents and test addresses until your organization has reviewed E-sign for real documents.'),
    h('section',{'aria-label':'New document'},h('h2',null,'1. Document and signers'),
      field('PDF',h('input',{type:'file',accept:'application/pdf','aria-label':'PDF',disabled:busy,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>chooseFile(e.target.files?.[0]??null)})),
      h('fieldset',null,h('legend',null,'Where signatures go'),
        h('label',{style:{display:'block'}},h('input',{type:'radio',name:'mode',checked:mode==='page',onChange:()=>{setMode('page');setEditor(null);setTemplateId('');}}),' On a signature page added after the last page'),
        h('label',{style:{display:'block'}},h('input',{type:'radio',name:'mode',checked:mode==='fields',onChange:()=>setMode('fields')}),' In signature fields I place on the document')),
      h('fieldset',null,h('legend',null,'Document (shown to signers)'),
        ...([['name','Document name'],['version','Version'],['published','Published (YYYY-MM-DD)'],['senderName','Sender name'],['senderCompany','Sender company']] as [keyof DocumentFacts,string][]).map(([k,label])=>
          h(React.Fragment,{key:k},field(label,h('input',{'aria-label':label,value:doc[k],onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{const value=e.target.value;setDoc(old=>({...old,[k]:value}));}}))))),
      h('label',{style:{display:'block',margin:'0.4rem 0'}},h('input',{type:'checkbox',checked:twoSigners,disabled:!!editor||!!templateId,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{setTwoSigners(e.target.checked);attempt.current=null;}}),' Two signers, in order'),
      ...counted.map((s,i)=>h('fieldset',{key:i},h('legend',null,`Signer ${i+1}`),
        field('Name',h('input',{'aria-label':`Signer ${i+1} name`,value:s.name,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,name:e.target.value}:x))})),
        field('Email',h('input',{type:'email','aria-label':`Signer ${i+1} email`,value:s.email,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,email:e.target.value}:x))})),
        field('Title (optional)',h('input',{'aria-label':`Signer ${i+1} title`,value:s.title,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,title:e.target.value}:x))})),
        field('Signs for company (optional)',h('input',{'aria-label':`Signer ${i+1} company`,value:s.company,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,company:e.target.value}:x))})),
        field('After signing, one line each (optional, at most 3)',h('textarea',{'aria-label':`Signer ${i+1} after signing`,rows:2,value:s.after,onChange:(e:React.ChangeEvent<HTMLTextAreaElement>)=>setSigners(old=>old.map((x,j)=>j===i?{...x,after:e.target.value}:x))})))),
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
      field('Signer signed in with',h('select',{'aria-label':'Signer signed in with',value:signIn,onChange:(e:React.ChangeEvent<HTMLSelectElement>)=>setSignIn(e.target.value)},
        ...SIGN_IN_OPTIONS.map(([id,label])=>h('option',{key:id,value:id},label)))),
      h('p',{style:{fontSize:'0.85rem',color:'#555'}},'Recorded as the host\'s statement on the certificate.'),
      h('ol',null,...envelope.tasks.map(task=>h('li',{key:task.id},`${task.recipientName} <${task.recipientEmail}>: ${task.status} `,
        task.status==='ACTIVE'&&h('button',{type:'button',disabled:busy,onClick:()=>sign(task)},`Open ${task.recipientName}'s signing page`)))),
      envelope.status==='COMPLETED'&&h('p',null,
        h('button',{type:'button',disabled:busy,onClick:download},'View signed PDF with certificate'),' ',
        h('button',{type:'button',disabled:busy,onClick:showCertificate},'View completion certificate')),
      // The signing page in a dialog, as a host shows it: its title, who sent it, and close.
      frame&&h('div',{style:{position:'fixed',inset:0,background:'#0006',display:'flex',alignItems:'center',justifyContent:'center',padding:16,zIndex:10}},
        h('div',{role:'dialog','aria-modal':true,'aria-label':'Signing page',style:{background:'#fff',borderRadius:8,width:'min(1152px,100%)',height:'88vh',display:'flex',flexDirection:'column',padding:20,gap:12}},
          h('div',{style:{display:'flex',alignItems:'flex-start',gap:12}},
            h('div',{style:{flex:1}},h('h2',{style:{margin:0,fontSize:18}},`Sign the ${doc.name.trim()||'document'}`),
              h('p',{style:{margin:'4px 0 0',color:'#666',fontSize:14}},[doc.senderCompany.trim()&&`From ${doc.senderCompany.trim()}`,doc.senderName.trim()&&`sent by ${doc.senderName.trim()} on ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`].filter(Boolean).join(' · '))),
            h('button',{type:'button','aria-label':'Close the signing page',onClick:()=>setFrame(null)},'✕')),
          h('iframe',{ref:signingFrame,title:'Recipient signing page',src:frame.url,style:{flex:1,width:'100%',border:'1px solid #e3e5e8',borderRadius:8},sandbox:'allow-scripts allow-same-origin allow-forms allow-downloads'})))),
    pdf&&h('section',null,h('a',{href:pdf.url,download:pdf.name},`Download ${pdf.name}`),h('iframe',{title:'Signed PDF',src:pdf.url,width:'100%',height:'760'})),
    certificate&&envelope?.status==='COMPLETED'&&h(CompletionCertificate,{certificate}));
}
