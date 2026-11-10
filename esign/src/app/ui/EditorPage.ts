import React from 'react';
import {FieldEditor,type Field,type EditorHandle} from './FieldEditor.ts';
import {readSaveRequest} from './editor-save-protocol.ts';
import {consumeEditorFragment} from './editor-client.ts';
import {embedding} from './RecipientPage.ts';

const h=React.createElement;
type Session={headers:Record<string,string>;details:{roles:string[];fields:Field[];sourceTemplateId:string|null;hasStagedSource?:boolean;parentOrigin:string};initialFile:File|null};

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

function EmbeddedEditor({session}:{session:Session}){
  const editor=React.useRef<EditorHandle>(null);
  const {headers,details,initialFile}=session;
  const onSave=async(file:File|null,roles:string[],fields:Field[])=>{const form=new FormData();if(file)form.set('file',file);form.set('roles',JSON.stringify(roles));form.set('fields',JSON.stringify(fields));const response=await fetch('/api/public/editor/save',{method:'POST',headers,body:form,cache:'no-store'});if(!response.ok)throw new Error('Save failed');const result=await response.json() as {id?:unknown};if(typeof result.id!=='string'||!/^[a-f0-9-]{36}$/.test(result.id))throw new Error('Invalid save result');window.parent.postMessage({type:'esign.editor.saved'},details.parentOrigin);return result.id;};
  React.useEffect(()=>{
    let pending=false;
    const onMessage=(event:MessageEvent)=>{const requestId=readSaveRequest(event,details.parentOrigin,window.parent);if(!requestId||pending)return;pending=true;void (async()=>{try{const result=await editor.current?.save();if(!result)throw new Error('Editor is not ready');window.parent.postMessage(result.ok?{type:'esign.editor.saved',requestId,templateId:result.templateId}:{type:'esign.editor.save-error',requestId,message:result.message},details.parentOrigin);}catch{window.parent.postMessage({type:'esign.editor.save-error',requestId,message:'Save unavailable. Check the saved result before retrying.'},details.parentOrigin);}finally{pending=false;}})();};
    window.addEventListener('message',onMessage);window.parent.postMessage({type:'esign.editor.ready'},details.parentOrigin);return()=>window.removeEventListener('message',onMessage);
  },[]);
  return h(FieldEditor,{ref:editor,initialRoles:details.roles.length?details.roles:undefined,initialFields:details.fields,initialFile,editingSource:true,embedded:true,onSave});
}

export function EditorPage(){
  const [session,setSession]=React.useState<Session|null>(null),[failed,setFailed]=React.useState(false);
  React.useEffect(()=>{
    const pageId=window.location.pathname.split('/').pop()??'';
    const code=consumeEditorFragment(window.location,window.history);
    let live=true;
    openSession(pageId,code).then(value=>{if(live)setSession(value);}).catch(()=>{if(live)setFailed(true);});
    return()=>{live=false;};
  },[]);
  if(failed)return h('p',{role:'alert',className:'p-6 text-sm text-destructive'},'Editor session unavailable. Ask the host to open a new session.');
  if(!session)return h('p',{role:'status',className:'p-6 text-sm text-muted-foreground'},'Loading the editor…');
  return h(EmbeddedEditor,{session});
}
