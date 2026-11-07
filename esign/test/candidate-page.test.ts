import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {CandidatePage} from '../ui/CandidatePage.ts';

test('candidate page exchanges fragment once and offers OTP without exposing session',async()=>{
 const originalWindow=globalThis.window, originalFetch=globalThis.fetch;
 const requests:{path:string;body:any}[]=[];let replacement='';
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window:{location:{origin:'https://page.example.test',pathname:'/candidate.html',search:'',hash:'#code='+ 'a'.repeat(64)},history:{replaceState(_a:unknown,_b:string,url:string){replacement=url;}}},fetch:async (input:string,init:RequestInit)=>{requests.push({path:new URL(input).pathname,body:JSON.parse(String(init.body))});return requests.length===1?Response.json({token:'b'.repeat(64)}):new Response(null,{status:204});}});
 try {
  let tree!:TestRenderer.ReactTestRenderer;
  await act(async()=>{tree=TestRenderer.create(React.createElement(CandidatePage,{gateway:'https://gateway.example.test'}));});
  assert.equal(replacement,'/candidate.html');assert.equal(requests[0].path,'/v1/page-sessions/exchange');
  const button=tree.root.findAllByType('button').find(x=>x.children.includes('Send verification code'))!;
  await act(async()=>{button.props.onClick();});
  assert.equal(requests[1].path,'/v1/otp/send');assert.equal(requests[1].body.token,'b'.repeat(64));
  assert.doesNotMatch(JSON.stringify(tree.toJSON()),/aaaaaaa|bbbbbbb/);
  await act(async()=>tree.unmount());
 } finally {Object.assign(globalThis,{window:originalWindow,fetch:originalFetch});}
});

