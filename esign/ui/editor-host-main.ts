import {editorDemoURL,editorSavedMessage} from './editor-client';
import {readSaveResult} from './editor-save-protocol';
const frame=document.querySelector<HTMLIFrameElement>('#editor')!;
const status=document.querySelector<HTMLElement>('#status')!;
const roles=document.querySelector<HTMLInputElement>('#roles')!;
const source=document.querySelector<HTMLInputElement>('#source')!;
const fileInput=document.querySelector<HTMLInputElement>('#file')!;
const pdfUrl=document.querySelector<HTMLInputElement>('#pdf-url')!;
const syntheticConfirmation=document.querySelector<HTMLInputElement>('#synthetic-confirmation')!;
let downloadAbort:AbortController|undefined;
const continueButton=document.querySelector<HTMLButtonElement>('#continue')!;
const uncertain='A pending save may still commit. Keep this session locked and check again; opening a new session may leave an additional committed version.';
const previousSaveWarning='The previous session may still commit a template; investigate it before treating this as the only version.';
let sessionId='',editorOrigin='',generation=0,pending='',ready=false,abandonedSave=false,timer:ReturnType<typeof setTimeout>|undefined;
function setStatus(message:string){status.textContent=abandonedSave&&!message.includes(previousSaveWarning)?`${message} ${previousSaveWarning}`:message;}
document.querySelector<HTMLButtonElement>('#open')!.addEventListener('click',async()=>{
 abandonedSave ||= !!pending;downloadAbort?.abort();const controller=new AbortController();downloadAbort=controller;const current=++generation;sessionId='';editorOrigin='';pending='';ready=false;continueButton.disabled=true;clearTimeout(timer);frame.removeAttribute('src');setStatus('Opening editor…');
 try{
  if(!syntheticConfirmation.checked)throw new Error('Synthetic data confirmation required');
  const file=fileInput.files?.[0],sourceId=source.value.trim(),inputUrl=pdfUrl.value.trim();pdfUrl.value='';
  if(Number(!!file)+Number(!!sourceId)+Number(!!inputUrl)!==1)throw new Error('Choose one source');
  const roleValues=roles.value.split(',').map(s=>s.trim()).filter(Boolean);
  let response:Response;
  if(file){
   if(file.size<5||file.size>5*1024*1024||await file.slice(0,5).text()!=='%PDF-')throw new Error('Invalid PDF');
   if(current!==generation)return;
   const form=new FormData();form.set('file',file);form.set('roles',JSON.stringify(roleValues));
   response=await fetch('/host/editor-demo-session',{method:'POST',headers:{'x-local-esign':'1','x-esign-synthetic-confirmed':'true'},body:form,signal:AbortSignal.timeout(15000)});
  }else{
   response=await fetch('/host/template-editing-sessions',{method:'POST',headers:{'content-type':'application/json','x-local-esign':'1','x-esign-synthetic-confirmed':'true'},signal:AbortSignal.timeout(15000),body:JSON.stringify({allowedParentOrigin:location.origin,roles:roleValues,...(sourceId?{sourceTemplateId:sourceId}:{}),...(inputUrl?{sourceUrl:inputUrl}:{})})});
  }
  if(!response.ok)throw new Error('Cannot open session');const data=await response.json() as {sessionId:string;url:string};if(current!==generation)return;
  const url=new URL(editorDemoURL(location.origin,data.url,data.sessionId));
  if(current!==generation)return;sessionId=data.sessionId;editorOrigin=url.origin;frame.src=url.href;setStatus('Editor open.');
 }catch{if(current===generation)setStatus('Could not open editor. Confirm synthetic-only use and choose one valid synthetic PDF, HTTPS URL or source template. External URL downloads are disabled until a secure downloader is configured.');}
});
async function checkSave(expectedTemplateId?:string){
 if(!sessionId)return;
 const current=generation,id=sessionId;setStatus('Checking save with host backend…');
 try{const response=await fetch(`/host/template-editing-sessions/${id}`,{headers:{'x-local-esign':'1'},cache:'no-store'});if(!response.ok)throw new Error('Unable to check');const result=await response.json() as {templateId:string|null};if(current!==generation||id!==sessionId)return;if(expectedTemplateId&&result.templateId!==expectedTemplateId){continueButton.disabled=true;setStatus('Save result could not be confirmed. Use Check save before continuing.');return;}setStatus(result.templateId?`Saved template: ${result.templateId}`:pending?`No confirmed save yet. ${uncertain}`:'No confirmed save yet.');if(result.templateId){pending='';continueButton.disabled=true;}}catch{if(current===generation&&id===sessionId)setStatus(pending?`Could not verify save. ${uncertain}`:'Could not verify save.');}
}
document.querySelector<HTMLButtonElement>('#check')!.addEventListener('click',()=>void checkSave());
continueButton.addEventListener('click',()=>{
 if(!sessionId||!ready||pending||!frame.contentWindow)return;
 pending=crypto.randomUUID();continueButton.disabled=true;setStatus('Saving template…');
 frame.contentWindow.postMessage({type:'esign.editor.save',requestId:pending},editorOrigin);
 const request=pending;timer=setTimeout(()=>{if(pending===request){setStatus(`Save response unavailable. ${uncertain}`);}},15000);
});
window.addEventListener('message',event=>{
 if(!sessionId||event.origin!==editorOrigin||event.source!==frame.contentWindow)return;
 if(event.data?.type==='esign.editor.ready'&&Object.keys(event.data).length===1){ready=true;if(!pending)continueButton.disabled=false;return;}
 if(!pending){if(editorSavedMessage(event,editorOrigin,frame.contentWindow))void checkSave();return;}
 const result=readSaveResult(event,editorOrigin,frame.contentWindow,pending);if(!result)return;
 clearTimeout(timer);
 if(result.type==='esign.editor.save-error'){const validation=result.message.startsWith('Role ')||result.message==='Upload a PDF and wait for the preview before saving.';if(validation){pending='';continueButton.disabled=!ready;}else continueButton.disabled=true;setStatus(validation?result.message:`${result.message} ${uncertain}`);return;}
 void checkSave(result.templateId);
});
