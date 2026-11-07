import './esign-theme.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {FieldEditor,type Field,type EditorHandle} from './FieldEditor';
import {readSaveRequest} from './editor-save-protocol';
import {consumeEditorFragment} from './editor-client';

const root=createRoot(document.getElementById('root')!);
async function start(){
  const pageId=window.location.pathname.split('/').pop()??'';
  const code=consumeEditorFragment(window.location,window.history);
  const exchange=await fetch('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId,code}),cache:'no-store'});
  if(!exchange.ok)throw new Error('Expired or invalid link');
  const {token}=await exchange.json() as {token:string};const headers={authorization:`Bearer ${token}`};
  const current=await fetch('/v1/editor/current',{headers,cache:'no-store'});if(!current.ok)throw new Error('Session unavailable');
  const details=await current.json() as {roles:string[];fields:Field[];sourceTemplateId:string|null;hasStagedSource?:boolean;parentOrigin:string};
  let initialFile:File|null=null;
  if(!details.sourceTemplateId&&!details.hasStagedSource)throw new Error('Source unavailable');
  if(details.sourceTemplateId||details.hasStagedSource){const pdf=await fetch('/v1/editor/pdf',{headers,cache:'no-store',signal:AbortSignal.timeout(15000)});if(!pdf.ok)throw new Error('Source unavailable');const blob=await pdf.blob();if(blob.size<5||blob.size>5*1024*1024)throw new Error('Invalid source');initialFile=new File([blob],'source.pdf',{type:'application/pdf'});}
  const onSave=async(file:File|null,roles:string[],fields:Field[])=>{const form=new FormData();if(file)form.set('file',file);form.set('roles',JSON.stringify(roles));form.set('fields',JSON.stringify(fields));const response=await fetch('/v1/editor/save',{method:'POST',headers,body:form,cache:'no-store'});if(!response.ok)throw new Error('Save failed');const result=await response.json() as {id?:unknown};if(typeof result.id!=='string'||!/^[a-f0-9-]{36}$/.test(result.id))throw new Error('Invalid save result');window.parent.postMessage({type:'esign.editor.saved'},details.parentOrigin);return result.id;};
  function EditorApp(){
    const editor=React.useRef<EditorHandle>(null);
    React.useEffect(()=>{
      let pending=false;
      const onMessage=(event:MessageEvent)=>{const requestId=readSaveRequest(event,details.parentOrigin,window.parent);if(!requestId||pending)return;pending=true;void (async()=>{try{const result=await editor.current?.save();if(!result)throw new Error('Editor is not ready');window.parent.postMessage(result.ok?{type:'esign.editor.saved',requestId,templateId:result.templateId}:{type:'esign.editor.save-error',requestId,message:result.message},details.parentOrigin);}catch{window.parent.postMessage({type:'esign.editor.save-error',requestId,message:'Save unavailable. Check the saved result before retrying.'},details.parentOrigin);}finally{pending=false;}})();};
      window.addEventListener('message',onMessage);window.parent.postMessage({type:'esign.editor.ready'},details.parentOrigin);return()=>window.removeEventListener('message',onMessage);
    },[]);
    return React.createElement(FieldEditor,{ref:editor,initialRoles:details.roles.length?details.roles:undefined,initialFields:details.fields,initialFile,editingSource:true,embedded:true,onSave});
  }
  root.render(React.createElement(EditorApp));
}
void start().catch(()=>root.render(React.createElement('p',{role:'alert'},'Editor session unavailable. Ask the host to open a new session.')));
