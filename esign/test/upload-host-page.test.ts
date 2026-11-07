import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UploadedHostPage} from '../ui/UploadedHostPage.ts';

test('upload page discloses remote digests, HTTP and limitations with explicit opt-in',()=>{
 const html=renderToStaticMarkup(React.createElement(UploadedHostPage));
 assert.match(html,/type="file"/);assert.match(html,/type="checkbox"/);
 assert.match(html,/HTTP/);assert.match(html,/digest/i);assert.match(html,/not.*production/i);
 assert.match(html,/cannot.*synthetic/i);assert.match(html,/revocation/i);assert.match(html,/licen/i);assert.match(html,/WORM/i);
});

test('upload UI requires opt-in and seals only the displayed completed envelope',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window;const calls:string[]=[];let sealed=false;
 try {
  const store=new Map<string,string>();(globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}};
  globalThis.fetch=async(input:any)=>{const path=String(input);calls.push(path);
   if(path==='/host/upload/create')return Response.json({id:'11111111-1111-1111-1111-111111111111'});
   if(path==='/host/upload/envelopes/11111111-1111-1111-1111-111111111111')return Response.json({id:'11111111-1111-1111-1111-111111111111',status:'FINALIZING',sealStatus:sealed?'SEALED_LOCAL_TEST':'NOT_SEALED',tasks:[{id:'task',recipientName:'Ana',status:'DONE'}]});
   if(path.endsWith('/recipient-view'))return Response.json({code:'code'});
   if(path.endsWith('/complete')){sealed=true;return Response.json({workspace:'/tmp/example',sealStatus:'SEALED_LOCAL_TEST',envelopeId:'11111111-1111-1111-1111-111111111111'});}
   throw new Error(path);
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>{r.root.findAllByType('input').find((i:any)=>i.props.type==='file').props.onChange({target:{files:[new File(['x'],'test.pdf',{type:'application/pdf'})]}});});
  await act(async()=>{await button('Upload and create test envelope').props.onClick();});
  assert.equal(button('Complete local KMS/TSA test').props.disabled,true);
  await act(async()=>{await button('Open signing view').props.onClick();});
  assert.equal(r.root.findByType('iframe').props.src,'/#code=code&upload=11111111-1111-1111-1111-111111111111');
  await act(async()=>{r.root.findAllByType('input').find((i:any)=>i.props.type==='checkbox').props.onChange({target:{checked:true}});});
  await act(async()=>{await button('Complete local KMS/TSA test').props.onClick();});
  assert.ok(calls.includes('/host/upload/envelopes/11111111-1111-1111-1111-111111111111/complete'));
  assert.match(JSON.stringify(r.toJSON()),/cannot prove the PDF is synthetic/);
  assert.match(JSON.stringify(r.toJSON()),/SEALED_LOCAL_TEST/);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('upload UI distinguishes incomplete from evidence investigation without leaking server errors',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window;let failure='NOT_READY';
 try {
  const store=new Map<string,string>();(globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}};
  globalThis.fetch=async(input:any)=>{const path=String(input);
   if(path.endsWith('/create'))return Response.json({id:'11111111-1111-1111-1111-111111111111'});
   if(path.endsWith('/complete'))return Response.json({sealStatus:failure,retryable:failure==='NOT_READY',error:'private data'}, {status:failure==='NOT_READY'?409:503});
   return Response.json({id:'11111111-1111-1111-1111-111111111111',status:'FINALIZING',sealStatus:'NOT_SEALED',tasks:[]});
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>{r.root.findAllByType('input').find((i:any)=>i.props.type==='file').props.onChange({target:{files:[new File(['x'],'test.pdf')]}});});
  await act(async()=>button('Upload and create test envelope').props.onClick());
  await act(async()=>r.root.findAllByType('input').find((i:any)=>i.props.type==='checkbox').props.onChange({target:{checked:true}}));
  await act(async()=>button('Complete local KMS/TSA test').props.onClick());
  assert.match(JSON.stringify(r.toJSON()),/not ready/i);assert.doesNotMatch(JSON.stringify(r.toJSON()),/private data/);
  failure='INVESTIGATE';await act(async()=>button('Complete local KMS/TSA test').props.onClick());
  assert.match(JSON.stringify(r.toJSON()),/investigate/i);assert.match(JSON.stringify(r.toJSON()),/do not retry/i);assert.doesNotMatch(JSON.stringify(r.toJSON()),/private data/);
  assert.equal(button('Complete local KMS/TSA test').props.disabled,true);
  assert.equal(button('Process signature').props.disabled,true);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('unknown completion responses stay blocked after refresh',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window;
 const storage=new Map<string,string>();
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}};
  globalThis.fetch=async(input:any)=>{const path=String(input);
   if(path.endsWith('/create'))return Response.json({id:'11111111-1111-1111-1111-111111111111'});
   if(path.endsWith('/complete'))throw new Error('lost response');
   return Response.json({id:'11111111-1111-1111-1111-111111111111',status:'FINALIZING',sealStatus:'NOT_SEALED',tasks:[]});
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>r.root.findAllByType('input').find((i:any)=>i.props.type==='file').props.onChange({target:{files:[new File(['x'],'test.pdf')]}}));
  await act(async()=>button('Upload and create test envelope').props.onClick());
  await act(async()=>r.root.findAllByType('input').find((i:any)=>i.props.type==='checkbox').props.onChange({target:{checked:true}}));
  await act(async()=>button('Complete local KMS/TSA test').props.onClick());
  assert.equal(button('Complete local KMS/TSA test').props.disabled,true);
  await act(async()=>button('Refresh status').props.onClick());
  assert.equal(button('Complete local KMS/TSA test').props.disabled,true);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('malformed, mismatched and unverifiable completion responses stay locked',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  for(const mode of ['bad-json','wrong-id','refresh-failed']) {
   const storage=new Map<string,string>();let afterComplete=false;
   (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}};
   globalThis.fetch=async(input:any)=>{const path=String(input);
    if(path.endsWith('/create') || path.endsWith('/resume'))return Response.json({id:'11111111-1111-1111-1111-111111111111'});
    if(path.endsWith('/complete')) {afterComplete=true;if(mode==='bad-json')return new Response('{',{status:200});return Response.json({envelopeId:mode==='wrong-id'?'wrong':'11111111-1111-1111-1111-111111111111',sealStatus:'SEALED_LOCAL_TEST',workspace:'/tmp/test'});}
    if(afterComplete && mode==='refresh-failed')return new Response('',{status:503});
    return Response.json({id:'11111111-1111-1111-1111-111111111111',status:'FINALIZING',sealStatus:'NOT_SEALED',tasks:[]});
   };
   let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
   const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
   await act(async()=>button('Resume configured instance').props.onClick());
   await act(async()=>r.root.findAllByType('input').find((i:any)=>i.props.type==='checkbox').props.onChange({target:{checked:true}}));
   await act(async()=>button('Complete local KMS/TSA test').props.onClick());
   assert.equal(button('Complete local KMS/TSA test').props.disabled,true,mode);
   await act(async()=>r.unmount());afterComplete=false;
   await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
   await act(async()=>button('Resume configured instance').props.onClick());
   await act(async()=>r.root.findAllByType('input').find((i:any)=>i.props.type==='checkbox').props.onChange({target:{checked:true}}));
   assert.equal(button('Complete local KMS/TSA test').props.disabled,true,mode+' after restart');
   await act(async()=>r.unmount());
  }
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('upload UI closes recipient frame and blocks signing and processing while locked',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window;let status='NOT_SEALED';const store=new Map<string,string>();
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}};
  globalThis.fetch=async(input:any)=>{const path=String(input);
   if(path.endsWith('/resume'))return Response.json({id:'11111111-1111-1111-1111-111111111111'});
   if(path.endsWith('/recipient-view'))return Response.json({code:'code'});
   return Response.json({id:'11111111-1111-1111-1111-111111111111',status:'IN_PROGRESS',sealStatus:status,tasks:[{id:'task',recipientName:'Ana',status:'ACTIVE'}]});
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>button('Resume configured instance').props.onClick());
  await act(async()=>button('Open signing view').props.onClick());assert.equal(r.root.findAllByType('iframe').length,1);
  status='IN_PROGRESS';await act(async()=>button('Refresh status').props.onClick());
  assert.equal(r.root.findAllByType('iframe').length,0);assert.equal(button('Open signing view').props.disabled,true);assert.equal(button('Process signature').props.disabled,true);
  status='INVESTIGATE';await act(async()=>button('Refresh status').props.onClick());
  assert.equal(button('Open signing view').props.disabled,true);assert.equal(button('Process signature').props.disabled,true);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('investigation allows viewing only existing delivery while mutation remains locked',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;const calls:string[]=[];
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}};
  URL.createObjectURL=()=> 'blob:test';URL.revokeObjectURL=()=>{};
  globalThis.fetch=async(input:any)=>{const path=String(input);calls.push(path);if(path.endsWith('/resume'))return Response.json({id:'11111111-1111-1111-1111-111111111111'});if(path.endsWith('/existing-delivery-pdf'))return new Response('%PDF-test',{headers:{'content-type':'application/pdf'}});return Response.json({id:'11111111-1111-1111-1111-111111111111',status:'COMPLETED',sealStatus:'INVESTIGATE',tasks:[]});};
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>button('Resume configured instance').props.onClick());
  assert.equal(button('Complete local KMS/TSA test').props.disabled,true);assert.equal(button('Process signature').props.disabled,true);
  await act(async()=>button('View existing test delivery PDF').props.onClick());
  assert.ok(calls.some(x=>x.endsWith('/existing-delivery-pdf')));assert.ok(!calls.some(x=>x.endsWith('/delivery-pdf')));
  assert.equal(r.root.findByType('iframe').props.src,'blob:test');assert.match(JSON.stringify(r.toJSON()),/does not independently prove a seal/);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});


