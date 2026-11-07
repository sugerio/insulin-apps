import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const page=await import('../ui/RecipientPage.ts').catch(()=>({}));
test('recipient page identifies local-only signing and does not request a management key',()=>{
  assert.equal(typeof page.RecipientPage,'function','recipient page missing');
  const html=renderToStaticMarkup(React.createElement(page.RecipientPage));
  assert.match(html,/local test/i);assert.doesNotMatch(html,/api key/i);
});

test('recipient page independently retries document load after successful verification', async () => {
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch, oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test-code',pathname:'/'},history:{replaceState(){}}};
    for (const failedPath of ['/v1/signing/current','/v1/signing/pdf']) {
      let failed=false, verifies=0;
      globalThis.fetch=async (input:any) => {
        const path=new URL(String(input)).pathname;
        if(path==='/v1/page-sessions/exchange') return Response.json({token:'test-token'});
        if(path==='/v1/signing/otp') return Response.json({messageId:'local-message-id',testOtp:'012345'},{status:202});
        if(path==='/v1/signing/otp/verify') {verifies++;return new Response(null,{status:204});}
        if(path===failedPath && !failed) {failed=true;return new Response(null,{status:503});}
        if(path==='/v1/signing/current') return Response.json({id:'d0',sha256:'h0'});
        if(path==='/v1/signing/pdf') return new Response(new Blob(['pdf'],{type:'application/pdf'}));
        throw new Error(`Unexpected request ${path}`);
      };
      let renderer:any;
      await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
      const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
      await act(async()=>{await button('Send test code').props.onClick();});
      assert.match(JSON.stringify(renderer.toJSON()),/local-message-id/);
      assert.match(JSON.stringify(renderer.toJSON()),/012345/);
      await act(async()=>{renderer.root.findByType('input').props.onChange({target:{value:'123456'}});});
      await act(async()=>{await button('Verify').props.onClick();});
      assert.ok(button('Retry document'),'document failure must offer a separate retry');
      await act(async()=>{await button('Retry document').props.onClick();});
      assert.equal(verifies,1);assert.ok(button('Sign document'));assert.equal(button('Sign document').props.disabled,true);
      await act(async()=>{renderer.unmount();});
    }
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('recipient page permits retry of verification after its response is lost', async () => {
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test-code',pathname:'/'},history:{replaceState(){}}};let attempts=0;
    globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
      if(path==='/v1/page-sessions/exchange') return Response.json({token:'test-token'});
      if(path==='/v1/signing/otp') return Response.json({messageId:'local-message-id'},{status:202});
      if(path==='/v1/signing/otp/verify') {if(++attempts===1) throw new Error('lost response');return new Response(null,{status:204});}
      if(path==='/v1/signing/current') return Response.json({id:'d0',sha256:'h0'});
      if(path==='/v1/signing/pdf') return new Response(new Blob(['pdf'],{type:'application/pdf'}));
      throw new Error('Unexpected request');};
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{await button('Send test code').props.onClick();});
    await act(async()=>{renderer.root.findByType('input').props.onChange({target:{value:'123456'}});});
    await act(async()=>{await button('Verify').props.onClick();});
    await act(async()=>{await button('Verify').props.onClick();});
    assert.equal(attempts,2);assert.ok(button('Sign document'));assert.equal(button('Sign document').props.disabled,true);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});


