import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';

test('abandoned pending save warning survives repeated editor opens and status checks',async()=>{
 const result=await build({entryPoints:['ui/editor-host-main.ts'],bundle:true,platform:'browser',format:'iife',write:false});
 const elements=new Map<string,any>();
 for(const id of ['editor','status','roles','source','file','pdf-url','synthetic-confirmation','continue','open','check'])elements.set(id,{value:'',checked:false,disabled:false,files:[],textContent:'',handlers:{},addEventListener(name:string,fn:unknown){this.handlers[name]=fn;},removeAttribute(){}});
 elements.get('roles').value='Signer';elements.get('source').value='template';elements.get('synthetic-confirmation').checked=true;
 const parent:any={handlers:{},addEventListener(name:string,fn:unknown){this.handlers[name]=fn;}};const frame=elements.get('editor');frame.contentWindow={postMessage(){}};
 const origin='https://demo.example.test';let counter=0;
 const fetch=async(url:string)=>{if(url.startsWith('/host/template-editing-sessions/'))return Response.json({templateId:null});const id=String(++counter).repeat(64);return Response.json({sessionId:id,url:`${origin}/editor/page/${id}#${'a'.repeat(64)}`});};
 const context=vm.createContext({document:{querySelector:(selector:string)=>elements.get(selector.slice(1))},window:parent,location:{origin},fetch,URL,AbortController,AbortSignal,FormData,Response,crypto:{randomUUID:()=> 'request-1'},setTimeout:()=>1,clearTimeout(){}});
 vm.runInContext(result.outputFiles[0].text,context);
 await elements.get('open').handlers.click();parent.handlers.message({origin,source:frame.contentWindow,data:{type:'esign.editor.ready'}});elements.get('continue').handlers.click();
 await elements.get('open').handlers.click();assert.match(elements.get('status').textContent,/previous session may still commit/i);
 await elements.get('open').handlers.click();assert.match(elements.get('status').textContent,/previous session may still commit/i);
 await elements.get('check').handlers.click();await new Promise(resolve=>setImmediate(resolve));assert.match(elements.get('status').textContent,/previous session may still commit/i);
 elements.get('synthetic-confirmation').checked=false;await elements.get('open').handlers.click();assert.match(elements.get('status').textContent,/previous session may still commit/i);
});