test('switching uploads revokes the previous PDF and ignores late PDF responses',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 const revoked:string[]=[];let current='a',urls=0,delay=false,resolvePdf!:(response:Response)=>void;
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}};
  URL.createObjectURL=()=>`blob:${++urls}`;URL.revokeObjectURL=(url:string)=>revoked.push(url);
  globalThis.fetch=async(input:any)=>{const path=String(input);
   if(path.endsWith('/resume'))return Response.json({id:current});
   if(path.endsWith('/existing-delivery-pdf'))return delay?await new Promise<Response>(resolve=>{resolvePdf=resolve;}):new Response('%PDF-test');
   return Response.json({id:path.split('/').at(-1),status:'COMPLETED',sealStatus:'INVESTIGATE',tasks:[]});
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>button('Resume configured instance').props.onClick());
  await act(async()=>button('View existing test delivery PDF').props.onClick());
  assert.equal(r.root.findByType('iframe').props.src,'blob:1');
  current='b';await act(async()=>button('Resume configured instance').props.onClick());
  assert.equal(r.root.findAllByType('iframe').length,0);assert.ok(revoked.includes('blob:1'));
  await act(async()=>button('View existing test delivery PDF').props.onClick());
  assert.equal(r.root.findByType('iframe').props.src,'blob:2');
  delay=true;const view=button('View existing test delivery PDF').props.onClick;const resume=button('Resume configured instance').props.onClick;current='a';
  let pending:Promise<void>;await act(async()=>{pending=view();await Promise.resolve();await resume();});
  assert.equal(r.root.findAllByType('iframe').length,0);assert.ok(revoked.includes('blob:2'));
  await act(async()=>r.unmount());
  await act(async()=>{resolvePdf(new Response('%PDF-late'));await pending;});
  assert.equal(urls,2);
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});


