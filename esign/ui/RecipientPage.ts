import React, { useEffect, useRef, useState } from 'react';
import {createPortal} from 'react-dom';
const h = React.createElement;
const localApis=new Map([['http://127.0.0.1:5173','http://127.0.0.1:8787'],['http://127.0.0.1:5174','http://127.0.0.1:8787'],['http://127.0.0.1:5197','http://127.0.0.1:8797']]);
/** The origin the Worker declared, when it served this page itself (src/signing-page.ts). */
const workerApiOrigin=()=>{try{return typeof document==='undefined'?'':document.querySelector('meta[name="esign-api"]')?.getAttribute('content')??'';}catch{return '';}};
class RequestFailed extends Error {readonly status:number;readonly code:string;constructor(status:number,code=''){super('Request failed');this.status=status;this.code=code;}}

type SignatureField = {id:string;type:'Signature'|'Title'|'Date signed';page:number;required:boolean;rect:{x:number;y:number;width:number;height:number}};
/** The consent to sign electronically, as the server words it (src/disclosure.ts). */
type Disclosure = {version:string;text:string};
type Artifact = {id:string;sha256:string;verified?:boolean;fields?:SignatureField[];recipientName?:string;role?:string;disclosure?:Disclosure;signer?:{title?:string;onBehalfOf?:string};intent?:string;signerName?:string;documentName?:string;recipientEmail?:string};
/** A file name for the downloaded copy: the document's name, else "document". */
const pdfFileName=(name?:string)=>`${(name??'').replace(/[^A-Za-z0-9 ._-]+/g,'').trim().slice(0,100)||'document'}.pdf`;
/** "Signed electronically by Ana Partner, Partner Manager, on behalf of Northbeam Consulting". */
export function signedByLine(name:string,title:string,company?:string):string{return ['Signed electronically by '+(name.trim()||'you'),title.trim(),company?`on behalf of ${company}`:''].filter(Boolean).join(', ');}
type RenderDocument = (blob:Blob, container:HTMLElement, signal:AbortSignal)=>Promise<void>;
const defaultRender:RenderDocument=async (blob,container,signal)=>{const {renderPdf}=await import('./renderPdf');signal.throwIfAborted();return renderPdf(blob,container,signal);};
/** A code lasts as long as the Worker keeps it (OTP_TTL_MS). */
const CODE_TTL_MS=10*60*1000, CODE_LENGTH=6;
/** "9:05": minutes and seconds left. */
export function codeTimeLeft(ms:number):string{const s=Math.max(0,Math.ceil(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
/**
 * The next code after typing `raw` into box `index`: one digit per box, filled left to right.
 * More than two digits at once is a paste (or autofill) and fills from that box on.
 */
export function nextCode(code:string,index:number,raw:string):string{
  const typed=raw.replace(/\D/g,''),at=Math.min(index,code.length);
  if(!typed)return code.slice(0,at);
  const current=code[at]??'';
  const digit=typed.length===2&&current?(typed.replace(current,'')||typed.slice(-1)):typed;
  return (code.slice(0,at)+(digit.length>2?digit:digit.slice(-1))+(digit.length>2?'':code.slice(at+1))).slice(0,CODE_LENGTH);
}
/** Six boxes, one digit each; typing moves on, Backspace moves back, a paste fills them all. */
function CodeBoxes({value,onChange,disabled,onEnter}:{value:string;onChange:(code:string)=>void;disabled:boolean;onEnter:()=>void}){
  const boxes=useRef<(HTMLInputElement|null)[]>([]);
  const focus=(i:number)=>{const box=boxes.current[Math.max(0,Math.min(CODE_LENGTH-1,i))];if(typeof box?.focus==='function')box.focus();};
  return h('div',{className:'esign-code-boxes',role:'group','aria-label':'Verification code'},...Array.from({length:CODE_LENGTH},(_,i)=>h('input',{
    key:i,ref:(el:HTMLInputElement|null)=>{boxes.current[i]=el;},'aria-label':`Digit ${i+1} of ${CODE_LENGTH}`,value:value[i]??'',disabled,
    inputMode:'numeric',autoComplete:i===0?'one-time-code':'off',
    onFocus:(e:React.FocusEvent<HTMLInputElement>)=>{if(i>value.length){focus(value.length);return;}e.target.select();},
    onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{const next=nextCode(value,i,e.target.value);onChange(next);if(next.length>value.length)focus(next.length);},
    onPaste:(e:React.ClipboardEvent<HTMLInputElement>)=>{e.preventDefault();const next=(value.slice(0,Math.min(i,value.length))+e.clipboardData.getData('text').replace(/\D/g,'')).slice(0,CODE_LENGTH);onChange(next);focus(next.length);},
    onKeyDown:(e:React.KeyboardEvent<HTMLInputElement>)=>{
      if(e.key==='Backspace'&&!value[i]&&i>0){e.preventDefault();onChange(value.slice(0,i-1));focus(i-1);}
      else if(e.key==='ArrowLeft'){e.preventDefault();focus(i-1);}
      else if(e.key==='ArrowRight'){e.preventDefault();focus(Math.min(i+1,value.length));}
      else if(e.key==='Enter'&&value.length===CODE_LENGTH){e.preventDefault();onEnter();}},
  })));
}
/** Shown inside a host's frame: the host's dialog already titles it, so the page header is compact. */
const embedded=(()=>{try{return typeof window!=='undefined'&&window.self!==window.top;}catch{return true;}})();
export function RecipientPage({renderDocument=defaultRender}:{renderDocument?:RenderDocument} = {}) {
  const container=useRef<HTMLDivElement>(null), renderController=useRef<AbortController|null>(null), loadSequence=useRef(0),synthetic=useRef(false),uploadBase=useRef(''),api=useRef(''),signingLock=useRef(false),workerServed=useRef(false);
  useEffect(()=>()=>{loadSequence.current++;},[]);
  const [token,setToken]=useState(''), [otp,setOtp]=useState(''), [message,setMessage]=useState('Opening local test session…');
  const [artifact,setArtifact]=useState<Artifact|null>(null), [pdf,setPdf]=useState<Blob|null>(null), [consent,setConsent]=useState(false), [sent,setSent]=useState(false);
  const [rendered,setRendered]=useState(false),[pageHosts,setPageHosts]=useState<HTMLElement[]>([]),[imageUrls,setImageUrls]=useState<Record<string,string>>({});
  const [textReceipts,setTextReceipts]=useState<Record<string,string>>({});
  const [signatureReceipts,setSignatureReceipts]=useState<Record<string,string>>({});
  const [signatureSizes,setSignatureSizes]=useState<Record<string,{width:number;height:number}>>({});
  const [signatures,setSignatures]=useState<Record<string,string>>({}),[previews,setPreviews]=useState<Record<string,string>>({}),[datePreviewVersion,setDatePreviewVersion]=useState(0);
  const [signing,setSigning]=useState(false),[verified,setVerified]=useState(false), [finished,setFinished]=useState(false), [messageId,setMessageId]=useState(''), [testOtp,setTestOtp]=useState('');
  // When the code was sent (its expiry counts down from there), whether it went by email, and the clock.
  const [sentAt,setSentAt]=useState(0),[emailed,setEmailed]=useState(false),[now,setNow]=useState(()=>Date.now()),autoSent=useRef(false);
  // Signing for a company: the signer's title (the host's, editable) and their confirmation of authority.
  const [signerTitle,setSignerTitle]=useState(''),[authority,setAuthority]=useState(false);
  // Declining instead of signing, with a reason.
  const [declining,setDeclining]=useState(false),[declineReason,setDeclineReason]=useState(''),[declineBusy,setDeclineBusy]=useState(false);
  // What the signer is about to sign: how many pages, and the document itself to keep a copy before signing.
  const [pageCount,setPageCount]=useState(0),[pdfUrl,setPdfUrl]=useState('');
  // The three steps (review, confirm it's you, sign); a decline waiting for the code; pages viewed.
  const [step,setStep]=useState<1|2|3>(1),[pendingDecline,setPendingDecline]=useState(false),[viewed,setViewed]=useState(0),[pageEls,setPageEls]=useState<Element[]>([]);
  // The host refused the document before the code (it requires the code first), or loading failed.
  const [docNeedsCode,setDocNeedsCode]=useState(false),[docFailed,setDocFailed]=useState(false);
  useEffect(()=>{if(!pdf){setPdfUrl('');return;}const url=URL.createObjectURL(pdf);setPdfUrl(url);return ()=>URL.revokeObjectURL(url);},[pdf]);
  useEffect(()=>{setSignerTitle(artifact?.signer?.title??'');setAuthority(false);},[artifact?.id]);
  const forCompany=artifact?.signer?.onBehalfOf;
  // Title fields show the title given on Review, so a template with one needs a title there.
  const titleFieldIds=(artifact?.fields??[]).filter(f=>f.type==='Title').map(f=>f.id),needsTitle=titleFieldIds.length>0;
  const authorityReady=(!forCompany||(signerTitle.trim()!==''&&authority))&&(!needsTitle||signerTitle.trim()!=='');
  // Every Title field carries the Review title; a change there asks for new previews.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the field ids
  useEffect(()=>{if(!needsTitle)return;const title=signerTitle.trim();
    setSignatures(old=>titleFieldIds.every(id=>old[id]===title)?old:{...old,...Object.fromEntries(titleFieldIds.map(id=>[id,title]))});},[signerTitle,titleFieldIds.join()]);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.hash.slice(1));const code=params.get('code');
    synthetic.current=params.get('synthetic')==='1';
    const upload=params.get('upload');
    if(upload && /^[a-f0-9-]{36}$/.test(upload))uploadBase.current=`/host/upload/envelopes/${upload}`;
    window.history.replaceState(null,'',window.location.pathname);
    // Served by the Worker: its API is this page's own origin, and only when the Worker said so.
    const served=workerApiOrigin()===window.location.origin;workerServed.current=served;
    if(served){synthetic.current=false;uploadBase.current='';}
    api.current=served?window.location.origin:localApis.get(window.location.origin)??'';
    if (!api.current) {setMessage('Recipient demo unavailable on this origin.');return;}
    if (!code) {setMessage('No recipient code provided.');return;}
    fetch(`${uploadBase.current || (synthetic.current?'/host/synthetic':api.current)}/v1/page-sessions/exchange`,{method:'POST',headers:{'content-type':'application/json',...((synthetic.current||uploadBase.current)?{'x-local-esign':'1'}:{})},body:JSON.stringify({code})})
      .then(async response=>{if(!response.ok) throw new Error();const value=await response.json() as {token:string};setToken(value.token);setMessage('Loading document…');})
      .catch(()=>setMessage('Session unavailable or expired.'));
  },[]);
  useEffect(()=>{
    if (!pdf || !container.current) return;
    let active=true;const target=container.current;const detached=target.ownerDocument.createElement('div');
    const controller=new AbortController();renderController.current=controller;target.replaceChildren();
    renderDocument(pdf,detached,controller.signal).then(()=>{
      if(active && !controller.signal.aborted) {
        const pages=typeof detached.querySelectorAll==='function'?Array.from(detached.querySelectorAll('canvas')):[];
        setPageCount(pages.length);setPageEls(pages);
        const fields=artifact?.fields??[];let hosts:HTMLElement[]=[];
        if(fields.length){
          const canvases=Array.from(detached.querySelectorAll('canvas'));
          if(!canvases.length||fields.some(f=>!f.rect||!Number.isInteger(f.page)||f.page<1||f.page>canvases.length||![f.rect.x,f.rect.y,f.rect.width,f.rect.height].every(Number.isFinite)||f.rect.x<0||f.rect.y<0||f.rect.width<=0||f.rect.height<=0||f.rect.x+f.rect.width>1||f.rect.y+f.rect.height>1))throw new Error('Invalid field layout');
          hosts=canvases.map((canvas,index)=>{const page=detached.ownerDocument.createElement('div');page.dataset.signaturePage=String(index+1);page.style.cssText='position:relative;display:table;max-width:100%;margin:0 auto 24px;line-height:0';canvas.replaceWith(page);page.appendChild(canvas);canvas.style.display='block';return page;});
        }
        target.replaceChildren(detached);setPageHosts(hosts);setMessage('Review every page, then continue.');setRendered(true);
      }
    }).catch(()=>{if(active && !controller.signal.aborted) {target.replaceChildren();setPdf(null);setArtifact(null);setDocFailed(true);setMessage('Document unavailable. Retry loading it, or request a new view if the session expired.');}});
    return ()=>{active=false;controller.abort();if(renderController.current===controller) renderController.current=null;target.replaceChildren();};
  },[pdf,renderDocument]);
  async function request(path:string, init:RequestInit={}) {
    const response=await fetch(`${uploadBase.current || (synthetic.current?'/host/synthetic':api.current)}${path}`,{...init,headers:{...init.headers,...((synthetic.current||uploadBase.current)?{'x-local-esign':'1'}:{}),authorization:`Bearer ${token}`}});
    if(!response.ok){let code='';try{const body=await response.json() as {error?:unknown};if(typeof body?.error==='string')code=body.error;}catch{}throw new RequestFailed(response.status,code);}return response;
  }
  async function send(announce=true) {try {
    const result=await (await request('/v1/signing/otp',{method:'POST'})).json() as {messageId:string;testOtp?:string;emailed?:boolean};
    setMessageId(result.messageId);setTestOtp(result.testOtp ?? '');setSent(true);setSentAt(Date.now());setNow(Date.now());setOtp('');setEmailed(!!result.emailed);
    if(announce)setMessage(result.emailed?'Verification code sent by email.':'Test code sent to the local test mailbox.');
  } catch {setMessage('Could not send a code. Wait a minute, then resend.');}}
  // Reaching "Confirm it's you" sends the code once; Resend asks for another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: send once per page session
  useEffect(()=>{if(!token||verified||finished||autoSent.current||(step!==2&&!docNeedsCode))return;autoSent.current=true;void send(docNeedsCode);},[token,step,docNeedsCode,verified,finished]);
  // The countdown to the code's expiry, while one is waiting to be entered.
  useEffect(()=>{if(!sent||verified)return;const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[sent,verified]);
  async function loadDocument() {
    const sequence=++loadSequence.current;renderController.current?.abort();container.current?.replaceChildren();setDocFailed(false);
    setRendered(false);setConsent(false);setSignatures({});setPreviews({});setPageHosts([]);setImageUrls({});setSignatureSizes({});setSignatureReceipts({});setTextReceipts({});setArtifact(null);setPdf(null);setMessage('Loading document…');
    try {
      const info=await (await request('/v1/signing/current')).json() as Artifact;
      if(sequence!==loadSequence.current) return;
      const blob=await (await request('/v1/signing/pdf')).blob();
      if(sequence!==loadSequence.current) return;
      setArtifact(info);setPdf(blob);setDocNeedsCode(false);
      if(info.verified)setVerified(true);
    } catch (error) {
      if(sequence!==loadSequence.current) return;
      // A host that shows the document only after the code: confirm first, then read it.
      if(error instanceof RequestFailed&&error.status===401&&!verified){setDocNeedsCode(true);setStep(2);setMessage("Confirm it's you to open the document.");return;}
      setDocFailed(true);setMessage('Document unavailable. Retry loading it, or request a new view if the session expired.');
    }
  }
  // The document opens as soon as the page session does: the signer reviews it first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per session token
  useEffect(()=>{if(token&&!finished)void loadDocument();},[token]);
  // Pages the signer looked at (at least half on screen for a second), recorded once each; never blocks signing.
  useEffect(()=>{
    if(!rendered||!pageEls.length||!token||typeof IntersectionObserver==='undefined')return;
    const total=pageEls.length,pending=new Set<number>(),timers=new Map<number,ReturnType<typeof setTimeout>>();let sending=false,closed=false;
    const flush=async():Promise<void>=>{
      if(sending||closed||!pending.size)return;sending=true;const pages=[...pending];pending.clear();
      try {const body=await (await request('/v1/signing/page-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pages,total})})).json() as {viewed?:unknown};if(typeof body.viewed==='number'&&!closed)setViewed(body.viewed);}
      catch {/* Best-effort: the next view tries again. */for(const p of pages)pending.add(p);}
      finally {sending=false;}
    };
    // On screen: half the page, or (a page taller than the view) half the view's height.
    const root=container.current&&container.current.scrollHeight>container.current.clientHeight?container.current:null;
    const observer=new IntersectionObserver(entries=>{for(const entry of entries){const page=pageEls.indexOf(entry.target)+1;if(page<1)continue;
      const fillsView=!!entry.rootBounds&&entry.intersectionRect.height>=entry.rootBounds.height*0.5;
      if(entry.isIntersecting&&(entry.intersectionRatio>=0.5||fillsView)){if(!timers.has(page))timers.set(page,setTimeout(()=>{pending.add(page);void flush();},1000));}
      else {clearTimeout(timers.get(page));timers.delete(page);}}},{root,threshold:Array.from({length:21},(_,i)=>i/20)});
    for(const el of pageEls)observer.observe(el);
    return ()=>{closed=true;observer.disconnect();for(const t of timers.values())clearTimeout(t);};
  },[rendered,pageEls,token]);
  async function verify() {if(otp.length!==CODE_LENGTH)return;try {
    await request('/v1/signing/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})});
    setVerified(true);setOtp('');setTestOtp('');
  } catch {setMessage('Code verification unavailable. Retry the same code.');return;}
    // A host that needed the code first shows the document now.
    if(docNeedsCode||!artifact){await loadDocument();setStep(1);return;}
    if(pendingDecline){setPendingDecline(false);setStep(1);await decline();return;}
    setStep(3);setMessage('Adopt your signature, then sign.');}
  const fields=artifact?.fields??[];
  const signaturesReady=fields.every(field=>{const value=signatures[field.id]??'';if(field.type==='Date signed')return /^[a-f0-9-]{36}$/.test(previews[field.id]??'');if(!field.required&&!value)return true;return (field.type==='Title'?value.length<=128&&value.length>0&&value.trim()===value&&/^[\x20-\x7e]+$/.test(value):/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value)&&value.length<=64)&&previews[field.id]===value;});
  async function sign() {if(signingLock.current || !artifact || !consent || !rendered || !signaturesReady || !authorityReady)return;signingLock.current=true;setSigning(true);try {
    await request('/v1/signing/sign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true,...(forCompany||signerTitle.trim()?{title:signerTitle.trim()}:{}),...(forCompany?{authorityConfirmed:true}:{}),...(artifact.disclosure?{disclosureVersion:artifact.disclosure.version}:{}),signaturePreviews:signatureReceipts,textPreviews:textReceipts,...(fields.length?{signatures:Object.fromEntries(fields.filter(f=>f.type!=='Date signed'&&signatures[f.id]).map(f=>[f.id,signatures[f.id]]))}:{}),...(fields.some(f=>f.type==='Date signed')?{datePreviewIds:Object.fromEntries(fields.filter(f=>f.type==='Date signed').map(f=>[f.id,previews[f.id]]))}:{})})});
    setArtifact(null);setPdf(null);setRendered(false);setFinished(true);setMessage(workerServed.current?'Signature recorded.':'Signature recorded. Local processing must be requested separately.');
  } catch (error) {if(error instanceof RequestFailed&&error.status===409&&fields.some(f=>f.type==='Date signed')){const dates=fields.filter(f=>f.type==='Date signed');setPreviews(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setImageUrls(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setConsent(false);setMessage('Signature was rejected. Check the inputs or refresh date previews and review the document before signing.');}else setMessage('Signature rejected or unavailable. Check that it fits without overlapping another field, then retry.');}finally{signingLock.current=false;setSigning(false);}}
  async function decline() {if(declineBusy||!declineReason.trim())return;setDeclineBusy(true);try {
    await request('/v1/signing/decline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:declineReason.trim()})});
    setArtifact(null);setPdf(null);setRendered(false);setFinished(true);setDeclining(false);setMessage('You declined to sign. The sender has been told.');
  } catch {setMessage('Declining did not go through. Try again.');} finally {setDeclineBusy(false);}}
  const signingAs = artifact?.signerName ?? artifact?.recipientName ?? '';
  const steps:[1|2|3,string][]=[[1,'Review'],[2,"Confirm it's you"],[3,'Sign']];
  // Declining asks for the code first, like signing; after it, the decline goes through.
  const declineControls = h('div',{className:'esign-decline'},
    !declining&&h('button',{type:'button',disabled:signing,onClick:()=>setDeclining(true)},'Decline to sign'),
    declining&&h('label',null,'Why are you declining? ',h('textarea',{'aria-label':'Reason for declining',value:declineReason,maxLength:1000,onChange:(event:React.ChangeEvent<HTMLTextAreaElement>)=>setDeclineReason(event.target.value)})),
    declining&&h('button',{type:'button',disabled:declineBusy||!declineReason.trim(),onClick:()=>{if(verified)void decline();else{setPendingDecline(true);setStep(2);setMessage("Confirm it's you to decline.");}}},'Decline'),
    declining&&h('button',{type:'button',disabled:declineBusy,onClick:()=>{setDeclining(false);setDeclineReason('');setPendingDecline(false);}},'Keep the document'));
  const codeLeft=sentAt+CODE_TTL_MS-now, sentTo=artifact?.recipientEmail||'your email address';
  const verification = h('div',{className:'esign-verification'},
    h('h2',null,"Confirm it's you"),
    verified?h('p',null,'Your email address is confirmed.'):h('div',{className:'esign-code','data-test-message-id':messageId||undefined},
      h('p',null,sent?`Enter the 6-digit code we sent to ${sentTo}.`:`Sending a 6-digit code to ${sentTo}…`),
      sent&&h('p',{className:'esign-code-note'},emailed?"Test environment: the code goes to this environment's test mailbox.":'Local test: the code is in the local test mailbox.'),
      testOtp&&h('p',{className:'esign-code-note'},'Local test verification code: ',testOtp,' (test only)'),
      h(CodeBoxes,{value:otp,onChange:setOtp,disabled:!sent,onEnter:()=>void verify()}),
      h('p',{className:'esign-code-meta'},
        sent&&(codeLeft>0?`Code expires in ${codeTimeLeft(codeLeft)}`:'This code has expired.'),sent&&' · ',
        h('button',{type:'button',className:'esign-link',onClick:()=>void send()},'Resend code')),
      h('p',{className:'esign-why'},h('strong',null,'Why we ask. '),"Your sign-in and the email code are recorded in the agreement's audit trail, with the time, your IP address and browser.")),
    h('div',{className:'esign-step-actions'},
      artifact&&h('button',{type:'button',onClick:()=>{setPendingDecline(false);setStep(1);}},'Back'),
      !verified&&h('button',{type:'button',className:'esign-continue',disabled:otp.length!==CODE_LENGTH,onClick:()=>void verify()},'Verify code'),
      verified&&artifact&&h('button',{type:'button',className:'esign-continue',onClick:()=>setStep(3)},'Continue')));
  return h('main',{className:embedded?'esign-recipient esign-embedded':'esign-recipient'},
    h('h1',null,'E-sign local test'),h('p',null,'Experimental synthetic documents only. Not a production signature service.'),h('p',{role:'status'},message),
    token && !finished && h('ol',{className:'esign-steps','aria-label':'Signing steps'},...steps.map(([n,label])=>h('li',{key:n,'aria-current':step===n?'step':undefined,className:step===n?'esign-step-current':step>n?'esign-step-done':undefined},`${n} ${label}`))),
    // The document could not be opened before the code (a host that requires it first): confirm, then read it.
    token && !finished && docNeedsCode && !verified && h('section',{className:'esign-verification-card'},verification),
    token && !artifact && !finished && docFailed && h('button',{onClick:()=>void loadDocument(),type:'button'},'Retry document'),
    h('div',{className:'esign-signing-workspace'},
    token && !finished && (verified||!docNeedsCode) && h('div',{ref:container,'aria-label':'Document to sign',className:'esign-document-surface'}),
    artifact && rendered && step===2 && h('section',{className:'esign-signing-panel'},verification),
    artifact && rendered && step===1 && h('section',{className:'esign-signing-panel'},
      // The document as it will be signed: its pages, its fingerprint, and a copy to keep.
      h('div',{className:'esign-document-facts','aria-label':'Document details'},
        h('p',null,h('strong',null,artifact.documentName||'Document'),pageCount>0?` · ${pageCount} ${pageCount===1?'page':'pages'}`:''),
        h('p',{title:artifact.sha256},'SHA-256 fingerprint: ',h('code',null,`${artifact.sha256.slice(0,16)}…${artifact.sha256.slice(-8)}`)),
        pdfUrl&&h('a',{href:pdfUrl,download:pdfFileName(artifact.documentName)},'Download PDF')),
      h('div',{className:'esign-signing-as','aria-label':'Signing as'},
        h('h2',null,'Signing as'),
        signingAs&&h('p',null,signingAs),
        (forCompany||artifact.signer?.title||needsTitle)&&h('label',null,'Your title ',h('input',{'aria-label':'Your title',value:signerTitle,maxLength:128,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setSignerTitle(event.target.value)})),
        forCompany&&h('label',null,h('input',{type:'checkbox','aria-label':'Authorized to sign',checked:authority,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setAuthority(event.target.checked)}),` I am authorized to sign on behalf of ${forCompany}.`)),
      pageCount>0&&h('p',{className:'esign-viewed','aria-label':'Pages viewed'},`Viewed ${Math.min(viewed,pageCount)} of ${pageCount} ${pageCount===1?'page':'pages'}`),
      h('div',{className:'esign-step-actions'},
        h('button',{type:'button',className:'esign-continue',disabled:!authorityReady,onClick:()=>{setStep(verified?3:2);if(!verified)setMessage("Confirm it's you with a code we email you.");}},'Continue')),
      declineControls),
    artifact && rendered && step===3 && h('section',{className:'esign-signing-panel'},
      fields.length>0 && artifact.recipientName && h('p',null,'Recipient: ',artifact.recipientName,' — role: ',artifact.role),
      fields.length>0 && h('p',null,'Type uppercase and lowercase Latin letters and single spaces. This text is separate from the recipient identity. Preview is generated by the server.'),
      ...fields.map((field,index)=>{const props={key:field.id,field,index,role:artifact.role,multiple:fields.length>1,value:signatures[field.id]??'',token,disabled:signing,onChange:(value:string)=>{if(signingLock.current)return;setSignatures(old=>({...old,[field.id]:value}));setPreviews(old=>({...old,[field.id]:''}));setImageUrls(old=>({...old,[field.id]:''}));},onReady:(value:string,url:string,receipt?:string)=>{setPreviews(old=>({...old,[field.id]:value}));setImageUrls(old=>({...old,[field.id]:url}));if(receipt&&field.type==='Title')setTextReceipts(old=>({...old,[field.id]:receipt}));}};return field.type==='Title'||field.type==='Date signed'?h(V3TextInput,{...props,fixed:field.type==='Title',onSize:(size:{width:number;height:number})=>setSignatureSizes(old=>({...old,[field.id]:size})),version:datePreviewVersion,preview:async(text:string)=>{const response=await request('/v1/signing/text-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fieldId:field.id,...(field.type==='Title'?{text}:{})})});const width=Number(response.headers.get('X-Text-Width')),height=Number(response.headers.get('X-Text-Height'));if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid preview geometry');return {blob:await response.blob(),previewId:response.headers.get(field.type==='Title'?'X-Text-Preview':'X-Date-Preview-Id'),width,height};}}):h(TypedSignatureInput,{...props,preview:async(text:string)=>{const response=await request('/v1/signing/signature-preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fieldId:field.id,text})});const receipt=response.headers.get('X-Signature-Preview')??'',width=Number(response.headers.get('X-Signature-Width')),height=Number(response.headers.get('X-Signature-Height'));if(!/^[a-f0-9]{64}$/.test(receipt))throw new Error('Invalid preview receipt');if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid preview geometry');return {blob:await response.blob(),width,height,receipt};},onSize:(size:{width:number;height:number;receipt:string})=>{setSignatureSizes(old=>({...old,[field.id]:size}));setSignatureReceipts(old=>({...old,[field.id]:size.receipt}));}});}),
      fields.some(f=>f.type==='Date signed')&&h('button',{type:'button',disabled:signing,onClick:()=>{if(signingLock.current)return;const dates=fields.filter(f=>f.type==='Date signed');setPreviews(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setImageUrls(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setConsent(false);setDatePreviewVersion(v=>v+1);}},'Refresh date previews'),
      artifact.disclosure&&h('section',{'aria-label':'Consent to use electronic records and signatures',style:{border:'1px solid #d0d7de',borderRadius:6,padding:'0.75rem 1rem',margin:'0.75rem 0',whiteSpace:'pre-line',fontSize:'0.9rem'}},artifact.disclosure.text),
      artifact.intent&&h('p',{className:'esign-intent'},artifact.intent),
      h('p',{className:'esign-signed-by'},signedByLine(signingAs,signerTitle,forCompany)),
      h('aside',{className:'esign-next','aria-label':'What happens next'},
        h('strong',null,'What happens next'),
        h('p',null,'Anyone else who needs to sign is asked next. Once everyone has signed, each signer is emailed the signed copy with its certificate, which records who signed, when, and how they were verified.')),
      h('label',null,h('input',{type:'checkbox','aria-label':'Consent to sign',checked:consent,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>{if(!signingLock.current)setConsent(event.target.checked);}}),' I agree to sign this document.'),
      h('button',{className:'esign-sign',onClick:sign,disabled:signing||!consent||!signaturesReady||!authorityReady,type:'button'},'Sign document'),
      h('div',{className:'esign-step-actions'},h('button',{type:'button',disabled:signing,onClick:()=>setStep(1)},'Back')))),
    rendered&&fields.map((field,index)=>pageHosts[field.page-1]&&createPortal(h('div',{'data-signature-field':field.id,'aria-label':`${artifact?.role ? `${artifact.role} ${field.type==='Title'?'title':field.type==='Date signed'?'date signed':'signature'}${fields.length>1?` ${index+1}`:""}` : `${field.type||'Signature'} field ${index+1}`} on page ${field.page}, ${field.required?'required':'optional'}`,role:'region',style:{position:'absolute',boxSizing:'border-box',left:`${field.rect.x*100}%`,top:`${field.rect.y*100}%`,width:`${field.rect.width*100}%`,height:`${field.rect.height*100}%`,outline:'2px dashed #135c9b',outlineOffset:'0px',lineHeight:'normal',overflow:'visible'}},imageUrls[field.id]&&h('img',{src:imageUrls[field.id],alt:'',style:{position:'absolute',inset:0,width:`${(signatureSizes[field.id]?.width??0)*100}%`,height:`${(signatureSizes[field.id]?.height??0)*100}%`,objectFit:'contain',objectPosition:'left top'}})),pageHosts[field.page-1],field.id)));

}

function TypedSignatureInput({field,index,role,multiple,value,token,disabled,preview,onChange,onReady,onSize}:{field:SignatureField;index:number;role?:string;multiple:boolean;value:string;token:string;disabled:boolean;preview:(text:string)=>Promise<{blob:Blob;width:number;height:number;receipt:string}>;onSize:(size:{width:number;height:number;receipt:string})=>void;onChange:(value:string)=>void;onReady:(value:string,url:string)=>void}) {
 const [url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true,objectUrl='';setUrl('');setError('');
  if(/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value)&&value.length<=64)preview(value).then(({blob,width,height,receipt})=>{if(!active)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);onSize({width,height,receipt});onReady(value,objectUrl);}).catch(()=>{if(active)setError('Signature cannot fit safely. Shorten it or ask the template editor to move the field.');});
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[value,token,field.id]);
 return h('div',null,h('label',null,`${role ? `${role} signature${multiple?` ${index+1}`:""}` : `Signature field ${index+1}`} on page ${field.page}${field.required?' (required)':' (optional)'} `,h('input',{'aria-label':`${role ? `${role} signature${multiple?` ${index+1}`:""}` : `Signature field ${index+1}`} on page ${field.page}`,value,disabled,maxLength:64,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>onChange(e.target.value)})),error&&h('p',{role:'alert'},error),url&&h('img',{src:url,alt:`Signature preview for field ${index+1} on page ${field.page}`,style:{maxWidth:'100%',height:'44px'}}));
}

function V3TextInput({field,index,role,multiple,value,token,disabled,version,preview,onChange,onReady,onSize,fixed=false}:{fixed?:boolean;field:SignatureField;index:number;role?:string;multiple:boolean;value:string;token:string;disabled:boolean;version:number;preview:(text:string)=>Promise<{blob:Blob;previewId:string|null;width:number;height:number}>;onSize:(size:{width:number;height:number})=>void;onChange:(value:string)=>void;onReady:(value:string,url:string,receipt?:string)=>void}) {
 const date=field.type==='Date signed',label=`${role ? `${role} title${multiple?` ${index+1}`:''}` : `Title field ${index+1}`} on page ${field.page}`;
 const [url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true,objectUrl='';setUrl('');setError('');
  if(date||(value.length>0&&value.length<=128&&value.trim()===value&&/^[\x20-\x7e]+$/.test(value)))preview(value).then(async({blob,previewId,width,height})=>{if(!active||!previewId||(date?!/^[a-f0-9-]{36}$/.test(previewId):!/^[a-f0-9]{64}$/.test(previewId)))return;objectUrl=URL.createObjectURL(blob);const image=new Image();image.src=objectUrl;await image.decode();if(!active)return;setUrl(objectUrl);onSize({width,height});onReady(date?previewId!:value,objectUrl,previewId!);}).catch(error=>{if(active)setError(error instanceof RequestFailed&&error.code==='title_does_not_fit'?(fixed?'Your title does not fit this field. Shorten it on Review.':'Title does not fit this field. Shorten the title.'):error instanceof RequestFailed&&error.code==='title_field_too_small'?'Title field is too small. Ask the template editor to resize it.':'Preview unavailable. Change the input or retry.');});
  else if(fixed&&value)setError('This field takes English letters, digits and common punctuation only. Change your title on Review.');
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[value,token,field.id,version]);
 return h('div',null,fixed?h('p',{'data-field-label':field.id},`${label}: `,h('strong',null,value||'(no title)'),' (your title from Review)'):date?h('p',{'data-field-label':field.id},`${role ? `${role} date signed` : 'Date signed'} on page ${field.page}. Date preview from server (UTC). Refresh if the date changes or the preview expires.`):h('label',{'data-field-label':field.id},label,field.required?' (required)':' (optional)',' ',h('input',{'aria-label':label,value,disabled,maxLength:128,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>onChange(e.target.value)})),error&&h('p',{role:'alert'},error),url&&h('img',{src:url,alt:date?'Server date preview':`Title preview for field ${index+1}`,style:{maxWidth:'100%',height:'44px'}}));
}
