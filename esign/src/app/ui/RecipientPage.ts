import React, { useEffect, useRef, useState } from 'react';
import {createPortal} from 'react-dom';
import { signingHost, type SigningHostMessage } from './signing-host-protocol.ts';
import { Button } from '../components/ui/button.ts';
import { Input, checkClass } from '../components/ui/input.ts';
import { Textarea } from '../components/ui/textarea.ts';
import { SigningHelp } from './SigningHelp.ts';
const h = React.createElement;
/**
 * Who frames this page, as the browser tells it: the framing page's origin (location.ancestorOrigins
 * where supported, else the referrer's origin), or '' when the page isn't framed or the browser
 * doesn't say, plus every ancestor's origin where the browser lists them. The exchange refuses a framed page with an
 * ancestor that isn't allowed (signing-page.ts).
 */
export function embedding(win: { parent: unknown; location: { ancestorOrigins?: { length: number; [index: number]: string } } }, referrer: string): { embedded: boolean; embedder: string; embedders?: string[] } {
  const embedded = !!win.parent && win.parent !== win;
  if (!embedded) return { embedded, embedder: '' };
  const ancestors = win.location.ancestorOrigins;
  // Every ancestor where the browser lists them (Chromium, Safari): the exchange checks each, not only the nearest. It
  // accepts at most ten, so the page sends up to eleven: a deeper nesting is refused there, never cut short here.
  if (ancestors?.length) { const embedders = Array.from({ length: Math.min(ancestors.length, 11) }, (_, i) => ancestors[i] ?? ''); return { embedded, embedder: embedders[0] ?? '', embedders }; }
  try { return { embedded, embedder: referrer ? new URL(referrer).origin : '' }; } catch { return { embedded, embedder: '' }; }
}
class RequestFailed extends Error {readonly status:number;readonly code:string;readonly detail:Record<string,unknown>;constructor(status:number,code='',detail:Record<string,unknown>={}){super('Request failed');this.status=status;this.code=code;this.detail=detail;}}

type SignatureField = {id:string;type:'Signature'|'Title'|'Date signed';page:number;required:boolean;rect:{x:number;y:number;width:number;height:number}};
/** The consent to sign electronically, as the server words it (src/disclosure.ts). */
type Disclosure = {version:string;text:string};
/** The host's statement of how it signed the recipient in (src/signer-facts.ts). */
type HostAuthentication = {method:string;provider?:string;domain?:string;signedInAt?:string};
type Artifact = {id:string;sha256:string;verified?:boolean;fields?:SignatureField[];recipientName?:string;role?:string;disclosure?:Disclosure;signer?:{title?:string;onBehalfOf?:string};intent?:string;signerName?:string;documentName?:string;recipientEmail?:string;
  documentVersion?:{label:string;publishedAt?:string};sender?:{name:string;organization?:string};hostAuthentication?:HostAuthentication;
  signers?:{before:number;after:number;next?:{name:string;organization?:string}};afterSigning?:string[]};
