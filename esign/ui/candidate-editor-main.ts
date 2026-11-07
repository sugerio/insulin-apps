import './esign-theme.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {FieldEditor,type Field} from './FieldEditor.ts';
import {candidateEditorGateway,consumeCandidateEditorFragment} from './candidate-editor-client.ts';

const root=createRoot(document.getElementById('root')!);
async function start(){
 const entry=consumeCandidateEditorFragment(window.location,window.history);
 const gateway=candidateEditorGateway(import.meta.env.VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN ?? '');
 const post=async(path:string,body:unknown)=>fetch(gateway+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
 const exchange=await post('/v1/editor-sessions/exchange',entry);if(!exchange.ok)throw Error('Session unavailable');
 const {token}=await exchange.json() as {token:string};if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('Session unavailable');
 const context=await post('/v1/editor-sessions/context',{token});if(!context.ok)throw Error('Session unavailable');
 const {roles}=await context.json() as {roles:string[]};if(!Array.isArray(roles)||roles.length!==2||roles.some(r=>typeof r!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(r)))throw Error('Session unavailable');
 const key=crypto.randomUUID();
 const onSave=async(file:File|null,_roles:string[],fields:Field[])=>{
  if(!file)throw Error('Source unavailable');
  const form=new FormData();form.set('file',file);form.set('fields',JSON.stringify(fields));
  const response=await fetch(gateway+'/v1/editor-sessions/save',{method:'POST',headers:{'x-editor-token':token,'idempotency-key':key},body:form,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
  if(!response.ok)throw Error('Save unavailable');const result=await response.json() as {id?:unknown};
  if(typeof result.id!=='string'||!/^[a-f0-9]{64}$/.test(result.id))throw Error('Invalid save result');return result.id;
 };
 root.render(React.createElement(FieldEditor,{initialRoles:roles,onSave}));
}
void start().catch(()=>root.render(React.createElement('p',{role:'alert'},'Editor session unavailable. Ask the host to open a new session.')));