test('candidate sign rejection permits corrections; uncertain outcomes keep exact retry and optional receipts are removed',async()=>{
 const old={window:globalThis.window,fetch:globalThis.fetch,Image:globalThis.Image,create:URL.createObjectURL,revoke:URL.revokeObjectURL};
 const fields=['Signature','Title','Date signed'].map((type,i)=>({id:['sig','title','date'][i],type,page:1,required:type==='Date signed',rect:{x:.1,y:.1,width:.2,height:.1}}));
 let artifactId='d0';let decodeMode='ok';const decodes:{resolve:()=>void;reject:()=>void}[]=[];let outcome='400';const signs:any[]=[];const pending:Record<string,((response:Response)=>void)[]>={};let delayPreviews=false;
 const node=()=>({nodeType:1,children:[],dataset:{},style:{},appendChild(){},replaceWith(){},replaceChildren(){},querySelectorAll(){return [{style:{},replaceWith(){}},{style:{},replaceWith(){}}];}});
 const doc:any={createElement:()=>Object.assign(node(),{ownerDocument:doc})};const visible:any=Object.assign(node(),{ownerDocument:doc});
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window:{location:{origin:'https://page.example.test',pathname:'/candidate.html',search:'',hash:'#code='+ 'a'.repeat(64)},history:{replaceState(){}}},Image:class {src='';async decode(){if(decodeMode==='delay')return new Promise<void>((resolve,reject)=>decodes.push({resolve,reject:()=>reject(Error('decode'))}));}},fetch:async(input:string,init:RequestInit)=>{const path=new URL(input).pathname,body=JSON.parse(String(init.body));
 if(path.endsWith('/exchange'))return Response.json({token:'b'.repeat(64)});
 if(path==='/v1/fields')return Response.json({artifactId,artifactHash:(artifactId==='d0'?'c':'f').repeat(64),fields,recipientName:'Ana',role:'ana'});
 if(path==='/v1/document')return new Response('pdf');
 if(path==='/v1/preview'){const headers:Record<string,string>={'X-Text-Width':'.5','X-Text-Height':'.5','X-Signature-Width':'.5','X-Signature-Height':'.5','X-Signature-Preview':'d'.repeat(64),'X-Text-Preview':'e'.repeat(64),'X-Date-Preview-Id':'12345678-1234-1234-1234-123456789abc'};if(delayPreviews)return new Promise<Response>(resolve=>{(pending[body.fieldId]??=[]).push(resolve);});return new Response('png',{headers});}
 if(path==='/v1/sign'){signs.push(body);if(outcome==='lost')throw Error('lost');if(outcome==='503')return new Response(null,{status:503});if(outcome==='400')return new Response(null,{status:400});return Response.json({status:outcome==='processed'?'PROCESSED_UNSEALED':'PENDING'},{status:202});}return new Response(null,{status:204});}});
 URL.createObjectURL=()=> 'blob:test';URL.revokeObjectURL=()=>{};
 let tree!:TestRenderer.ReactTestRenderer;
 try {
 await act(async()=>{tree=TestRenderer.create(React.createElement(CandidatePage,{gateway:'https://gateway.example.test',renderDocument:async()=>{}}),{createNodeMock:()=>visible});});
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.includes(text))!;
 await act(async()=>{await button('Send verification code').props.onClick();});const verify=button('Verify').props.onClick;await act(async()=>{await verify();});
 const input=(part:string)=>tree.root.findAllByType('input').find(x=>String(x.props['aria-label']).includes(part))!;
 await act(async()=>{input('signature').props.onChange({target:{value:'Ana'}});input('title').props.onChange({target:{value:'Director'}});});
 await act(async()=>{});
 const checkbox=()=>tree.root.findByProps({'aria-label':'Consent to sign'});
 const pageCheck=(n:number)=>tree.root.findByProps({'aria-label':`Acknowledge page ${n}`});
 assert.equal(checkbox().props.disabled,true);await act(async()=>{pageCheck(1).props.onChange({target:{checked:true}});});assert.equal(checkbox().props.disabled,true,'all pages must be acknowledged');await act(async()=>{pageCheck(2).props.onChange({target:{checked:true}});});
 artifactId='d1';await act(async()=>{await verify();});assert.equal(pageCheck(1).props.checked,false,'changed document clears page acknowledgements');assert.equal(pageCheck(2).props.checked,false);assert.equal(checkbox().props.disabled,true);await act(async()=>{pageCheck(1).props.onChange({target:{checked:true}});pageCheck(2).props.onChange({target:{checked:true}});input('title').props.onChange({target:{value:'Director'}});});
 decodeMode='delay';await act(async()=>{input('signature').props.onChange({target:{value:'Ann'}});});assert.equal(checkbox().props.disabled,true,'decode must finish');await act(async()=>{input('signature').props.onChange({target:{value:'Anne'}});});await act(async()=>{decodes.shift()!.resolve();});assert.equal(checkbox().props.disabled,true,'stale decode cannot enable consent');await act(async()=>{decodes.shift()!.reject();});assert.equal(checkbox().props.disabled,true,'failed decode cannot enable consent');decodeMode='ok';delayPreviews=true;
 const previewResponse=(id:string)=>new Response('png',{headers:{'X-Text-Width':'.5','X-Text-Height':'.5','X-Signature-Width':'.5','X-Signature-Height':'.5','X-Signature-Preview':'d'.repeat(64),'X-Text-Preview':'e'.repeat(64),'X-Date-Preview-Id':id}});
 await act(async()=>{input('signature').props.onChange({target:{value:'Anna'}});});
 assert.equal(checkbox().props.disabled,true,'consent disabled while edited signature preview is pending');
 await act(async()=>{checkbox().props.onChange({target:{checked:true}});await button('Sign document').props.onClick();});
 assert.equal(checkbox().props.checked,false);assert.equal(signs.length,0,'pending preview cannot be signed');
 await act(async()=>{input('signature').props.onChange({target:{value:'Annie'}});});
 await act(async()=>{pending.sig.shift()!(previewResponse('12345678-1234-1234-1234-123456789abc'));});
 assert.equal(checkbox().props.disabled,true,'stale preview cannot enable consent');
 await act(async()=>{pending.sig.shift()!(previewResponse('12345678-1234-1234-1234-123456789abc'));});
 assert.equal(checkbox().props.disabled,false);
 await act(async()=>{checkbox().props.onChange({target:{checked:true}});});
 await act(async()=>{input('title').props.onChange({target:{value:'Manager'}});});
 assert.equal(checkbox().props.checked,false);assert.equal(checkbox().props.disabled,true,'consent disabled while title preview is pending');
 await act(async()=>{pending.title.shift()!(previewResponse('12345678-1234-1234-1234-123456789abc'));});
 await act(async()=>{checkbox().props.onChange({target:{checked:true}});});
 await act(async()=>{button('Refresh date previews').props.onClick();});
 assert.equal(checkbox().props.checked,false);assert.equal(checkbox().props.disabled,true,'consent disabled while date preview is pending');
 await act(async()=>{button('Refresh date previews').props.onClick();});
 await act(async()=>{pending.date.shift()!(previewResponse('12345678-1234-1234-1234-123456789abc'));});
 assert.equal(checkbox().props.disabled,true,'stale date preview cannot enable consent');
 await act(async()=>{pending.date.shift()!(previewResponse('abcdefab-1234-1234-1234-123456789abc'));});
 assert.equal(checkbox().props.disabled,false);assert.equal(checkbox().props.checked,false);
 delayPreviews=false;
 await act(async()=>{checkbox().props.onChange({target:{checked:true}});});
 await act(async()=>{await button('Sign document').props.onClick();});
 assert.equal(signs.length,1);assert.equal(input('signature').props.disabled,false,'definite 400 unlocks fields');assert.equal(checkbox().props.checked,false,'rejection requires new consent');
 await act(async()=>{await button('Refresh date previews').props.onClick();});
 await act(async()=>{input('signature').props.onChange({target:{value:'Anna'}});});
 assert.equal(checkbox().props.checked,false);
 await act(async()=>{checkbox().props.onChange({target:{checked:true}});});
 await act(async()=>{input('signature').props.onChange({target:{value:''}});input('title').props.onChange({target:{value:''}});});
 assert.equal(checkbox().props.checked,false,'changing fields revokes consent');
 await act(async()=>{checkbox().props.onChange({target:{checked:true}});});
 outcome='lost';await act(async()=>{await button('Sign document').props.onClick();});assert.deepEqual(signs[1].signaturePreviews,{});assert.deepEqual(signs[1].textPreviews,{});assert.deepEqual(signs[1].values,{});assert.notEqual(signs[1].idempotencyKey,signs[0].idempotencyKey);assert.equal(input('signature').props.disabled,true);
 outcome='503';await act(async()=>{await button('Sign document').props.onClick();});assert.deepEqual(signs[2],signs[1]);
 outcome='400';await act(async()=>{await button('Sign document').props.onClick();});assert.deepEqual(signs[3],signs[1]);assert.equal(input('signature').props.disabled,true,'a later 400 cannot resolve an earlier lost response');
 outcome='ok';await act(async()=>{await button('Sign document').props.onClick();});assert.deepEqual(signs[4],signs[1]);assert.match(JSON.stringify(tree.toJSON()),/PENDING/);assert.equal(tree.root.findAllByType('button').some(b=>b.children.includes('Sign document')),false);outcome='processed';await act(async()=>{await button('Retry processing').props.onClick();});assert.deepEqual(signs[5],signs[1]);assert.match(JSON.stringify(tree.toJSON()),/PROCESSED_UNSEALED/);
 } finally {if(tree)await act(async()=>tree.unmount());Object.assign(globalThis,{window:old.window,fetch:old.fetch,Image:old.Image});URL.createObjectURL=old.create;URL.revokeObjectURL=old.revoke;}
});

