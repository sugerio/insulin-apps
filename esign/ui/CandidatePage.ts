import React, { useEffect, useRef, useState } from 'react';
import {createPortal} from 'react-dom';
import {CandidateBrowserClient, CandidateRequestError, takeCandidateCode} from './candidate-client.ts';
const h = React.createElement;

type SignatureField = {id:string;type:'Signature'|'Title'|'Date signed';page:number;required:boolean;rect:{x:number;y:number;width:number;height:number}};
type Artifact = {id:string;sha256:string;fields?:SignatureField[];recipientName?:string;role?:string};
type RenderDocument = (blob:Blob, container:HTMLElement, signal:AbortSignal)=>Promise<void>;
const defaultRender:RenderDocument=async (blob,container,signal)=>{const {renderPdf}=await import('./renderPdf');signal.throwIfAborted();return renderPdf(blob,container,signal);};
export function CandidatePage({gateway,renderDocument=defaultRender}:{gateway:string;renderDocument?:RenderDocument}) {
  const container=useRef<HTMLDivElement>(null), renderController=useRef<AbortController|null>(null), loadSequence=useRef(0),signingLock=useRef(false);
  useEffect(()=>()=>{loadSequence.current++;},[]);
  const previewGeneration=useRef<Record<string,number>>({});
  const client=useRef<CandidateBrowserClient|null>(null), signPayload=useRef<Record<string,unknown>|null>(null), uncertainSign=useRef(false);
  const [token,setToken]=useState(''), [otp,setOtp]=useState(''), [message,setMessage]=useState('Opening candidate session…');
  const [artifact,setArtifact]=useState<Artifact|null>(null), [pdf,setPdf]=useState<Blob|null>(null), [consent,setConsent]=useState(false), [sent,setSent]=useState(false);
  const [reviewedPages,setReviewedPages]=useState<number[]>([]);
  const [rendered,setRendered]=useState(false),[pageHosts,setPageHosts]=useState<HTMLElement[]>([]),[imageUrls,setImageUrls]=useState<Record<string,string>>({});
  const [textReceipts,setTextReceipts]=useState<Record<string,string>>({});
  const [signatureReceipts,setSignatureReceipts]=useState<Record<string,string>>({});
  const [signatureSizes,setSignatureSizes]=useState<Record<string,{width:number;height:number}>>({});
  const [signatures,setSignatures]=useState<Record<string,string>>({}),[previews,setPreviews]=useState<Record<string,string>>({}),[datePreviewVersion,setDatePreviewVersion]=useState(0);
  const [signing,setSigning]=useState(false),[verified,setVerified]=useState(false), [finished,setFinished]=useState(false),[pendingSign,setPendingSign]=useState(false);
  useEffect(()=>{
    const code=takeCandidateCode(window.location,window.history);
    if(!code){setMessage('No valid recipient code provided. Request a new view.');return;}
    try {client.current=new CandidateBrowserClient(gateway,window.location.origin);} catch {setMessage('Candidate gateway or page origin unavailable.');return;}
    client.current.exchange(code).then(()=>{setToken('ready');setMessage('Request a verification code.');}).catch(()=>setMessage('Session unavailable or expired. Request a new view.'));
  },[gateway]);
  useEffect(()=>{
    if (!pdf || !container.current) return;
    let active=true;const target=container.current;const detached=target.ownerDocument.createElement('div');
    const controller=new AbortController();renderController.current=controller;target.replaceChildren();
    renderDocument(pdf,detached,controller.signal).then(()=>{
      if(active && !controller.signal.aborted) {
        const fields=artifact?.fields??[];let hosts:HTMLElement[]=[];
        {
          const canvases=Array.from(detached.querySelectorAll('canvas'));
          if(!canvases.length||fields.some(f=>!f.rect||!Number.isInteger(f.page)||f.page<1||f.page>canvases.length||![f.rect.x,f.rect.y,f.rect.width,f.rect.height].every(Number.isFinite)||f.rect.x<0||f.rect.y<0||f.rect.width<=0||f.rect.height<=0||f.rect.x+f.rect.width>1||f.rect.y+f.rect.height>1))throw new Error('Invalid field layout');
          hosts=canvases.map((canvas,index)=>{const page=detached.ownerDocument.createElement('div');page.dataset.signaturePage=String(index+1);page.style.cssText='position:relative;display:table;max-width:100%;margin:0 auto 24px;line-height:0';canvas.replaceWith(page);page.appendChild(canvas);canvas.style.display='block';return page;});
        }
        target.replaceChildren(detached);setPageHosts(hosts);setMessage('Review every page, then consent and sign.');setRendered(true);
      }
    }).catch(()=>{if(active && !controller.signal.aborted) {target.replaceChildren();setPdf(null);setArtifact(null);setMessage('Document unavailable. Retry loading it, or request a new view if the session expired.');}});
    return ()=>{active=false;controller.abort();if(renderController.current===controller) renderController.current=null;target.replaceChildren();};
  },[pdf,renderDocument]);
  async function request(path:string, init:RequestInit={}) {
    if(!client.current)throw new Error('Unavailable');
    const body=init.body ? JSON.parse(String(init.body)) as Record<string,unknown> : {};
    return client.current.request(path,body);
  }
  async function send() {try {
    await request('/v1/otp/send',{method:'POST'});
    setSent(true);setMessage('If available, a verification code has been sent.');
  } catch {setMessage('Test code unavailable; retry after the cooldown.');}}
  async function loadDocument() {
    const sequence=++loadSequence.current;for(const id of Object.keys(previewGeneration.current))previewGeneration.current[id]++;renderController.current?.abort();container.current?.replaceChildren();
    setRendered(false);setReviewedPages([]);setConsent(false);setSignatures({});setPreviews({});setPageHosts([]);setImageUrls({});setSignatureSizes({});setSignatureReceipts({});setTextReceipts({});setArtifact(null);setPdf(null);setMessage('Loading document…');
    try {
      const info=await (await request('/v1/fields')).json() as unknown as {artifactId:string;artifactHash:string;fields:SignatureField[];recipientName:string;role:string};
      if(sequence!==loadSequence.current) return;
      if(!info || typeof info.artifactId!=='string' || !/^[a-f0-9]{64}$/.test(info.artifactHash) || !Array.isArray(info.fields) || info.fields.length>20 || info.fields.some(f=>!f || typeof f.id!=='string' || !['Signature','Title','Date signed'].includes(f.type) || typeof f.required!=='boolean'))throw new Error('Unsupported metadata');
      const blob=await (await request('/v1/document')).blob();
      if(sequence!==loadSequence.current) return;
      setArtifact({id:info.artifactId,sha256:info.artifactHash,fields:info.fields,recipientName:info.recipientName,role:info.role});setPdf(blob);
    } catch {if(sequence===loadSequence.current) setMessage('Document unavailable. Retry loading it, or request a new view if the session expired.');}
  }
  async function verify() {try {
    await request('/v1/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})});
    setVerified(true);setOtp('');await loadDocument();
  } catch {setMessage('Code verification unavailable. Retry the same code.');}}
  const fields=artifact?.fields??[];
  const signaturesReady=fields.every(field=>{const value=signatures[field.id]??'';if(field.type==='Date signed')return /^[a-f0-9-]{36}$/.test(previews[field.id]??'');if(!field.required&&!value)return true;return (field.type==='Title'?value.length<=128&&value.length>0&&value.trim()===value&&/^[\x20-\x7e]+$/.test(value):/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value)&&value.length<=64)&&previews[field.id]===value;});
  const pagesReviewed=pageHosts.length>0 && reviewedPages.length===pageHosts.length;
  async function sign() {if(signingLock.current || (!pendingSign && (!artifact || !consent || !rendered || !pagesReviewed || !signaturesReady)))return;signingLock.current=true;setSigning(true);try {
    const payload=signPayload.current ?? {artifactId:artifact!.id,artifactHash:artifact!.sha256,consent:true,idempotencyKey:crypto.randomUUID(),signaturePreviews:signatureReceipts,textPreviews:textReceipts,values:Object.fromEntries(fields.filter(f=>f.type!=='Date signed'&&signatures[f.id]).map(f=>[f.id,signatures[f.id]])),datePreviewIds:Object.fromEntries(fields.filter(f=>f.type==='Date signed').map(f=>[f.id,previews[f.id]]))};
    signPayload.current=payload;
    const response=await request('/v1/sign',{method:'POST',body:JSON.stringify(payload)});
    const result=await response.json() as {status?:unknown};
    if(response.status!==202 || (result.status!=='PENDING' && result.status!=='PROCESSED_UNSEALED'))throw new Error('Unexpected status');
    if(result.status==='PENDING')uncertainSign.current=true;
    setArtifact(null);setPdf(null);setRendered(false);setPendingSign(result.status==='PENDING');setFinished(true);setMessage(result.status==='PENDING'?'PENDING: signature recorded; processing is not complete and the document is not sealed. Retry processing or contact management for recovery.':'PROCESSED_UNSEALED: signature processed; the document is not sealed.');
  } catch (error) {if(error instanceof CandidateRequestError && error.status===400 && !uncertainSign.current){signPayload.current=null;setConsent(false);setMessage('Signing request rejected. Review the fields, refresh date previews if needed, and consent again.');}else {uncertainSign.current=true;setMessage('Signing result unavailable. Retry the same request; do not assume it failed. Request a new view if it cannot be resolved.');}}finally{signingLock.current=false;setSigning(false);}}
  return h('main',{className:'esign-recipient'},
    pendingSign && h('button',{onClick:sign,disabled:signing,type:'button'},'Retry processing'),h('h1',null,'E-sign candidate'),h('p',null,'Isolated experiment for synthetic documents only. Not a production signature service.'),h('p',{role:'status'},message),
    token && !verified && !finished && h('section',{className:'esign-verification-card'},h('button',{onClick:send,type:'button'},'Send verification code'),sent && h('div',null,
      h('label',null,'Verification code ',h('input',{value:otp,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>setOtp(event.target.value),inputMode:'numeric',maxLength:6})),h('button',{onClick:verify,type:'button'},'Verify'))),
    verified && !artifact && !finished && h('button',{onClick:loadDocument,type:'button'},'Retry document'),
    h('div',{className:'esign-signing-workspace'},
    verified && !finished && h('div',{ref:container,'aria-label':'Document to sign',className:'esign-document-surface'}),
    artifact && rendered && h('section',{className:'esign-signing-panel'},
      fields.length>0 && artifact.recipientName && h('p',null,'Recipient: ',artifact.recipientName,' — role: ',artifact.role),
      fields.length>0 && h('p',null,'Type uppercase and lowercase Latin letters and single spaces. This text is separate from the recipient identity. Preview is generated by the server.'),
      ...fields.map((field,index)=>{const generation=previewGeneration.current[field.id]??0;const current=()=>generation===(previewGeneration.current[field.id]??0);const props={key:field.id,field,index,role:artifact.role,multiple:fields.length>1,value:signatures[field.id]??'',token,disabled:signing||!!signPayload.current,onChange:(value:string)=>{if(signingLock.current)return;previewGeneration.current[field.id]=(previewGeneration.current[field.id]??0)+1;setSignatures(old=>({...old,[field.id]:value}));setPreviews(old=>({...old,[field.id]:''}));setImageUrls(old=>({...old,[field.id]:''}));setSignatureReceipts(old=>{const next={...old};delete next[field.id];return next;});setTextReceipts(old=>{const next={...old};delete next[field.id];return next;});setConsent(false);},onReady:(value:string,url:string,receipt?:string)=>{if(!current())return;setConsent(false);setPreviews(old=>({...old,[field.id]:value}));setImageUrls(old=>({...old,[field.id]:url}));if(receipt&&field.type==='Title')setTextReceipts(old=>({...old,[field.id]:receipt}));}};return field.type==='Title'||field.type==='Date signed'?h(V3TextInput,{...props,onSize:(size:{width:number;height:number})=>{if(current())setSignatureSizes(old=>({...old,[field.id]:size}));},version:datePreviewVersion,preview:async(text:string)=>{const response=await request('/v1/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fieldId:field.id,...(field.type==='Title'?{text}:{})})});const width=Number(response.headers.get('X-Text-Width')),height=Number(response.headers.get('X-Text-Height'));if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid preview geometry');return {blob:await response.blob(),previewId:response.headers.get(field.type==='Title'?'X-Text-Preview':'X-Date-Preview-Id'),width,height};}}):h(TypedSignatureInput,{...props,preview:async(text:string)=>{const response=await request('/v1/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fieldId:field.id,text})});const receipt=response.headers.get('X-Signature-Preview')??'',width=Number(response.headers.get('X-Signature-Width')),height=Number(response.headers.get('X-Signature-Height'));if(!/^[a-f0-9]{64}$/.test(receipt))throw new Error('Invalid preview receipt');if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid preview geometry');return {blob:await response.blob(),width,height,receipt};},onSize:(size:{width:number;height:number;receipt:string})=>{if(!current())return;setSignatureSizes(old=>({...old,[field.id]:size}));setSignatureReceipts(old=>({...old,[field.id]:size.receipt}));}});}),
      fields.some(f=>f.type==='Date signed')&&h('button',{type:'button',disabled:signing||!!signPayload.current,onClick:()=>{if(signingLock.current)return;const dates=fields.filter(f=>f.type==='Date signed');for(const f of dates)previewGeneration.current[f.id]=(previewGeneration.current[f.id]??0)+1;setPreviews(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setImageUrls(old=>{const next={...old};for(const f of dates)delete next[f.id];return next;});setConsent(false);setDatePreviewVersion(v=>v+1);}},'Refresh date previews'),
      h('p',null,'Review each rendered page and acknowledge it below. This acknowledgement does not establish that you read it.'),
      ...pageHosts.map((_,index)=>h('label',{key:index},h('input',{type:'checkbox','aria-label':`Acknowledge page ${index+1}`,checked:reviewedPages.includes(index+1),disabled:signing||!!signPayload.current,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>{if(signingLock.current||signPayload.current)return;setReviewedPages(old=>event.target.checked?[...old.filter(n=>n!==index+1),index+1]:old.filter(n=>n!==index+1));setConsent(false);}}),` I reviewed page ${index+1}.`)),
      h('label',null,h('input',{type:'checkbox','aria-label':'Consent to sign',checked:consent,disabled:signing||!!signPayload.current||!pagesReviewed||!signaturesReady,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>{if(!signingLock.current&&pagesReviewed&&signaturesReady&&!signPayload.current)setConsent(event.target.checked);}}),' I agree to sign this document.'),
      h('button',{onClick:sign,disabled:signing||!consent||!pagesReviewed||!signaturesReady,type:'button'},'Sign document'))),
    rendered&&fields.map((field,index)=>pageHosts[field.page-1]&&createPortal(h('div',{'data-signature-field':field.id,'aria-label':`${artifact?.role ? `${artifact.role} ${field.type==='Title'?'title':field.type==='Date signed'?'date signed':'signature'}${fields.length>1?` ${index+1}`:""}` : `${field.type||'Signature'} field ${index+1}`} on page ${field.page}, ${field.required?'required':'optional'}`,role:'region',style:{position:'absolute',boxSizing:'border-box',left:`${field.rect.x*100}%`,top:`${field.rect.y*100}%`,width:`${field.rect.width*100}%`,height:`${field.rect.height*100}%`,outline:'2px dashed #135c9b',outlineOffset:'0px',lineHeight:'normal',overflow:'visible'}},imageUrls[field.id]&&h('img',{src:imageUrls[field.id],alt:'',style:{position:'absolute',inset:0,width:`${(signatureSizes[field.id]?.width??0)*100}%`,height:`${(signatureSizes[field.id]?.height??0)*100}%`,objectFit:'contain',objectPosition:'left top'}})),pageHosts[field.page-1],field.id)));

}

function TypedSignatureInput({field,index,role,multiple,value,token,disabled,preview,onChange,onReady,onSize}:{field:SignatureField;index:number;role?:string;multiple:boolean;value:string;token:string;disabled:boolean;preview:(text:string)=>Promise<{blob:Blob;width:number;height:number;receipt:string}>;onSize:(size:{width:number;height:number;receipt:string})=>void;onChange:(value:string)=>void;onReady:(value:string,url:string)=>void}) {
 const [url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true,objectUrl='';setUrl('');setError('');
  if(/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(value)&&value.length<=64)preview(value).then(async({blob,width,height,receipt})=>{if(!active)return;objectUrl=URL.createObjectURL(blob);const image=new Image();image.src=objectUrl;await image.decode();if(!active)return;setUrl(objectUrl);onSize({width,height,receipt});onReady(value,objectUrl);}).catch(()=>{if(active)setError('Signature cannot fit safely. Shorten it or ask the template editor to move the field.');});
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[value,token,field.id]);
 return h('div',null,h('label',null,`${role ? `${role} signature${multiple?` ${index+1}`:""}` : `Signature field ${index+1}`} on page ${field.page}${field.required?' (required)':' (optional)'} `,h('input',{'aria-label':`${role ? `${role} signature${multiple?` ${index+1}`:""}` : `Signature field ${index+1}`} on page ${field.page}`,value,disabled,maxLength:64,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>onChange(e.target.value)})),error&&h('p',{role:'alert'},error),url&&h('img',{src:url,alt:`Signature preview for field ${index+1} on page ${field.page}`,style:{maxWidth:'100%',height:'44px'}}));
}

function V3TextInput({field,index,role,multiple,value,token,disabled,version,preview,onChange,onReady,onSize}:{field:SignatureField;index:number;role?:string;multiple:boolean;value:string;token:string;disabled:boolean;version:number;preview:(text:string)=>Promise<{blob:Blob;previewId:string|null;width:number;height:number}>;onSize:(size:{width:number;height:number})=>void;onChange:(value:string)=>void;onReady:(value:string,url:string,receipt?:string)=>void}) {
 const date=field.type==='Date signed',label=`${role ? `${role} title${multiple?` ${index+1}`:''}` : `Title field ${index+1}`} on page ${field.page}`;
 const [url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true,objectUrl='';setUrl('');setError('');
  if(date||(value.length>0&&value.length<=128&&value.trim()===value&&/^[\x20-\x7e]+$/.test(value)))preview(value).then(async({blob,previewId,width,height})=>{if(!active||!previewId||(date?!/^[a-f0-9-]{36}$/.test(previewId):!/^[a-f0-9]{64}$/.test(previewId)))return;objectUrl=URL.createObjectURL(blob);const image=new Image();image.src=objectUrl;await image.decode();if(!active)return;setUrl(objectUrl);onSize({width,height});onReady(date?previewId!:value,objectUrl,previewId!);}).catch(()=>{if(active)setError('Preview unavailable. Change the input or retry.');});
  return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[value,token,field.id,date?version:0]);
 return h('div',null,date?h('p',{'data-field-label':field.id},`${role ? `${role} date signed` : 'Date signed'} on page ${field.page}. Date preview from server (UTC). Refresh if the date changes or the preview expires.`):h('label',{'data-field-label':field.id},label,field.required?' (required)':' (optional)',' ',h('input',{'aria-label':label,value,disabled,maxLength:128,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>onChange(e.target.value)})),error&&h('p',{role:'alert'},error),url&&h('img',{src:url,alt:date?'Server date preview':`Title preview for field ${index+1}`,style:{maxWidth:'100%',height:'44px'}}));
}
