// The members' app rendered at an address, with a window that keeps the address as the app moves (pushState and the
// navigation event) and a fetch that answers from `routes`. Every request is recorded, and so is every location.assign
// (the platform's switch and sign-out). `stored` seeds localStorage (the navigation's `insulin-nav`).
import assert from 'node:assert/strict';
import React from 'react';

export const ORIGIN='https://esign.example.test';
export const ENV_ID='11111111-1111-4111-8111-111111111111';
export type Call={path:string;method:string;headers:Record<string,string>;body:unknown};
export const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
export const me=(role:string,permissions:string[],extra:Record<string,unknown>={})=>({organizationId:'org-example',user:{id:'u1',email:'sam@example.com',name:'Sam Example'},role,permissions,accessVia:'browser',preview:false,signingEnabled:true,...extra});
export const EDITOR=me('EDITOR',['esign.manage','esign.view']);
export const VIEWER=me('VIEWER',['esign.view']);

function memoryStorage(){const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v),removeItem:(k:string)=>void m.delete(k),map:m};}

/** The text a person sees: rendered strings only, not attributes. */
export function visibleText(node:any):string {
 if(node==null)return '';if(typeof node==='string')return node;if(Array.isArray(node))return node.map(visibleText).join(' ');
 return visibleText(node.children);
}

export async function renderMember(path:string,routes:(call:Call)=>Response|undefined,stored:Record<string,string>={}){
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const start=new URL(path,ORIGIN);
 const assigned:string[]=[];
 const location={origin:ORIGIN,pathname:start.pathname,search:start.search,hash:start.hash,assign:(to:string)=>void assigned.push(to)};
 const listeners=new Map<string,Set<(e:any)=>void>>();
 const session=memoryStorage(),local=memoryStorage();
 for(const [k,v] of Object.entries(stored))local.setItem(k,v);
 (globalThis as any).window={location,sessionStorage:session,localStorage:local,scrollTo(){},
  history:{pushState(_state:unknown,_title:string,to:string){const u=new URL(to,ORIGIN);location.pathname=u.pathname;location.search=u.search;location.hash=u.hash;}},
  addEventListener:(type:string,f:(e:any)=>void)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(f);},
  removeEventListener:(type:string,f:(e:any)=>void)=>{listeners.get(type)?.delete(f);},
  dispatchEvent:(event:{type:string})=>{for(const f of [...(listeners.get(event.type)??[])])f(event);return true;}};
 const calls:Call[]=[];
 globalThis.fetch=(async(input:any,init:RequestInit={})=>{
  const call={path:String(input),method:init.method??'GET',headers:{...(init.headers as Record<string,string>)},body:init.body};
  calls.push(call);
  const response=routes(call);
  if(!response)throw new Error(`unexpected ${call.method} ${call.path}`);
  return response;
 }) as typeof fetch;
 const posted:unknown[]=[];const frameWindow={postMessage:(m:unknown)=>posted.push(m)};
 const {MemberApp}=await import('../../src/app/member/MemberApp.ts');
 let renderer:any;
 const settle=()=>act(async()=>{for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,0));});
 await act(async()=>{renderer=Renderer.create(React.createElement(MemberApp),{createNodeMock:()=>({contentWindow:frameWindow,focus(){}})});});
 await settle();
 const text=()=>visibleText(renderer.toJSON());
 const find=(type:string,name:string)=>renderer.root.findAll((n:any)=>n.type===type&&visibleText(n.children).trim()===name)[0];
 const button=(name:string)=>find('button',name);
 const link=(name:string)=>find('a',name);
 const byId=(id:string)=>renderer.root.findAll((n:any)=>(n.type==='input'||n.type==='textarea'||n.type==='select')&&n.props.id===id)[0];
 const byLabel=(label:string)=>renderer.root.findAll((n:any)=>typeof n.type==='string'&&n.props['aria-label']===label)[0];
 const click=async(node:any,label='')=>{assert.ok(node,`${label} is shown: ${text()}`);await act(async()=>{node.props.onClick({defaultPrevented:false,button:0,preventDefault(){},stopPropagation(){}});});await settle();};
 const type=async(node:any,value:string)=>{assert.ok(node,`field is shown: ${text()}`);await act(async()=>{node.props.onChange({target:{value,files:[]}});});};
 const dispatch=async(event:{origin:string;source:unknown;data:unknown})=>{await act(async()=>{for(const f of [...(listeners.get('message')??[])])f(event);});await settle();};
 const keyDown=async(node:any,key:string)=>{await act(async()=>{node.props.onKeyDown({key,stopPropagation(){},preventDefault(){}});});await settle();};
 return {renderer,act,calls,location,assigned,session,local,posted,keyDown,frameWindow,text,button,link,byId,byLabel,click,type,dispatch,settle,
  unmount:async()=>{await act(async()=>renderer.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}};
}