test('pixel-budget render failure never offers consent or signing and allows retry', async () => {
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test-code',pathname:'/'},history:{replaceState(){}}};
    globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
      if(path==='/v1/page-sessions/exchange') return Response.json({token:'test-token'});
      if(path==='/v1/signing/otp') return Response.json({messageId:'test'});
      if(path==='/v1/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/v1/signing/current') return Response.json({id:'d0',sha256:'h0'});
      if(path==='/v1/signing/pdf') return new Response(new Blob(['bad pdf']));
      throw new Error('Unexpected request');};
    let attempts=0, renderer:any;
    await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{if(++attempts===1) throw new Error('PDF pixel budget exceeded');}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{await button('Send test code').props.onClick();});
    await act(async()=>{await button('Verify').props.onClick();});
    assert.ok(button('Retry document'));assert.equal(button('Sign document'),undefined);
    assert.match(JSON.stringify(renderer.toJSON()),/Document unavailable/);
    await act(async()=>{await button('Retry document').props.onClick();});
    assert.ok(button('Sign document'));assert.equal(button('Sign document').props.disabled,true);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('superseded render cannot contaminate a later successful preview', async () => {
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
    let currentRequests=0;
    globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
      if(path==='/v1/page-sessions/exchange') return Response.json({token:'token'});
      if(path==='/v1/signing/otp') return Response.json({messageId:'test'});
      if(path==='/v1/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/v1/signing/current') return ++currentRequests===1?new Response(null,{status:503}):Response.json({id:'d0',sha256:'hash'});
      if(path==='/v1/signing/pdf') return new Response(new Blob(['pdf']));
      throw new Error(path);};
    const makeNode=()=>({children:[] as any[],appendChild(node:any){this.children.push(node);},replaceChildren(...nodes:any[]){this.children=nodes;}});
    const visible:any=makeNode();visible.ownerDocument={createElement:()=>makeNode()};
    let release!:()=>void, oldSignal:AbortSignal|undefined;
    const oldRender=async (_blob:Blob,target:any,signal:AbortSignal)=>{oldSignal=signal;await new Promise<void>(resolve=>release=resolve);target.appendChild('old');};
    let renderCount=0;const render=async (blob:Blob,target:any,signal:AbortSignal)=>{if(++renderCount===1) return oldRender(blob,target,signal);target.appendChild('new');};
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:render}),{createNodeMock:()=>visible});});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{await button('Send test code').props.onClick();});
    await act(async()=>{await button('Verify').props.onClick();});
    const retry=button('Retry document').props.onClick;
    await act(async()=>{await retry();});
    await act(async()=>{await retry();});
    assert.ok(button('Sign document'));
    await act(async()=>{release();await Promise.resolve();});
    assert.deepEqual(visible.children.map((node:any)=>node.children),[['new']]);assert.equal(oldSignal?.aborted,true);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('older retry response cannot replace a newer document', async () => {
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
    let current=0,releaseOld!:(response:Response)=>void,signed:any;
    globalThis.fetch=async (input:any,init?:RequestInit)=>{const path=new URL(String(input)).pathname;
      if(path==='/v1/page-sessions/exchange') return Response.json({token:'token'});
      if(path==='/v1/signing/otp') return Response.json({messageId:'test'});
      if(path==='/v1/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/v1/signing/current') {current++;if(current===1)return new Response(null,{status:503});if(current===2)return new Promise<Response>(resolve=>releaseOld=resolve);return Response.json({id:'new',sha256:'newhash'});}
      if(path==='/v1/signing/pdf') return new Response(new Blob(['pdf']));
      if(path==='/v1/signing/sign') {signed=JSON.parse(String(init?.body));return new Response(null,{status:202});}
      throw new Error(path);};
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{await button('Send test code').props.onClick();});await act(async()=>{await button('Verify').props.onClick();});
    const retry=button('Retry document').props.onClick;let old:Promise<void>;
    await act(async()=>{old=retry();await Promise.resolve();});
    await act(async()=>{await retry();});
    await act(async()=>{releaseOld(Response.json({id:'old',sha256:'oldhash'}));await old;});
    await act(async()=>{renderer.root.findByType('input').props.onChange({target:{checked:true}});});
    await act(async()=>{await button('Sign document').props.onClick();});
    assert.equal(signed.artifactId,'new');assert.equal(signed.artifactHash,'newhash');
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('synthetic recipient routes sessions and signing only through isolated same-origin BFF',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;const calls:{url:string;headers:HeadersInit|undefined}[]=[];
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=synthetic-code&synthetic=1',pathname:'/'},history:{replaceState(){}}};
  globalThis.fetch=async(input:any,init:RequestInit={})=>{calls.push({url:String(input),headers:init.headers});return String(input).endsWith('/exchange')?Response.json({token:'t'}):Response.json({messageId:'x',testOtp:'123456'});};
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(page.RecipientPage));});
  await act(async()=>{await r.root.findByType('button').props.onClick();});
  assert.deepEqual(calls.map(c=>c.url),['/host/synthetic/v1/page-sessions/exchange','/host/synthetic/v1/signing/otp']);
  assert.ok(calls.every(c=>new Headers(c.headers).get('x-local-esign')==='1'));
  await act(async()=>r.unmount());
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('positioned signatures fail closed when a page marker cannot be rendered',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;let signed:any;
 try{
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
  globalThis.fetch=async(input:any,init?:RequestInit)=>{const path=new URL(String(input)).pathname;
   if(path.endsWith('/exchange'))return Response.json({token:'token'});
   if(path.endsWith('/otp'))return Response.json({messageId:'test'});
   if(path.endsWith('/verify'))return new Response(null,{status:204});
   if(path.endsWith('/current'))return Response.json({id:'d0',sha256:'hash',fields:[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:0,y:0,width:.3,height:.1}}]});
   if(path.endsWith('/pdf'))return new Response(new Blob(['pdf']));
   if(path.endsWith('/signature-preview'))return new Response(new Blob(['image'],{type:'image/png'}));
   if(path.endsWith('/sign')){signed=JSON.parse(String(init?.body));return new Response(null,{status:202});}
   throw new Error(path);
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
  const button=(s:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(s));
  await act(async()=>{await button('Send test code').props.onClick();});await act(async()=>{await button('Verify').props.onClick();});
  assert.equal(button('Sign document'),undefined);assert.ok(button('Retry document'));assert.equal(signed,undefined);await act(async()=>r.unmount());
 }finally{globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('recipient demo never sends a fragment code from an untrusted non-local page to loopback or a relative endpoint',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  for(const fragment of ['#code=synthetic-code','#code=synthetic-code&synthetic=1','#code=synthetic-code&upload=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
   let calls=0,removed=false;
   (globalThis as any).window={location:{origin:'https://demo.example.test',hash:fragment,pathname:'/'},history:{replaceState(){removed=true;}}};
   globalThis.fetch=async()=>{calls++;return Response.json({token:'test'});};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage));});
   assert.equal(removed,true);assert.equal(calls,0);assert.match(JSON.stringify(renderer.toJSON()),/unavailable/i);
   await act(async()=>renderer.unmount());
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('recipient demo retains its configured local loopback endpoints',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  for(const [origin,target] of [['http://127.0.0.1:5173','http://127.0.0.1:8787'],['http://127.0.0.1:5174','http://127.0.0.1:8787'],['http://127.0.0.1:5197','http://127.0.0.1:8797']]) {
   let url='';(globalThis as any).window={location:{origin,hash:'#code=test-code',pathname:'/'},history:{replaceState(){}}};
   globalThis.fetch=async input=>{url=String(input);return Response.json({token:'test'});};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage));});
   assert.equal(url,`${target}/v1/page-sessions/exchange`);await act(async()=>renderer.unmount());
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('recipient page served by the Worker exchanges the code with its own origin only when the Worker declares it',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldDocument=(globalThis as any).document;
 const origin='https://esign.example.test';
 try {
  // [declared API origin, fragment, expected exchange URL or null]
  for(const [declared,fragment,expected] of [
   [origin,'#code=test-code',`${origin}/v1/page-sessions/exchange`],
   // Worker-served pages never switch to the local synthetic or upload hosts.
   [origin,'#code=test-code&synthetic=1',`${origin}/v1/page-sessions/exchange`],
   [origin,'#code=test-code&upload=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',`${origin}/v1/page-sessions/exchange`],
   // A copied page declaring another origin, or none, stays closed.
   ['https://other.example.test','#code=test-code',null],
   [null,'#code=test-code',null],
  ] as const) {
   let url='',calls=0;
   (globalThis as any).window={location:{origin,hash:fragment,pathname:'/sign'},history:{replaceState(){}}};
   (globalThis as any).document={querySelector:(selector:string)=>selector==='meta[name="esign-api"]'&&declared?{getAttribute:(name:string)=>name==='content'?declared:null}:null};
   globalThis.fetch=async input=>{calls++;url=String(input);return Response.json({token:'test'});};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage));});
   if(expected){assert.equal(url,expected,`${declared} ${fragment}`);}
   else {assert.equal(calls,0,`${declared} ${fragment}`);assert.match(JSON.stringify(renderer.toJSON()),/unavailable/i);}
   await act(async()=>renderer.unmount());
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).document=oldDocument;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('after signing, a Worker-served page does not ask for processing the Worker does itself',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldDocument=(globalThis as any).document;
 try {
  for(const [origin,declared,expected] of [
   ['https://esign.example.test','https://esign.example.test','Signature recorded.'],
   ['http://127.0.0.1:5173',null,'Signature recorded. Local processing must be requested separately.'],
  ] as const) {
   (globalThis as any).window={location:{origin,hash:'#code=test',pathname:'/sign'},history:{replaceState(){}}};
   (globalThis as any).document={querySelector:(selector:string)=>selector==='meta[name="esign-api"]'&&declared?{getAttribute:()=>declared}:null};
   globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
    if(path==='/v1/page-sessions/exchange') return Response.json({token:'token'});
    if(path==='/v1/signing/otp') return Response.json({messageId:'test'});
    if(path==='/v1/signing/otp/verify') return new Response(null,{status:204});
    if(path==='/v1/signing/current') return Response.json({id:'artifact',sha256:'hash'});
    if(path==='/v1/signing/pdf') return new Response(new Blob(['pdf']));
    if(path==='/v1/signing/sign') return new Response(null,{status:202});
    throw new Error(path);};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
   const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
   await act(async()=>{await button('Send test code').props.onClick();});await act(async()=>{await button('Verify').props.onClick();});
   await act(async()=>{renderer.root.findByType('input').props.onChange({target:{checked:true}});});
   await act(async()=>{await button('Sign document').props.onClick();});
   const text=JSON.stringify(renderer.toJSON());
   assert.ok(text.includes(`"${expected}"`),`${origin}: ${text}`);
   await act(async()=>{renderer.unmount();});
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).document=oldDocument;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('the page says a code was emailed when the Worker emailed it', async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  for(const [otpResponse,expected] of [[{messageId:'m',emailed:true},'Verification code sent by email.'],[{messageId:'m'},'Test code sent to the local test mailbox.']] as const) {
   (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
   globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
    if(path==='/v1/page-sessions/exchange') return Response.json({token:'token'});
    if(path==='/v1/signing/otp') return Response.json(otpResponse,{status:202});
    throw new Error(path);};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}));});
   const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
   await act(async()=>{await button('Send test code').props.onClick();});
   assert.ok(JSON.stringify(renderer.toJSON()).includes(`"${expected}"`),expected);
   await act(async()=>{renderer.unmount();});
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('the page shows the consent disclosure from the server and signs with its version', async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
  let signed:any;
  globalThis.fetch=async (input:any,init?:RequestInit)=>{const path=new URL(String(input)).pathname;
   if(path==='/v1/page-sessions/exchange') return Response.json({token:'token'});
   if(path==='/v1/signing/otp') return Response.json({messageId:'m'});
   if(path==='/v1/signing/otp/verify') return new Response(null,{status:204});
   if(path==='/v1/signing/current') return Response.json({id:'a1',sha256:'h1',disclosure:{version:'2026-11-07',text:'Consent to use electronic records and signatures\nYou may ask the sender for a paper copy.'}});
   if(path==='/v1/signing/pdf') return new Response(new Blob(['pdf']));
   if(path==='/v1/signing/sign') {signed=JSON.parse(String(init?.body));return new Response(null,{status:202});}
   throw new Error(path);};
  let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});});
  const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
  await act(async()=>{await button('Send test code').props.onClick();});await act(async()=>{await button('Verify').props.onClick();});
  const text=JSON.stringify(renderer.toJSON());
  assert.match(text,/Consent to use electronic records and signatures/);assert.match(text,/paper copy/);
  await act(async()=>{renderer.root.findByType('input').props.onChange({target:{checked:true}});});
  await act(async()=>{await button('Sign document').props.onClick();});
  assert.equal(signed.disclosureVersion,'2026-11-07');assert.equal(signed.consent,true);
  await act(async()=>{renderer.unmount();});
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