/** A file name for the downloaded copy: the document's name, else "document". */
const pdfFileName=(name?:string)=>`${(name??'').replace(/[^A-Za-z0-9 ._-]+/g,'').trim().slice(0,100)||'document'}.pdf`;
/** The name a signature is credited to on the page; the product named under every preview. */
const SIGNED_THROUGH='Esign';
/** "Ana Ribeiro · Partner Manager, Northbeam Consulting · Signed electronically through Esign". */
export function signatureCaption(name:string,title:string,company?:string):string{
  const role=[title.trim(),company?.trim()].filter(Boolean).join(', ');
  return [name.trim(),role,`Signed electronically through ${SIGNED_THROUGH}`].filter(Boolean).join(' · ');
}
/** "9f2c 41ae 07d3 … 5b19 a71e": a SHA-256 short enough to read out and compare. */
export function fingerprintText(sha256:string):string{
  const hex=sha256.toLowerCase();if(!/^[0-9a-f]{64}$/.test(hex))return sha256;
  const groups=hex.match(/.{4}/g)!;return `${groups.slice(0,3).join(' ')} … ${groups.slice(-2).join(' ')}`;
}
/** "Sep 2, 2026" (UTC), or '' when the date is not one. */
export function dateText(iso?:string):string{
  const d=new Date(iso??'');if(Number.isNaN(d.getTime()))return '';
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
}
/** "Google Workspace · northbeam.io · 10:31 UTC": how the host says the signer signed in. */
export function hostSignInText(auth:HostAuthentication):string{
  const how=auth.provider??auth.method.replace(/_/g,' ').toLowerCase().replace(/^\w/,c=>c.toUpperCase());
  const at=new Date(auth.signedInAt??'');
  const time=Number.isNaN(at.getTime())?'':`${String(at.getUTCHours()).padStart(2,'0')}:${String(at.getUTCMinutes()).padStart(2,'0')} UTC`;
  return [how,auth.domain,time].filter(Boolean).join(' · ');
}
/** What happens once this signer signs: the copy, who signs next (or that nobody does), then the host's own lines. */
export function afterSigningLines(artifact:Pick<Artifact,'sender'|'signers'|'afterSigning'>):React.ReactNode[]{
  const sender=artifact.sender?.organization||artifact.sender?.name||'the sender',signers=artifact.signers;
  const lines:React.ReactNode[]=[`You and ${sender} get the signed PDF and its certificate of completion.`];
  if(signers&&signers.after>0){const next=signers.next;lines.push(next?.organization?`${next.organization} countersigns next.`:next?`${next.name} signs next.`:'The next signer is asked to sign.');}
  else if(signers&&signers.before===0)lines.push(h(React.Fragment,null,`${sender} countersign is `,h('strong',null,'not'),' required for this agreement.'));
  else if(signers)lines.push('Your signature completes the agreement.');
  return [...lines,...(artifact.afterSigning??[])];
}
type RenderDocument = (blob:Blob, container:HTMLElement, signal:AbortSignal)=>Promise<void>;
const defaultRender:RenderDocument=async (blob,container,signal)=>{const {renderPdf}=await import('./pdf');signal.throwIfAborted();return renderPdf(blob,container,signal);};
/** A code lasts as long as the Worker keeps it (OTP_TTL_MS). */
const CODE_TTL_MS=10*60*1000, CODE_LENGTH=6;
/** Sends are a minute apart (the Worker's OTP_RESEND_MS). */
const RESEND_MS=60*1000;
/** "9:05": minutes and seconds left. */
export function codeTimeLeft(ms:number):string{const s=Math.max(0,Math.ceil(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
/**
 * The next code after typing `raw` into box `index`: one digit per box, filled left to right.
 * More than two digits at once is a paste (or autofill) and fills from that box on.
 */
export function nextCode(code:string,index:number,raw:string):string{
  const typed=codeDigits(raw),at=Math.min(index,code.length);
  if(!typed)return code.slice(0,at);
  const current=code[at]??'';
  const digit=typed.length===2&&current?(typed.replace(current,'')||typed.slice(-1)):typed;
  return (code.slice(0,at)+(digit.length>2?digit:digit.slice(-1))+(digit.length>2?'':code.slice(at+1))).slice(0,CODE_LENGTH);
}
/** The ASCII digits in `raw`; full-width digits (an East Asian input method) count as digits. */
export function codeDigits(raw:string):string{return raw.normalize('NFKC').replace(/\D/g,'');}
/**
 * What the page says when a code cannot be sent or is not accepted, from the Worker's error
 * (signing-routes.ts), and whether the boxes are cleared for a new entry. Unknown failures (a lost
 * response) keep the code, since entering it again may still work.
 */
export function codeProblem(status:number,code:string,detail:Record<string,unknown>,when:'send'|'verify'):{text:string;clear:boolean;retryAfterMs:number}{
  const wait=Number(detail.retryAfterSeconds),retryAfterMs=Number.isFinite(wait)&&wait>0?wait*1000:0,inTime=retryAfterMs?` in ${codeTimeLeft(retryAfterMs)}`:' shortly';
  if(code==='otp_rate_limited')return {text:`Too many codes were asked for. You can ask for a new code${inTime}.`,clear:false,retryAfterMs};
  if(code==='otp_attempts_exhausted')return {text:`Too many wrong codes. You can ask for a new code${inTime}.`,clear:true,retryAfterMs};
  if(code==='invalid_otp'){const left=Number(detail.attemptsLeft);return {text:`That code is not right. Use the code in the latest email.${Number.isInteger(left)&&left>0?` ${left} ${left===1?'try':'tries'} left.`:''}`,clear:true,retryAfterMs:0};}
  if(code==='otp_expired')return {text:'This code has expired. Ask for a new code.',clear:true,retryAfterMs:0};
  if(code==='otp_superseded')return {text:'A newer code was sent for this signing in another window, so this one no longer works. Ask for a new code to continue here.',clear:true,retryAfterMs:0};
  if(code==='invalid_session'||(status===401&&when==='send'))return {text:'This signing session has ended. Close and open the signing page again.',clear:false,retryAfterMs:0};
  return when==='send'?{text:'Could not send a code. Wait a minute, then ask for a new code.',clear:false,retryAfterMs:0}:{text:'Code verification unavailable. Retry the same code.',clear:false,retryAfterMs:0};
}
/** Six boxes, one digit each; typing moves on, Backspace moves back, a paste fills them all. */
function CodeBoxes({value,onChange,disabled,onEnter,focusSignal}:{value:string;onChange:(code:string)=>void;disabled:boolean;onEnter:()=>void;focusSignal:number}){
  const boxes=useRef<(HTMLInputElement|null)[]>([]);
  const focus=(i:number)=>{const box=boxes.current[Math.max(0,Math.min(CODE_LENGTH-1,i))];if(typeof box?.focus==='function')box.focus();};
  // A code was just sent, or the last one was refused: the next digit goes in without a click.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses on the signal only
  useEffect(()=>{if(focusSignal&&!disabled)focus(value.length);},[focusSignal,disabled]);
  return h('div',{className:'esign-code-boxes',role:'group','aria-label':'Verification code'},...Array.from({length:CODE_LENGTH},(_,i)=>h(Input,{
    key:i,ref:(el:HTMLInputElement|null)=>{boxes.current[i]=el;},'aria-label':`Digit ${i+1} of ${CODE_LENGTH}`,value:value[i]??'',disabled,
    inputMode:'numeric',autoComplete:i===0?'one-time-code':'off',
    onFocus:(e:React.FocusEvent<HTMLInputElement>)=>{if(i>value.length){focus(value.length);return;}e.target.select();},
    onChange:(e:React.ChangeEvent<HTMLInputElement>)=>{const next=nextCode(value,i,e.target.value);onChange(next);if(next.length>value.length)focus(next.length);},
    onPaste:(e:React.ClipboardEvent<HTMLInputElement>)=>{e.preventDefault();const next=(value.slice(0,Math.min(i,value.length))+codeDigits(e.clipboardData.getData('text'))).slice(0,CODE_LENGTH);onChange(next);focus(next.length);},
    onKeyDown:(e:React.KeyboardEvent<HTMLInputElement>)=>{
      if(e.key==='Backspace'&&!value[i]&&i>0){e.preventDefault();onChange(value.slice(0,i-1));focus(i-1);}
      else if(e.key==='ArrowLeft'){e.preventDefault();focus(i-1);}
      else if(e.key==='ArrowRight'){e.preventDefault();focus(Math.min(i+1,value.length));}
      else if(e.key==='Enter'&&value.length===CODE_LENGTH){e.preventDefault();onEnter();}},
  })));
}
/** Shown inside a host's frame: the host's dialog already titles it, so the page heading is for screen readers only. */
const embedded=(()=>{try{return typeof window!=='undefined'&&window.self!==window.top;}catch{return true;}})();
/** A signature's name: Latin letters and single spaces, at most 64 characters (what the server draws). */
const SIGNATURE_NAME=/^[A-Za-z]+(?: [A-Za-z]+)*$/;
const fact=(label:string,value:React.ReactNode)=>h('div',{className:'esign-fact'},h('dt',null,label),h('dd',null,value));

export function RecipientPage({renderDocument=defaultRender}:{renderDocument?:RenderDocument} = {}) {
  const container=useRef<HTMLDivElement>(null), renderController=useRef<AbortController|null>(null), loadSequence=useRef(0),api=useRef(''),signingLock=useRef(false),host=useRef('');
  useEffect(()=>()=>{loadSequence.current++;},[]);
  const [token,setToken]=useState(''), [otp,setOtp]=useState(''), [message,setMessage]=useState('Opening the signing session…');
  const [artifact,setArtifact]=useState<Artifact|null>(null), [pdf,setPdf]=useState<Blob|null>(null), [consent,setConsent]=useState(false), [sent,setSent]=useState(false);
  const [rendered,setRendered]=useState(false),[pageHosts,setPageHosts]=useState<HTMLElement[]>([]),[imageUrls,setImageUrls]=useState<Record<string,string>>({});
  const [textReceipts,setTextReceipts]=useState<Record<string,string>>({});
  const [signatureReceipts,setSignatureReceipts]=useState<Record<string,string>>({});
  const [signatureSizes,setSignatureSizes]=useState<Record<string,{width:number;height:number}>>({});
  const [signatures,setSignatures]=useState<Record<string,string>>({}),[previews,setPreviews]=useState<Record<string,string>>({}),[datePreviewVersion,setDatePreviewVersion]=useState(0);
  // Why a field's preview failed (a name or title that does not fit), by field id.
  const [fieldErrors,setFieldErrors]=useState<Record<string,string>>({});
  const [signing,setSigning]=useState(false),[verified,setVerified]=useState(false), [finished,setFinished]=useState(false), [messageId,setMessageId]=useState(''), [testOtp,setTestOtp]=useState('');
  // When the code was sent (its expiry counts down from there), whether it went by email, and the clock.
  // What went wrong with the code, shown beside the boxes; when Resend works again; a send in flight; focus the boxes.
  const [codeNote,setCodeNote]=useState(''),[resendAt,setResendAt]=useState(0),[sending,setSending]=useState(false),[focusSignal,setFocusSignal]=useState(0);
  const [sentAt,setSentAt]=useState(0),[emailed,setEmailed]=useState(false),[testMailbox,setTestMailbox]=useState(false),[now,setNow]=useState(()=>Date.now()),autoSent=useRef(false);
  // Signing for a company: the signer's title (the host's, editable) and their confirmation of authority.
  const [signerTitle,setSignerTitle]=useState(''),[authority,setAuthority]=useState(false);
  // The name the signer adopts: it fills every one of their Signature fields.
  const [fullName,setFullName]=useState('');
  // Declining instead of signing, with a reason; the electronic records disclosure, opened from Sign.
  const [declining,setDeclining]=useState(false),[declineReason,setDeclineReason]=useState(''),[declineBusy,setDeclineBusy]=useState(false),[showDisclosure,setShowDisclosure]=useState(false),[showHelp,setShowHelp]=useState(false);
  // What the signer is about to sign: how many pages, the page in view, and the document itself to keep a copy before signing.
  const [pageCount,setPageCount]=useState(0),[currentPage,setCurrentPage]=useState(1),[pdfUrl,setPdfUrl]=useState('');
  // The three steps (review, confirm it's you, sign); a decline waiting for the code; pages viewed.
  const [step,setStep]=useState<1|2|3>(1),[pendingDecline,setPendingDecline]=useState(false),[viewed,setViewed]=useState(0),[pageEls,setPageEls]=useState<Element[]>([]);
  // The host refused the document before the code (it requires the code first), or loading failed.
  const [docNeedsCode,setDocNeedsCode]=useState(false),[docFailed,setDocFailed]=useState(false);
  useEffect(()=>{if(!pdf){setPdfUrl('');return;}const url=URL.createObjectURL(pdf);setPdfUrl(url);return ()=>URL.revokeObjectURL(url);},[pdf]);
  useEffect(()=>{setSignerTitle(artifact?.signer?.title??'');setAuthority(false);setFullName(artifact?.signerName??artifact?.recipientName??'');},[artifact?.id]);
  const forCompany=artifact?.signer?.onBehalfOf;
  // Title fields show the signer's title, so a template with one needs a title.
  const titleFieldIds=(artifact?.fields??[]).filter(f=>f.type==='Title').map(f=>f.id),needsTitle=titleFieldIds.length>0;
  const titleShown=!!(forCompany||artifact?.signer?.title||needsTitle);
  const authorityReady=(!forCompany||(signerTitle.trim()!==''&&authority))&&(!needsTitle||signerTitle.trim()!=='');
  // Every Title field carries the signer's title; a change asks for new previews.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the field ids
  useEffect(()=>{if(!needsTitle)return;const title=signerTitle.trim();
    setSignatures(old=>titleFieldIds.every(id=>old[id]===title)?old:{...old,...Object.fromEntries(titleFieldIds.map(id=>[id,title]))});},[signerTitle,titleFieldIds.join()]);
  // Every Signature field carries the adopted name; a change drops the old previews.
  const signatureFieldIds=(artifact?.fields??[]).filter(f=>f.type==='Signature').map(f=>f.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the field ids
  useEffect(()=>{if(!signatureFieldIds.length)return;
    setSignatures(old=>signatureFieldIds.every(id=>old[id]===fullName)?old:{...old,...Object.fromEntries(signatureFieldIds.map(id=>[id,fullName]))});
    setPreviews(old=>signatureFieldIds.every(id=>old[id]===fullName||!old[id])?old:{...old,...Object.fromEntries(signatureFieldIds.filter(id=>old[id]!==fullName).map(id=>[id,'']))});},[fullName,signatureFieldIds.join()]);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.hash.slice(1));const code=params.get('code');
    window.history.replaceState(null,'',window.location.pathname);
    // The API is this page's own origin (the app). The host told when the signer closes, signs or
    // declines must be one the app lets frame this page (GET /api/public/signing-page).
    api.current=window.location.origin;
    if (!code) {setMessage('No recipient code provided.');return;}
    const frame=embedding(window,window.document?.referrer??'');
    fetch(`${api.current}/api/public/signing-page`,{cache:'no-store'})
      .then(async response=>{
        const page=response.ok?await response.json() as {hosts?:unknown}:{};
        const hosts=Array.isArray(page.hosts)?page.hosts.filter((h):h is string=>typeof h==='string').join(' '):'';
        try {host.current=signingHost(params.get('host'),hosts,frame.embedded,frame.embedder||undefined);} catch {host.current='';}
        const exchange=await fetch(`${api.current}/api/public/page-sessions/exchange`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,...frame})});
        if(!exchange.ok) throw new Error();const value=await exchange.json() as {token:string};setToken(value.token);setMessage('Loading document…');
      })
      .catch(()=>setMessage('Session unavailable or expired.'));
  },[]);
  /** Tells the host (when there is one) that the signer closed the page, signed or declined. */
  const notifyHost=(msg:SigningHostMessage)=>{if(!host.current)return;try{window.parent.postMessage(msg,host.current);}catch{/* The host is gone: nothing to tell. */}};
  useEffect(()=>{
    if (!pdf || !container.current) return;
    let active=true;const target=container.current;const detached=target.ownerDocument.createElement('div');
    const controller=new AbortController();renderController.current=controller;target.replaceChildren();
    renderDocument(pdf,detached,controller.signal).then(()=>{
      if(active && !controller.signal.aborted) {
        const pages=typeof detached.querySelectorAll==='function'?Array.from(detached.querySelectorAll('canvas')):[];
        setPageCount(pages.length);setPageEls(pages);setCurrentPage(1);
        const fields=artifact?.fields??[];let hosts:HTMLElement[]=[];
        if(fields.length){
          const canvases=Array.from(detached.querySelectorAll('canvas'));
          if(!canvases.length||fields.some(f=>!f.rect||!Number.isInteger(f.page)||f.page<1||f.page>canvases.length||![f.rect.x,f.rect.y,f.rect.width,f.rect.height].every(Number.isFinite)||f.rect.x<0||f.rect.y<0||f.rect.width<=0||f.rect.height<=0||f.rect.x+f.rect.width>1||f.rect.y+f.rect.height>1))throw new Error('Invalid field layout');
          hosts=canvases.map((canvas,index)=>{const page=detached.ownerDocument.createElement('div');page.dataset.signaturePage=String(index+1);page.style.cssText='position:relative;display:table;max-width:100%;margin:0 auto 24px;line-height:0';canvas.replaceWith(page);page.appendChild(canvas);canvas.style.display='block';return page;});
        }
        target.replaceChildren(detached);setPageHosts(hosts);setMessage('');setRendered(true);
      }
    }).catch(()=>{if(active && !controller.signal.aborted) {target.replaceChildren();setPdf(null);setArtifact(null);setDocFailed(true);setMessage('Document unavailable. Retry loading it, or request a new view if the session expired.');}});
    return ()=>{active=false;controller.abort();if(renderController.current===controller) renderController.current=null;target.replaceChildren();};
  },[pdf,renderDocument]);
  async function request(path:string, init:RequestInit={}) {
    const response=await fetch(`${api.current}${path}`,{...init,headers:{...init.headers,'x-esign-session':token}});
    if(!response.ok){let code='',detail:Record<string,unknown>={};try{const body=await response.json() as Record<string,unknown>;if(body&&typeof body==='object'){detail=body;if(typeof body.error==='string')code=body.error;}}catch{}throw new RequestFailed(response.status,code,detail);}return response;
  }
  async function send(announce=true) {if(sending)return;setSending(true);setCodeNote('');try {
    const result=await (await request('/api/public/signing/otp',{method:'POST'})).json() as {messageId:string;testOtp?:string;emailed?:boolean;testMailbox?:boolean};
    const at=Date.now();
    setMessageId(result.messageId);setTestOtp(result.testOtp ?? '');setSent(true);setSentAt(at);setNow(at);setOtp('');setEmailed(!!result.emailed);setTestMailbox(!!result.testMailbox);
    // The Worker allows the next send a minute later (OTP_RESEND_MS).
    setResendAt(at+RESEND_MS);setFocusSignal(n=>n+1);
    if(announce)setMessage(result.emailed?'Verification code sent by email.':'Test code saved to the test mailbox.');
  } catch (error) {
    const problem=error instanceof RequestFailed?codeProblem(error.status,error.code,error.detail,'send'):codeProblem(0,'',{},'send');
    setCodeNote(problem.text);setMessage('');if(problem.retryAfterMs){const at=Date.now();setResendAt(at+problem.retryAfterMs);setNow(at);}
  } finally {setSending(false);}}
  // Reaching "Confirm it's you" sends the code once; Resend asks for another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: send once per page session
  useEffect(()=>{if(!token||verified||finished||autoSent.current||(step!==2&&!docNeedsCode))return;autoSent.current=true;void send(docNeedsCode);},[token,step,docNeedsCode,verified,finished]);
  // The countdown to the code's expiry, while one is waiting to be entered.
  useEffect(()=>{if((!sent&&resendAt<=Date.now())||verified)return;const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[sent,verified,resendAt]);
  async function loadDocument() {
    const sequence=++loadSequence.current;renderController.current?.abort();container.current?.replaceChildren();setDocFailed(false);
    setRendered(false);setConsent(false);setSignatures({});setPreviews({});setPageHosts([]);setImageUrls({});setSignatureSizes({});setSignatureReceipts({});setTextReceipts({});setFieldErrors({});setArtifact(null);setPdf(null);setMessage('Loading document…');
    try {
      const info=await (await request('/api/public/signing/current')).json() as Artifact;
      if(sequence!==loadSequence.current) return;
      const blob=await (await request('/api/public/signing/pdf')).blob();
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
  // The page most in view is the one the toolbar names.
  useEffect(()=>{
    if(!rendered||!pageEls.length||!token||typeof IntersectionObserver==='undefined')return;
    const total=pageEls.length,pending=new Set<number>(),timers=new Map<number,ReturnType<typeof setTimeout>>(),ratios=new Map<number,number>();let sending=false,closed=false;
    const flush=async():Promise<void>=>{
      if(sending||closed||!pending.size)return;sending=true;const pages=[...pending];pending.clear();
      try {const body=await (await request('/api/public/signing/page-views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pages,total})})).json() as {viewed?:unknown};if(typeof body.viewed==='number'&&!closed)setViewed(body.viewed);}
      catch {/* Best-effort: the next view tries again. */for(const p of pages)pending.add(p);}
      finally {sending=false;}
    };
    // On screen: half the page, or (a page taller than the view) half the view's height.
    const root=container.current&&container.current.scrollHeight>container.current.clientHeight?container.current:null;
    const observer=new IntersectionObserver(entries=>{for(const entry of entries){const page=pageEls.indexOf(entry.target)+1;if(page<1)continue;
      ratios.set(page,entry.isIntersecting?entry.intersectionRatio:0);
      const fillsView=!!entry.rootBounds&&entry.intersectionRect.height>=entry.rootBounds.height*0.5;
      if(entry.isIntersecting&&(entry.intersectionRatio>=0.5||fillsView)){if(!timers.has(page))timers.set(page,setTimeout(()=>{pending.add(page);void flush();},1000));}
      else {clearTimeout(timers.get(page));timers.delete(page);}}
      let best=0,bestRatio=0;for(const [page,ratio] of ratios)if(ratio>bestRatio){best=page;bestRatio=ratio;}
      if(best&&!closed)setCurrentPage(best);},{root,threshold:Array.from({length:21},(_,i)=>i/20)});
    for(const el of pageEls)observer.observe(el);
    return ()=>{closed=true;observer.disconnect();for(const t of timers.values())clearTimeout(t);};
  },[rendered,pageEls,token]);
  async function verify() {if(otp.length!==CODE_LENGTH)return;try {
    await request('/api/public/signing/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})});
    setVerified(true);setOtp('');setTestOtp('');setMessage('');setCodeNote('');
  } catch (error) {
    const problem=error instanceof RequestFailed?codeProblem(error.status,error.code,error.detail,'verify'):codeProblem(0,'',{},'verify');
    setCodeNote(problem.text);setMessage('');
    if(problem.retryAfterMs){const at=Date.now();setResendAt(at+problem.retryAfterMs);setNow(at);}
    if(problem.clear){setOtp('');setFocusSignal(n=>n+1);}
    return;}
    // A host that needed the code first shows the document now.
    if(docNeedsCode||!artifact){await loadDocument();setStep(1);return;}
    if(pendingDecline){setPendingDecline(false);setStep(1);await decline();return;}
    setStep(3);}
  const fields=artifact?.fields??[];
  const signaturesReady=fields.every(field=>{const value=signatures[field.id]??'';if(field.type==='Date signed')return /^\d{4}-\d{2}-\d{2}$/.test(previews[field.id]??'');if(!field.required&&!value)return true;return (field.type==='Title'?value.length<=128&&value.length>0&&value.trim()===value&&/^[\x20-\x7e]+$/.test(value):SIGNATURE_NAME.test(value)&&value.length<=64)&&previews[field.id]===value;});
  async function sign() {if(signingLock.current || !artifact || !consent || !rendered || !signaturesReady || !authorityReady)return;signingLock.current=true;setSigning(true);try {
    await request('/api/public/signing/sign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true,...(forCompany||signerTitle.trim()?{title:signerTitle.trim()}:{}),...(forCompany?{authorityConfirmed:true}:{}),...(artifact.disclosure?{disclosureVersion:artifact.disclosure.version}:{}),signaturePreviews:signatureReceipts,textPreviews:textReceipts,...(fields.length?{signatures:Object.fromEntries(fields.filter(f=>f.type!=='Date signed'&&signatures[f.id]).map(f=>[f.id,signatures[f.id]]))}:{}),...(fields.some(f=>f.type==='Date signed')?{datePreviews:Object.fromEntries(fields.filter(f=>f.type==='Date signed').map(f=>[f.id,previews[f.id]]))}:{})})});
    setArtifact(null);setPdf(null);setRendered(false);setFinished(true);setMessage('Signature recorded.');
    notifyHost({type:'esign.signing.finished',outcome:'signed'});
  } catch (error) {if(error instanceof RequestFailed&&error.status===409&&fields.some(f=>f.type==='Date signed')){const dates=fields.filter(f=>f.type==='Date signed');setPreviews(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setImageUrls(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setConsent(false);setDatePreviewVersion(v=>v+1);setMessage(error.code==='date_changed'?'The date changed (UTC). Review and sign again.':'Signature was rejected. Review the document and sign again.');}else setMessage('Signature rejected or unavailable. Check that it fits without overlapping another field, then retry.');}finally{signingLock.current=false;setSigning(false);}}
  async function decline() {if(declineBusy||!declineReason.trim())return;setDeclineBusy(true);try {
    await request('/api/public/signing/decline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:declineReason.trim()})});
    setArtifact(null);setPdf(null);setRendered(false);setFinished(true);setDeclining(false);setMessage('You declined to sign. The sender has been told.');
    notifyHost({type:'esign.signing.finished',outcome:'declined'});
  } catch {setMessage('Declining did not go through. Try again.');} finally {setDeclineBusy(false);}}

  const signingAs = artifact?.signerName ?? artifact?.recipientName ?? '';
  const sender = artifact?.sender?.organization || artifact?.sender?.name || '';
  const versionLabel = artifact?.documentVersion?.label;
  const steps:[1|2|3,string][]=[[1,'Review'],[2,"Confirm it's you"],[3,'Sign']];
  // shadcn's Button: the step's main action is the default (primary) variant, Decline a destructive one, the rest outline
  // or ghost. The esign-* classes stay as hooks for the host's tests.
  const button=(label:string,onClick:()=>void,opts:{primary?:boolean;quiet?:boolean;disabled?:boolean;className?:string}={})=>{
    const danger=opts.className?.includes('esign-danger-fill')?'destructive':undefined;
    const variant=danger??(opts.primary?'default':opts.quiet?'ghost':'outline');
    const tone=opts.className?.split(' ').includes('esign-danger')?'text-destructive hover:bg-destructive/10 hover:text-destructive':'';
    return h(Button,{variant,className:[opts.primary?'esign-primary':opts.quiet?'esign-quiet':'',opts.className??'',tone].filter(Boolean).join(' ')||undefined,disabled:opts.disabled,onClick},label);};
  const linkButton=(label:string,onClick:(event:React.MouseEvent)=>void,disabled=false)=>
    h(Button,{variant:'link',className:'esign-link h-auto p-0 align-baseline',disabled,onClick},label);

  // The document's facts: its name, version, pages and fingerprint (both sides can later prove what was signed).
  const documentFacts=(published:boolean)=>artifact&&h('dl',{className:'esign-facts','aria-label':'Document details'},
    fact('Name',artifact.documentName||'Document'),
    versionLabel&&fact('Version',published&&dateText(artifact.documentVersion?.publishedAt)?`${versionLabel} · published ${dateText(artifact.documentVersion?.publishedAt)}`:versionLabel),
    pageCount>0&&fact('Pages',String(pageCount)),
    fact('Fingerprint (SHA-256)',h('span',{className:'esign-mono',title:artifact.sha256},fingerprintText(artifact.sha256))));
  const section=(label:string,...children:React.ReactNode[])=>h('section',{className:'esign-side-section','aria-label':label},h('h2',null,label),...children);
  const titleInput=(label:string)=>h('label',{className:'esign-field'},h('span',null,'Title'),h(Input,{'aria-label':label,value:signerTitle,maxLength:128,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setSignerTitle(event.target.value)}));

  const codeLeft=sentAt+CODE_TTL_MS-now, sentTo=artifact?.recipientEmail||'your email address', auth=artifact?.hostAuthentication;
  // Step 2: the host's sign-in (when it said how) and the emailed code.
  const verification = h('div',{className:'esign-verification'},
    h('h2',null,"Confirm it's you"),
    h('p',{className:'esign-sub'},auth?'This ties the signature to you. We check two things.':'This ties the signature to you. We check your email.'),
    auth&&h('div',{className:'esign-check-card esign-check-done','aria-label':'Sign-in'},
      h('span',{className:'esign-check-icon','aria-hidden':true},'✓'),
      h('div',null,h('p',{className:'esign-check-title'},`Signed in as ${artifact?.recipientEmail??'you'}`),h('p',{className:'esign-check-meta'},hostSignInText(auth)))),
    h('div',{className:'esign-check-card'},verified?h('p',{className:'esign-check-title'},'Your email address is confirmed.'):h('div',{className:'esign-code','data-test-message-id':messageId||undefined},
      h('p',{className:'esign-code-label'},sent?`Enter the 6-digit code we sent to ${sentTo}`:`Sending a 6-digit code to ${sentTo}…`),
      sent&&testMailbox&&h('p',{className:'esign-code-note'},"Test environment: the code goes to this environment's test mailbox, not to the signer."),
      testOtp&&h('p',{className:'esign-code-note'},'Local test verification code: ',testOtp,' (test only)'),
      h(CodeBoxes,{value:otp,onChange:(code:string)=>{setOtp(code);if(code)setCodeNote('');},disabled:!sent,onEnter:()=>void verify(),focusSignal}),
      codeNote&&h('p',{role:'alert',className:'esign-code-error'},codeNote),
      h('p',{className:'esign-code-meta'},
        sent&&(codeLeft>0?`Code expires in ${codeTimeLeft(codeLeft)}`:'This code has expired.'),sent&&' · ',
        linkButton(sending?'Sending…':now<resendAt?`Resend code in ${codeTimeLeft(resendAt-now)}`:'Resend code',()=>void send(),sending||now<resendAt)))),
    h('div',{className:'esign-why'},h('h3',null,'Why we ask'),
      h('p',null,auth?"Your sign-in and the email code are recorded in the agreement's audit trail, with the time, your IP address and browser. That record is what makes the signature hold up."
        :"The email code is recorded in the agreement's audit trail, with the time, your IP address and browser. That record is what makes the signature hold up."),
      h('p',null,`${sender||'The sender'} can require stronger checks, such as ID verification, for some documents.`)));

  // Step 3: the signature's preview (the server's image of the first Signature field, when the template places one).
  const firstSignature=fields.find(f=>f.type==='Signature'),previewUrl=firstSignature?imageUrls[firstSignature.id]:'';
  const nameError=fullName&&(!SIGNATURE_NAME.test(fullName)||fullName.length>64)?'Use English letters and single spaces only.':Object.entries(fieldErrors).find(([id,error])=>error&&signatureFieldIds.includes(id))?.[1]??'';
  const titleError=Object.entries(fieldErrors).find(([id,error])=>error&&titleFieldIds.includes(id))?.[1]??'';
  // The sentence the signer agrees to, with the document named in bold.
  const documentLabel=artifact?.documentName?`${artifact.documentName}${versionLabel?` (${versionLabel})`:''}`:'';
  const intent=artifact?.intent??'';const named=documentLabel?intent.indexOf(documentLabel):-1;
  const consentText=named>=0?h(React.Fragment,null,intent.slice(0,named),h('strong',null,documentLabel),intent.slice(named+documentLabel.length)):intent;
  const previewProps=(field:SignatureField)=>({key:field.id,field,token,
    onReady:(value:string,url:string,receipt?:string)=>{setPreviews(old=>({...old,[field.id]:value}));setImageUrls(old=>({...old,[field.id]:url}));if(receipt&&field.type==='Title')setTextReceipts(old=>({...old,[field.id]:receipt}));},
    onError:(error:string)=>setFieldErrors(old=>old[field.id]===error?old:{...old,[field.id]:error})});
  const fieldPreviews=fields.map(field=>field.type==='Signature'
    ?h(SignaturePreview,{...previewProps(field),value:signatures[field.id]??'',
      preview:async(text:string)=>{const response=await request('/api/public/signing/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fieldId:field.id,text})});const receipt=response.headers.get('X-Signature-Preview')??'',width=Number(response.headers.get('X-Signature-Width')),height=Number(response.headers.get('X-Signature-Height'));if(!/^[a-f0-9]{64}$/.test(receipt))throw new Error('Invalid preview receipt');if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid preview geometry');return {blob:await response.blob(),width,height,receipt};},
      onSize:(size:{width:number;height:number;receipt:string})=>{setSignatureSizes(old=>({...old,[field.id]:size}));setSignatureReceipts(old=>({...old,[field.id]:size.receipt}));}})
    :h(TextPreview,{...previewProps(field),value:field.type==='Title'?signatures[field.id]??'':'',version:datePreviewVersion,
      onSize:(size:{width:number;height:number})=>setSignatureSizes(old=>({...old,[field.id]:size})),
      preview:async(text:string)=>{const response=await request('/api/public/signing/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fieldId:field.id,...(field.type==='Title'?{text}:{})})});const width=Number(response.headers.get('X-Text-Width')),height=Number(response.headers.get('X-Text-Height'));if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid preview geometry');return {blob:await response.blob(),previewId:response.headers.get(field.type==='Title'?'X-Text-Preview':'X-Preview-Text'),width,height};}}));

  const ready=!!artifact&&rendered;
  const actions=h('div',{className:'esign-actions'},
    h('div',{className:'esign-actions-start'},
      ready&&step===1&&button('Decline to sign',()=>setDeclining(true),{quiet:true,className:'esign-danger',disabled:signing}),
      h('p',{role:'status',className:'esign-status'},message)),
    h('div',{className:'esign-actions-end'},
      token&&!artifact&&docFailed&&button('Retry document',()=>void loadDocument()),
      ready&&step===1&&host.current&&button('Cancel',()=>notifyHost({type:'esign.signing.cancel'})),
      ready&&step===1&&button('Continue',()=>{setStep(verified?3:2);},{primary:true,disabled:!authorityReady}),
      (step===2||(docNeedsCode&&!verified))&&artifact&&button('Back',()=>{setPendingDecline(false);setStep(1);}),
      (step===2||(docNeedsCode&&!verified))&&!verified&&button('Verify code',()=>void verify(),{primary:true,disabled:otp.length!==CODE_LENGTH}),
      step===2&&verified&&artifact&&button('Continue',()=>setStep(3),{primary:true}),
      ready&&step===3&&button('Back',()=>setStep(1),{disabled:signing}),
      ready&&step===3&&button('Sign document',()=>void sign(),{primary:true,className:'esign-sign',disabled:signing||!consent||!signaturesReady||!authorityReady})));

  const modal=(label:string,...children:React.ReactNode[])=>h('div',{className:'esign-modal-backdrop'},h('div',{className:'esign-modal',role:'dialog','aria-modal':true,'aria-label':label},...children));
  const showVerification=token&&!finished&&(step===2||(docNeedsCode&&!verified));

  return h('main',{className:embedded?'esign-recipient esign-embedded':'esign-recipient'},
    h('div',{className:'esign-header'},h('h1',null,'Sign document'),
      // The signer's help, in plain words: what the steps are, why the code, how to decline (SigningHelp.ts).
      !finished&&h(Button,{variant:'ghost',size:'sm',className:'esign-help-open ml-auto text-muted-foreground',onClick:()=>setShowHelp(true)},'About signing')),
    token && !finished && h('ol',{className:'esign-steps','aria-label':'Signing steps'},...steps.flatMap(([n,label],i)=>[
      i>0&&h('li',{key:`line-${n}`,className:'esign-step-line','aria-hidden':true}),
      h('li',{key:n,'aria-current':step===n?'step':undefined,className:step===n?'esign-step-current':step>n?'esign-step-done':undefined},h('span',{className:'esign-step-number'},step>n?'✓':String(n)),label)])),
    finished
      ? h('section',{className:'esign-finished'},h('p',{role:'status'},message))
      : h('div',{className:`esign-signing-workspace esign-at-step-${showVerification?2:step}`},
        // The document stays mounted through every step (rendered once; page views and previews kept); only Review shows it.
        token && (verified||!docNeedsCode) && h('div',{className:'esign-document'},
          ready&&h('div',{className:'esign-document-toolbar'},
            h('span',{className:'esign-document-name'},artifact.documentName||'Document'),
            pageCount>0&&h('span',{className:'esign-page-of'},`Page ${currentPage} of ${pageCount}`),
            pdfUrl&&h('a',{href:pdfUrl,download:pdfFileName(artifact.documentName)},'Download PDF')),
          h('div',{ref:container,'aria-label':'Document to sign',className:'esign-document-surface'})),
        ready && step===1 && h('aside',{className:'esign-side'},
          section('Document',documentFacts(true)),
          section('Signing as',
            h('dl',{className:'esign-facts'},signingAs&&fact('Name',signingAs),artifact.recipientEmail&&fact('Email',artifact.recipientEmail)),
            titleShown&&titleInput('Your title'),
            forCompany&&h('label',{className:'esign-check'},h('input',{type:'checkbox',className:checkClass,'aria-label':'Authorized to sign',checked:authority,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setAuthority(event.target.checked)}),h('span',null,"I'm authorized to sign for ",h('strong',null,forCompany)))),
          pageCount>0&&h('div',{className:'esign-viewed','aria-label':'Pages viewed'},
            h('div',{className:'esign-progress'},h('div',{style:{width:`${Math.round(Math.min(viewed,pageCount)/pageCount*100)}%`}})),
            h('span',null,`Viewed ${Math.min(viewed,pageCount)} of ${pageCount} ${pageCount===1?'page':'pages'}`))),
        showVerification && h('section',{className:'esign-confirm'},verification),
        ready && step===3 && h('section',{className:'esign-adopt'},
          h('h2',null,'Adopt your signature'),h('p',{className:'esign-sub'},'This is how your signature appears on the document.'),
          h('div',{className:'esign-adopt-inputs'},
            h('label',{className:'esign-field'},h('span',null,'Full name'),h(Input,{'aria-label':'Full name',value:fullName,maxLength:64,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>{if(!signingLock.current)setFullName(event.target.value);}})),
            titleShown&&titleInput('Title')),
          nameError&&h('p',{role:'alert',className:'esign-field-error'},nameError),
          titleError&&h('p',{role:'alert',className:'esign-field-error'},titleError),
          h('div',{className:'esign-preview','aria-label':'Signature preview'},
            h('div',{className:'esign-preview-label'},'Preview'),
            previewUrl?h('img',{src:previewUrl,alt:'Your signature',className:'esign-preview-image'}):h('div',{className:'esign-preview-name'},fullName||' '),
            h('div',{className:'esign-preview-line'}),
            h('p',{className:'esign-preview-caption'},signatureCaption(fullName,signerTitle,forCompany))),
          ...fieldPreviews,
          h('label',{className:'esign-check esign-consent'},
            h('input',{type:'checkbox',className:checkClass,'aria-label':'Consent to sign',checked:consent,disabled:signing,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>{if(!signingLock.current)setConsent(event.target.checked);}}),
            h('span',null,consentText,' ',artifact.disclosure&&linkButton('Read the electronic records disclosure',(event:React.MouseEvent)=>{event.preventDefault();setShowDisclosure(true);})))),
        ready && step===3 && h('aside',{className:'esign-side'},
          section('Document',documentFacts(false)),
          section('After you sign',h('ul',{className:'esign-after'},...afterSigningLines(artifact).map((line,i)=>h('li',{key:i},line)))))),
    !finished && actions,
    declining && modal('Decline to sign',
      h('h2',null,'Decline to sign'),
      h('p',{className:'esign-sub'},`Tell ${sender||'the sender'} why you are declining. They are notified, and nobody can sign this agreement afterwards.`),
      h('label',{className:'esign-field'},h('span',null,'Why are you declining?'),h(Textarea,{'aria-label':'Reason for declining',value:declineReason,maxLength:1000,onChange:(event:React.ChangeEvent<HTMLTextAreaElement>)=>setDeclineReason(event.target.value)})),
      h('div',{className:'esign-modal-actions'},
        button('Keep the document',()=>{setDeclining(false);setDeclineReason('');setPendingDecline(false);},{disabled:declineBusy}),
        button('Decline',()=>{if(verified)void decline();else{setDeclining(false);setPendingDecline(true);setStep(2);setMessage("Confirm it's you to decline.");}},{primary:true,className:'esign-danger-fill',disabled:declineBusy||!declineReason.trim()}))),
    showDisclosure && artifact?.disclosure && modal('Electronic records disclosure',
      h('h2',null,'Electronic records disclosure'),
      h('div',{className:'esign-disclosure'},artifact.disclosure.text),
      h('div',{className:'esign-modal-actions'},button('Close',()=>setShowDisclosure(false),{primary:true}))),
    showHelp && modal('About signing',
      h('h2',null,'About signing'),
      h(SigningHelp,{sender:sender||'The sender',documentName:artifact?.documentName}),
      h('div',{className:'esign-modal-actions'},button('Close',()=>setShowHelp(false),{primary:true}))),
    rendered&&fields.map((field,index)=>pageHosts[field.page-1]&&createPortal(h('div',{'data-signature-field':field.id,'aria-label':`${artifact?.role ? `${artifact.role} ${field.type==='Title'?'title':field.type==='Date signed'?'date signed':'signature'}${fields.length>1?` ${index+1}`:""}` : `${field.type||'Signature'} field ${index+1}`} on page ${field.page}, ${field.required?'required':'optional'}`,role:'region',style:{position:'absolute',boxSizing:'border-box',left:`${field.rect.x*100}%`,top:`${field.rect.y*100}%`,width:`${field.rect.width*100}%`,height:`${field.rect.height*100}%`,outline:'2px dashed #135c9b',outlineOffset:'0px',lineHeight:'normal',overflow:'visible'}},imageUrls[field.id]&&h('img',{src:imageUrls[field.id],alt:'',style:{position:'absolute',inset:0,width:`${(signatureSizes[field.id]?.width??0)*100}%`,height:`${(signatureSizes[field.id]?.height??0)*100}%`,maxWidth:'none',objectFit:'contain',objectPosition:'left top'}})),pageHosts[field.page-1],field.id)));
}

type PreviewProps = {field:SignatureField;value:string;token:string;onReady:(value:string,url:string,receipt?:string)=>void;onError:(error:string)=>void};

/** Asks the server for one Signature field's image of the adopted name; renders nothing itself. */
function SignaturePreview({field,value,token,preview,onReady,onSize,onError}:PreviewProps&{preview:(text:string)=>Promise<{blob:Blob;width:number;height:number;receipt:string}>;onSize:(size:{width:number;height:number;receipt:string})=>void}) {
 useEffect(()=>{let active=true,objectUrl='';onError('');
  if(SIGNATURE_NAME.test(value)&&value.length<=64)preview(value).then(({blob,width,height,receipt})=>{if(!active)return;objectUrl=URL.createObjectURL(blob);onSize({width,height,receipt});onReady(value,objectUrl);}).catch(()=>{if(active)onError('Your name does not fit the signature field. Shorten it, or ask the sender to move the field.');});
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[value,token,field.id]);
 return null;
}

/** Asks the server for a Title field's image of the signer's title, or a Date signed field's date; renders nothing itself. */
function TextPreview({field,value,token,version,preview,onReady,onSize,onError}:PreviewProps&{version:number;preview:(text:string)=>Promise<{blob:Blob;previewId:string|null;width:number;height:number}>;onSize:(size:{width:number;height:number})=>void}) {
 const date=field.type==='Date signed';
 useEffect(()=>{let active=true,objectUrl='';onError('');
  if(date||(value.length>0&&value.length<=128&&value.trim()===value&&/^[\x20-\x7e]+$/.test(value)))preview(value).then(async({blob,previewId,width,height})=>{if(!active||!previewId||(date?!/^\d{4}-\d{2}-\d{2}$/.test(previewId):!/^[a-f0-9]{64}$/.test(previewId)))return;objectUrl=URL.createObjectURL(blob);const image=new Image();image.src=objectUrl;await image.decode();if(!active)return;onSize({width,height});onReady(date?previewId!:value,objectUrl,previewId!);}).catch(error=>{if(active)onError(error instanceof RequestFailed&&error.code==='title_does_not_fit'?'Your title does not fit the title field. Shorten it.':error instanceof RequestFailed&&error.code==='title_field_too_small'?'The title field is too small. Ask the sender to resize it.':date?'The date could not be shown. Go back and try again.':'Your title could not be shown. Change it or try again.');});
  else if(!date&&value)onError('Use English letters, digits and common punctuation in your title.');
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[value,token,field.id,version]);
 return null;
}
