import React from 'react';
import {describePdfRefusal} from '../lib/upload-changes.ts';
import {FieldEditor,type Field,type EditorHandle,type PrefillCatalogEntry} from './FieldEditor.ts';
import {readSaveCall} from './editor-save-protocol.ts';
import {consumeEditorFragment} from './editor-client.ts';
import {embedding} from './RecipientPage.ts';

const h=React.createElement;
type Session={headers:Record<string,string>;details:{roles:string[];roleLabels?:Record<string,string>;prefill?:boolean;prefillCatalog?:PrefillCatalogEntry[];fields:Field[];sourceTemplateId:string|null;hasStagedSource?:boolean;parentOrigin:string};initialFile:File|null};

/**
 * /editor/page/:id#<code>: the field editor a host frames. It exchanges the one-time code for an
 * editor token (the exchange refuses a page framed by anyone but the session's parent), loads the
 * source PDF and saves the template with `/api/public/editor/*`, and tells the parent when it is
 * ready, saved or failed.
 */
async function openSession(pageId:string,code:string):Promise<Session>{
  const exchange=await fetch('/api/public/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId,code,...embedding(window,document.referrer)}),cache:'no-store'});
  if(!exchange.ok)throw new Error('Expired or invalid link');
  const {token}=await exchange.json() as {token:string};const headers={'x-esign-session':token};
  const current=await fetch('/api/public/editor/current',{headers,cache:'no-store'});if(!current.ok)throw new Error('Session unavailable');
  const details=await current.json() as Session['details'];
  if(!details.sourceTemplateId&&!details.hasStagedSource)throw new Error('Source unavailable');
  const pdf=await fetch('/api/public/editor/pdf',{headers,cache:'no-store',signal:AbortSignal.timeout(15000)});if(!pdf.ok)throw new Error('Source unavailable');
  const blob=await pdf.blob();if(blob.size<5||blob.size>5*1024*1024)throw new Error('Invalid source');
  return {headers,details,initialFile:new File([blob],'source.pdf',{type:'application/pdf'})};
}

/** A placed field as the editor labels it on the page. */
const fieldName=(f:Field)=>f.type==='Prefill'?`${f.label} (pre-filled)`:`${f.role} — ${f.type}`;
/** Why the server refused a save, as the editor shows it: nothing was saved, and the fields can be fixed (or, for a
 * document replaced meanwhile, placed again in an editor opened on it). A field placed where it can't be is named,
 * from the fields saved, and `fields` carries the ids of those named (none when they can't be). */
export function refusal(body:{error?:unknown;message?:unknown;reason?:unknown;page?:unknown;fields?:unknown},saved:Field[]=[]):Error&{refused:true;fields:string[]}{
  // A PDF chosen in the editor that Esign can't prepare for signing (server/esign/pdf-upload.ts) says why.
  const pdf=typeof body.reason==='string'?describePdfRefusal(body.reason,typeof body.page==='number'?body.page:undefined):null;
  // Two fields that overlap, or one past its page's edge (server/esign/fields.ts FieldPlacementError).
  const ids=Array.isArray(body.fields)?body.fields:[],named=ids.map(id=>saved.find(f=>f.id===id));
  const placed=body.error==='invalid_pdf_or_fields'&&named.length&&named.every(f=>f)?named as Field[]:[];
  const placement=body.reason==='fields_overlap'&&placed.length===2?`${fieldName(placed[0]!)} and ${fieldName(placed[1]!)} overlap on page ${placed[0]!.page}: move them apart and save again.`
    :body.reason==='field_off_page'&&placed.length===1?`${fieldName(placed[0]!)} doesn't fit on page ${placed[0]!.page}: move it onto the page and save again.`:null;
  const text=pdf?pdf:placement?placement:body.error==='invalid_signing_fields'&&typeof body.message==='string'?`${body.message.replace(/^Role (\S+): missing Signature field$/,'Role $1: add a Signature field').replace(/^Role (\S+): no required Signature field$/,'Role $1: make at least one Signature field required')}.`
    :body.error==='invalid_pdf_or_fields'?'Some fields overlap, or one doesn\'t fit on its page: move them apart and save again.'
    :body.error==='invalid_roles'?'The roles changed since the editor opened: close it and open it again.'
    :body.error==='source_changed'?'The document was replaced since the editor opened: open the editor again to place the fields on it.'
    :'The fields weren\'t accepted. Check them and save again.';
  return Object.assign(new Error(text),{refused:true as const,fields:placement?placed.map(f=>f.id):[]});
}

/** A failed save the editor explains: a 422 (but a draft where none is allowed), or a 409 for a document replaced
 * since it opened. Any other failure leaves the save's result to be checked. */
export const refusedSave=(status:number,body:{error?:unknown}):boolean=>(status===422&&body.error!=='draft_not_allowed')||(status===409&&body.error==='source_changed');

function EmbeddedEditor({session}:{session:Session}){
  const editor=React.useRef<EditorHandle>(null);
  const {headers,details,initialFile}=session;
  // A draft save tells the parent only through its answer to the request: the one-key "saved" message means the editor is done.
  // A save the server refused (a 422, or a 409 for a document replaced meanwhile: refusedSave) saved nothing: it says why,
  // and the fields can be changed and saved again, or placed in an editor opened again.
  const onSave=async(file:File|null,roles:string[],fields:Field[],draft=false)=>{const form=new FormData();if(file)form.set('file',file);form.set('roles',JSON.stringify(roles));form.set('fields',JSON.stringify(fields));if(draft)form.set('draft','true');const response=await fetch('/api/public/editor/save',{method:'POST',headers,body:form,cache:'no-store'});if(!response.ok){let body:Parameters<typeof refusal>[0]={};try{body=await response.json() as typeof body;}catch{/* no body */}if(refusedSave(response.status,body))throw refusal(body,fields);if(draft)throw new Error(String(body.error??'')||'Save failed');throw new Error('Save failed');}const result=await response.json() as {id?:unknown};if(typeof result.id!=='string'||!/^[a-f0-9-]{36}$/.test(result.id))throw new Error('Invalid save result');if(!draft)window.parent.postMessage({type:'esign.editor.saved'},details.parentOrigin);return result.id;};
  React.useEffect(()=>{
    let pending=false;
    const onMessage=(event:MessageEvent)=>{const call=readSaveCall(event,details.parentOrigin,window.parent);if(!call||pending)return;const {requestId,draft}=call;pending=true;void (async()=>{try{const result=await editor.current?.save(draft);if(!result)throw new Error('Editor is not ready');window.parent.postMessage(result.ok?{type:'esign.editor.saved',requestId,templateId:result.templateId}:{type:'esign.editor.save-error',requestId,message:result.message},details.parentOrigin);}catch{window.parent.postMessage({type:'esign.editor.save-error',requestId,message:'Save unavailable. Check the saved result before retrying.'},details.parentOrigin);}finally{pending=false;}})();};
    window.addEventListener('message',onMessage);window.parent.postMessage({type:'esign.editor.ready'},details.parentOrigin);return()=>window.removeEventListener('message',onMessage);
  },[]);
  return h(FieldEditor,{ref:editor,allowPrefill:details.prefill!==false,prefillCatalog:details.prefillCatalog??null,roleLabels:details.roleLabels,initialRoles:details.roles.length?details.roles:undefined,initialFields:details.fields,initialFile,editingSource:true,embedded:true,onSave});
}

export function EditorPage(){
  const [session,setSession]=React.useState<Session|null>(null),[failed,setFailed]=React.useState(false);
  React.useEffect(()=>{
    const pageId=window.location.pathname.split('/').pop()??'';
    // A link without its code (or with a malformed one) can't open a session: say so, as a failed exchange does.
    let code:string;
    try{code=consumeEditorFragment(window.location,window.history);}catch{setFailed(true);return;}
    let live=true;
    openSession(pageId,code).then(value=>{if(live)setSession(value);}).catch(()=>{if(live)setFailed(true);});
    return()=>{live=false;};
  },[]);
  if(failed)return h('p',{role:'alert',className:'p-6 text-sm text-destructive'},'Editor session unavailable. Ask the host to open a new session.');
  if(!session)return h('p',{role:'status',className:'p-6 text-sm text-muted-foreground'},'Loading the editor…');
  return h(EmbeddedEditor,{session});
}