test('switch started before stale view prevents both reentry and cross-envelope PDF',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 let current='a',hold=false,resolveResume!:(response:Response)=>void,resolveDelivery!:(response:Response)=>void,deliveryCalls=0;
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}};
  URL.createObjectURL=()=> 'blob:test';URL.revokeObjectURL=()=>{};
  globalThis.fetch=async(input:any)=>{const path=String(input);
   if(path.endsWith('/resume'))return hold?await new Promise<Response>(r=>{resolveResume=r;}):Response.json({id:current});
   if(path.endsWith('/existing-delivery-pdf')){deliveryCalls++;return await new Promise<Response>(r=>{resolveDelivery=r;});}
   return Response.json({id:path.split('/').at(-1),status:'COMPLETED',sealStatus:'INVESTIGATE',tasks:[]});
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>button('Resume configured instance').props.onClick());
  const staleView=button('View existing test delivery PDF').props.onClick;
  const resume=button('Resume configured instance').props.onClick;hold=true;current='b';
  let switching:Promise<void>;await act(async()=>{switching=resume();await Promise.resolve();void staleView();await Promise.resolve();});
  assert.equal(deliveryCalls,0,'stale handler must not start during switching');
  await act(async()=>{resolveResume(Response.json({id:'b'}));await switching;});
  await act(async()=>{void staleView();await Promise.resolve();});
  assert.equal(deliveryCalls,0,'stale handler must not start after switching');
  let downloading:Promise<void>;await act(async()=>{downloading=button('View existing test delivery PDF').props.onClick();await Promise.resolve();});
  assert.equal(deliveryCalls,1);await act(async()=>{await button('Resume configured instance').props.onClick();});
  assert.match(JSON.stringify(r.toJSON()),/Envelope.*b/);
  await act(async()=>{resolveDelivery(new Response('%PDF-test'));await downloading;});
  assert.equal(r.root.findByType('iframe').props.src,'blob:test');await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});