test('candidate pending processing retries retain the recorded request through errors and concurrent clicks',async()=>{
 const old={window:globalThis.window,fetch:globalThis.fetch};
 const signs:any[]=[];let outcome='pending';let release!: (response:Response)=>void;
 const node=()=>({nodeType:1,children:[],dataset:{},style:{},appendChild(){},replaceWith(){},replaceChildren(){},querySelectorAll(){return [{style:{},replaceWith(){}}];}});
 const doc:any={createElement:()=>Object.assign(node(),{ownerDocument:doc})};const visible:any=Object.assign(node(),{ownerDocument:doc});
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window:{location:{origin:'https://page.example.test',pathname:'/candidate.html',search:'',hash:'#code='+ 'a'.repeat(64)},history:{replaceState(){}}},fetch:async(input:string,init:RequestInit)=>{const path=new URL(input).pathname,body=JSON.parse(String(init.body));
  if(path.endsWith('/exchange'))return Response.json({token:'b'.repeat(64)});
  if(path==='/v1/fields')return Response.json({artifactId:'d0',artifactHash:'c'.repeat(64),fields:[],recipientName:'Ana',role:'ana'});
  if(path==='/v1/document')return new Response('pdf');
  if(path==='/v1/sign'){signs.push(body);if(outcome==='400'||outcome==='503')return new Response(null,{status:Number(outcome)});if(outcome==='lost')throw Error('lost');if(outcome==='delayed')return new Promise<Response>(resolve=>{release=resolve;});return Response.json({status:outcome==='processed'?'PROCESSED_UNSEALED':'PENDING'},{status:202});}
  return new Response(null,{status:204});}});
 let tree!:TestRenderer.ReactTestRenderer;
 try {
  await act(async()=>{tree=TestRenderer.create(React.createElement(CandidatePage,{gateway:'https://gateway.example.test',renderDocument:async()=>{}}),{createNodeMock:()=>visible});});
  const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.includes(text))!;
  await act(async()=>{await button('Send verification code').props.onClick();});await act(async()=>{await button('Verify').props.onClick();});
  await act(async()=>{tree.root.findByProps({'aria-label':'Acknowledge page 1'}).props.onChange({target:{checked:true}});});
  await act(async()=>{tree.root.findByProps({'aria-label':'Consent to sign'}).props.onChange({target:{checked:true}});});
  await act(async()=>{await button('Sign document').props.onClick();});
  assert.match(JSON.stringify(tree.toJSON()),/PENDING/);assert.ok(signs[0].idempotencyKey);
  for(const error of ['400','503','lost']){
   outcome=error;await act(async()=>{await button('Retry processing').props.onClick();});
   assert.deepEqual(signs.at(-1),signs[0],`${error} retry must use the recorded payload`);
   assert.match(JSON.stringify(tree.toJSON()),/Signing result unavailable/);
   assert.equal(tree.root.findAllByType('button').some(b=>b.children.includes('Sign document')),false,'never offer re-signing');
  }
  outcome='delayed';let first!:Promise<void>;await act(async()=>{const click=button('Retry processing').props.onClick;first=click();click();});
  assert.equal(signs.length,5,'concurrent retry clicks issue only one request');assert.equal(button('Retry processing').props.disabled,true);assert.deepEqual(signs[4],signs[0]);
  await act(async()=>{release(Response.json({status:'PROCESSED_UNSEALED'},{status:202}));await first;});
  assert.match(JSON.stringify(tree.toJSON()),/PROCESSED_UNSEALED/);assert.equal(tree.root.findAllByType('button').some(b=>b.children.includes('Retry processing')),false);
 } finally {if(tree)await act(async()=>tree.unmount());Object.assign(globalThis,old);}
});