test('view retry clears the previous PDF before a rejected concurrent request',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const old=globalThis.fetch,oldWindow=(globalThis as any).window,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 const revoked:string[]=[];let calls=0,resolveRetry!:(response:Response)=>void;
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}};
  URL.createObjectURL=()=> 'blob:old';URL.revokeObjectURL=(url:string)=>revoked.push(url);
  globalThis.fetch=async(input:any)=>{const path=String(input);
   if(path.endsWith('/resume'))return Response.json({id:'a'});
   if(path.endsWith('/existing-delivery-pdf')) {calls++;return calls===1?new Response('%PDF-test'):await new Promise<Response>(r=>{resolveRetry=r;});}
   return Response.json({id:'a',status:'COMPLETED',sealStatus:'INVESTIGATE',tasks:[]});
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(UploadedHostPage));});
  const button=(name:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(name));
  await act(async()=>button('Resume configured instance').props.onClick());
  await act(async()=>button('View existing test delivery PDF').props.onClick());
  assert.equal(r.root.findByType('iframe').props.src,'blob:old');
  const view=button('View existing test delivery PDF').props.onClick;let pending:Promise<void>;
  await act(async()=>{pending=view();void view();await Promise.resolve();});
  assert.equal(calls,2);assert.deepEqual(revoked,['blob:old']);assert.equal(r.root.findAllByType('iframe').length,0);assert.equal(r.root.findAllByType('a').length,0);
  await act(async()=>{resolveRetry(new Response('',{status:503}));await pending;});
  assert.equal(r.root.findAllByType('iframe').length,0);assert.equal(r.root.findAllByType('a').length,0);assert.match(JSON.stringify(r.toJSON()),/investigate/i);
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=old;(globalThis as any).window=oldWindow;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
