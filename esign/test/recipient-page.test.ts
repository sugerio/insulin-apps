import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const page=await import('../src/app/ui/RecipientPage.ts').catch(()=>({}));
/** Lets the requests a render starts (the document opens on its own) finish. */
async function settle(act:any) {
  await act(async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));});
}

/** Waits for the code the page sends by itself, then types one into the six boxes (as a paste fills them). */
async function enterCode(renderer:any, act:any, code='123456') {
  await settle(act);
  await act(async()=>{renderer.root.findAllByProps({'aria-label':'Digit 1 of 6'}).find((n:any)=>n.type==='input').props.onChange({target:{value:code}});});
}
/** The text a person sees: rendered strings only, not attributes. */
function visibleText(node:any):string {
  if(node==null)return '';if(typeof node==='string')return node;if(Array.isArray(node))return node.map(visibleText).join(' ');
  return visibleText(node.children);
}

/** The Sign step's one consent box. */
const consentBox=(renderer:any)=>renderer.root.findAll((n:any)=>n.type==='input'&&n.props['aria-label']==='Consent to sign')[0];

/** From Review through the emailed code to the Sign step (the page's three steps). */
async function toSignStep(renderer:any, act:any) {
  const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
  await act(async()=>{button('Continue').props.onClick();});
  await enterCode(renderer,act);
  await act(async()=>{await button('Verify code').props.onClick();});
}

test('recipient page has a neutral heading, no test-only wording, and does not request a management key',()=>{
  assert.equal(typeof page.RecipientPage,'function','recipient page missing');
  const html=renderToStaticMarkup(React.createElement(page.RecipientPage));
  assert.match(html,/Sign document/);assert.doesNotMatch(html,/local test|experimental|synthetic/i);assert.doesNotMatch(html,/api key/i);
});

test('recipient page opens the document before the code and retries its load on its own', async () => {
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch, oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test-code',pathname:'/'},history:{replaceState(){}}};
    for (const failedPath of ['/api/public/signing/current','/api/public/signing/pdf']) {
      let failed=false, verifies=0;
      globalThis.fetch=async (input:any) => {
        const path=new URL(String(input)).pathname;
        if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
        if(path==='/api/public/page-sessions/exchange') return Response.json({token:'test-token'});
        if(path==='/api/public/signing/otp') return Response.json({messageId:'local-message-id',testOtp:'012345'},{status:202});
        if(path==='/api/public/signing/otp/verify') {verifies++;return new Response(null,{status:204});}
        if(path===failedPath && !failed) {failed=true;return new Response(null,{status:503});}
        if(path==='/api/public/signing/current') return Response.json({id:'d0',sha256:'h0'});
        if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf'],{type:'application/pdf'}));
        throw new Error(`Unexpected request ${path}`);
      };
      let renderer:any;
      await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
      const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
      assert.ok(button('Retry document'),'document failure must offer a separate retry');
      await act(async()=>{await button('Retry document').props.onClick();}); await settle(act);
      assert.equal(verifies,0,'the document is read before the code');
      await act(async()=>{button('Continue').props.onClick();});
      await enterCode(renderer,act);
      assert.doesNotMatch(visibleText(renderer.toJSON()),/local-message-id/,'the message id is not shown');
      assert.match(visibleText(renderer.toJSON()),/012345/);
      assert.equal(renderer.root.findAllByType('input').filter((n:any)=>/^Digit \d of 6$/.test(n.props['aria-label'])).length,6,'six code boxes');
      await act(async()=>{await button('Verify code').props.onClick();});
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
      if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
      if(path==='/api/public/page-sessions/exchange') return Response.json({token:'test-token'});
      if(path==='/api/public/signing/otp') return Response.json({messageId:'local-message-id'},{status:202});
      if(path==='/api/public/signing/otp/verify') {if(++attempts===1) throw new Error('lost response');return new Response(null,{status:204});}
      if(path==='/api/public/signing/current') return Response.json({id:'d0',sha256:'h0'});
      if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf'],{type:'application/pdf'}));
      throw new Error('Unexpected request');};
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{button('Continue').props.onClick();});
    await enterCode(renderer,act);
    await act(async()=>{await button('Verify code').props.onClick();});
    await act(async()=>{await button('Verify code').props.onClick();});
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
      if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
      if(path==='/api/public/page-sessions/exchange') return Response.json({token:'test-token'});
      if(path==='/api/public/signing/otp') return Response.json({messageId:'test'});
      if(path==='/api/public/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/api/public/signing/current') return Response.json({id:'d0',sha256:'h0'});
      if(path==='/api/public/signing/pdf') return new Response(new Blob(['bad pdf']));
      throw new Error('Unexpected request');};
    let attempts=0, renderer:any;
    await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{if(++attempts===1) throw new Error('PDF pixel budget exceeded');}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    assert.ok(button('Retry document'));assert.equal(button('Continue'),undefined);assert.equal(button('Sign document'),undefined);
    assert.match(JSON.stringify(renderer.toJSON()),/Document unavailable/);
    await act(async()=>{await button('Retry document').props.onClick();}); await settle(act);
    await toSignStep(renderer,act);
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
      if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
      if(path==='/api/public/page-sessions/exchange') return Response.json({token:'token'});
      if(path==='/api/public/signing/otp') return Response.json({messageId:'test'});
      if(path==='/api/public/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/api/public/signing/current') return ++currentRequests===1?new Response(null,{status:503}):Response.json({id:'d0',sha256:'hash'});
      if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf']));
      throw new Error(path);};
    const makeNode=()=>({children:[] as any[],appendChild(node:any){this.children.push(node);},replaceChildren(...nodes:any[]){this.children=nodes;}});
    const visible:any=makeNode();visible.ownerDocument={createElement:()=>makeNode()};
    let release!:()=>void, oldSignal:AbortSignal|undefined;
    const oldRender=async (_blob:Blob,target:any,signal:AbortSignal)=>{oldSignal=signal;await new Promise<void>(resolve=>release=resolve);target.appendChild('old');};
    let renderCount=0;const render=async (blob:Blob,target:any,signal:AbortSignal)=>{if(++renderCount===1) return oldRender(blob,target,signal);target.appendChild('new');};
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:render}),{createNodeMock:()=>visible});}); await settle(act);
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    const retry=button('Retry document').props.onClick;
    await act(async()=>{await retry();}); await settle(act);
    await act(async()=>{await retry();}); await settle(act);
    await toSignStep(renderer,act);
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
      if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
      if(path==='/api/public/page-sessions/exchange') return Response.json({token:'token'});
      if(path==='/api/public/signing/otp') return Response.json({messageId:'test'});
      if(path==='/api/public/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/api/public/signing/current') {current++;if(current===1)return new Response(null,{status:503});if(current===2)return new Promise<Response>(resolve=>releaseOld=resolve);return Response.json({id:'new',sha256:'newhash'});}
      if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf']));
      if(path==='/api/public/signing/sign') {signed=JSON.parse(String(init?.body));return new Response(null,{status:202});}
      throw new Error(path);};
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    const retry=button('Retry document').props.onClick;let old:Promise<void>;
    await act(async()=>{old=retry();await Promise.resolve();});
    await act(async()=>{await retry();}); await settle(act);
    await act(async()=>{releaseOld(Response.json({id:'old',sha256:'oldhash'}));await old;});
    await toSignStep(renderer,act);
    await act(async()=>{consentBox(renderer).props.onChange({target:{checked:true}});});
    await act(async()=>{await button('Sign document').props.onClick();});
    assert.equal(signed.artifactId,'new');assert.equal(signed.artifactHash,'newhash');
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('positioned signatures fail closed when a page marker cannot be rendered',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;let signed:any;
 try{
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
  globalThis.fetch=async(input:any,init?:RequestInit)=>{const path=new URL(String(input)).pathname;
   if(path.endsWith('/signing-page'))return Response.json({hosts:[],signingEnabled:true});
   if(path.endsWith('/exchange'))return Response.json({token:'token'});
   if(path.endsWith('/otp'))return Response.json({messageId:'test'});
   if(path.endsWith('/verify'))return new Response(null,{status:204});
   if(path.endsWith('/current'))return Response.json({id:'d0',sha256:'hash',fields:[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:0,y:0,width:.3,height:.1}}]});
   if(path.endsWith('/pdf'))return new Response(new Blob(['pdf']));
   if(path.endsWith('/api/public/signing/preview'))return new Response(new Blob(['image'],{type:'image/png'}));
   if(path.endsWith('/sign')){signed=JSON.parse(String(init?.body));return new Response(null,{status:202});}
   throw new Error(path);
  };
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
  const button=(s:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(s));
  assert.equal(button('Sign document'),undefined);assert.equal(button('Continue'),undefined);assert.ok(button('Retry document'));assert.equal(signed,undefined);await act(async()=>r.unmount());
 }finally{globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('the page talks to its own origin only, and tells the exchange how it is framed',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  // [page origin, fragment, framing, what the exchange is told]
  for(const [origin,fragment,frame,expected] of [
   ['https://esign.example.test','#code=test-code',null,{embedded:false,embedder:''}],
   // The old local hosts are gone: a fragment never moves the page to another API.
   ['https://esign.example.test','#code=test-code&synthetic=1',null,{embedded:false,embedder:''}],
   ['http://127.0.0.1:5173','#code=test-code&upload=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,{embedded:false,embedder:''}],
   // Framed: the framing page's origin, from ancestorOrigins (with every ancestor, for the exchange to check each), else the referrer.
   ['https://esign.example.test','#code=test-code',{ancestorOrigins:['https://host.example.test']},{embedded:true,embedder:'https://host.example.test',embedders:['https://host.example.test']}],
   ['https://esign.example.test','#code=test-code',{referrer:'https://host.example.test/deals/1'},{embedded:true,embedder:'https://host.example.test'}],
   ['https://esign.example.test','#code=test-code',{},{embedded:true,embedder:''}],
  ] as const) {
   const urls:string[]=[];let exchange:unknown,removed=false;
   const win:any={location:{origin,hash:fragment,pathname:'/sign',...(frame&&'ancestorOrigins' in frame?{ancestorOrigins:frame.ancestorOrigins}:{})},history:{replaceState(){removed=true;}},document:{referrer:frame&&'referrer' in frame?frame.referrer:''}};
   win.parent=frame?{}:win;
   (globalThis as any).window=win;
   globalThis.fetch=async (input:any,init?:RequestInit)=>{urls.push(String(input));const path=new URL(String(input)).pathname;
    if(path==='/api/public/signing-page') return Response.json({hosts:[origin],signingEnabled:true});
    if(path==='/api/public/page-sessions/exchange'){exchange=JSON.parse(String(init?.body));return Response.json({error:'invalid_code'},{status:401});}
    throw new Error(path);};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage));});await settle(act);
   assert.equal(removed,true,'the code leaves the address bar');
   assert.deepEqual(urls,[`${origin}/api/public/signing-page`,`${origin}/api/public/page-sessions/exchange`],`${origin} ${fragment}`);
   assert.deepEqual(exchange,{code:'test-code',...expected});
   assert.match(JSON.stringify(renderer.toJSON()),/unavailable/i);
   await act(async()=>renderer.unmount());
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('after signing, the page says the signature is recorded: the app processes it itself',async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  for(const [origin,expected] of [
   ['https://esign.example.test','Signature recorded.'],
   ['http://127.0.0.1:5173','Signature recorded.'],
  ] as const) {
   (globalThis as any).window={location:{origin,hash:'#code=test',pathname:'/sign'},history:{replaceState(){}}};
   globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
    if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
    if(path==='/api/public/page-sessions/exchange') return Response.json({token:'token'});
    if(path==='/api/public/signing/otp') return Response.json({messageId:'test'});
    if(path==='/api/public/signing/otp/verify') return new Response(null,{status:204});
    if(path==='/api/public/signing/current') return Response.json({id:'artifact',sha256:'hash'});
    if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf']));
    if(path==='/api/public/signing/sign') return new Response(null,{status:202});
    throw new Error(path);};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
   const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
   await toSignStep(renderer,act);
   await act(async()=>{consentBox(renderer).props.onChange({target:{checked:true}});});
   await act(async()=>{await button('Sign document').props.onClick();});
   const text=JSON.stringify(renderer.toJSON());
   assert.ok(text.includes(`"${expected}"`),`${origin}: ${text}`);
   await act(async()=>{renderer.unmount();});
  }
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('the page says how the code was delivered, and points to the test mailbox only in dev', async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  // prod emails the signer; dev with a sink emails the sink and keeps a copy; dev without one only keeps it.
  for(const [otpResponse,expected,note] of [[{messageId:'m',emailed:true},'Verification code sent by email.',false],[{messageId:'m',emailed:true,testMailbox:true},'Verification code sent by email.',true],[{messageId:'m',testMailbox:true},'Test code saved to the test mailbox.',true]] as const) {
   (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
   globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
    if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
    if(path==='/api/public/page-sessions/exchange') return Response.json({token:'token'});
    if(path==='/api/public/signing/otp') return Response.json(otpResponse,{status:202});
    if(path==='/api/public/signing/current') return new Response(null,{status:401});
    throw new Error(path);};
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}));}); await settle(act);
   const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
   await settle(act);
   const rendered=JSON.stringify(renderer.toJSON());
   assert.ok(rendered.includes(`"${expected}"`),expected);
   assert.equal(rendered.includes('test mailbox, not to the signer'),note,`test mailbox note shown: ${note}`);
   assert.ok(!rendered.includes('local test'),'no local-test wording');
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
   if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
   if(path==='/api/public/page-sessions/exchange') return Response.json({token:'token'});
   if(path==='/api/public/signing/otp') return Response.json({messageId:'m'});
   if(path==='/api/public/signing/otp/verify') return new Response(null,{status:204});
   if(path==='/api/public/signing/current') return Response.json({id:'a1',sha256:'h1',disclosure:{version:'2026-11-07',text:'Consent to use electronic records and signatures\nYou may ask the sender for a paper copy.'}});
   if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf']));
   if(path==='/api/public/signing/sign') {signed=JSON.parse(String(init?.body));return new Response(null,{status:202});}
   throw new Error(path);};
  let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
  const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
  await toSignStep(renderer,act);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()),/paper copy/,'the disclosure opens from its link');
  await act(async()=>{button('Read the electronic records disclosure').props.onClick({preventDefault(){}});});
  const text=JSON.stringify(renderer.toJSON());
  assert.match(text,/Consent to use electronic records and signatures/);assert.match(text,/paper copy/);
  await act(async()=>{button('Close').props.onClick();});
  await act(async()=>{consentBox(renderer).props.onChange({target:{checked:true}});});
  await act(async()=>{await button('Sign document').props.onClick();});
  assert.equal(signed.disclosureVersion,'2026-11-07');assert.equal(signed.consent,true);
  await act(async()=>{renderer.unmount();});
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

/** The page on its Review step, its document loaded; toSign takes it through the code. */
async function reviewPage(current: Record<string, unknown>, onPost: (path: string, body: any) => Response | undefined) {
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
 globalThis.fetch=async (input:any,init?:RequestInit)=>{const path=new URL(String(input)).pathname;
  if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
  if(path==='/api/public/page-sessions/exchange') return Response.json({token:'token'});
  if(path==='/api/public/signing/otp') return Response.json({messageId:'m'});
  if(path==='/api/public/signing/otp/verify') return new Response(null,{status:204});
  if(path==='/api/public/signing/current') return Response.json(current);
  if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf']));
  const out=onPost(path,init?.body?JSON.parse(String(init.body)):undefined);if(out)return out;
  throw new Error(path);};
 let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){}})});}); await settle(act);
 const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
 const labelled=(label:string)=>renderer.root.findAll((n:any)=>n.props?.['aria-label']===label)[0];
 return {renderer,act,button,labelled,toSign:()=>toSignStep(renderer,act)};
}

test('signing for a company: the title and authority come first, on Review; the intent and the signature follow the code', async()=>{
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  let signed:any;
  const p=await reviewPage({id:'a1',sha256:'h1',intent:'I intend this to be my signature on Mutual NDA on behalf of Northbeam Consulting.',signer:{title:'Partner Manager',onBehalfOf:'Northbeam Consulting'}},(path,body)=>{if(path==='/api/public/signing/sign'){signed=body;return new Response(null,{status:202});}return undefined;});
  assert.equal(p.labelled('Your title').props.value,'Partner Manager');
  assert.equal(p.button('Continue').props.disabled,true,'authority not yet confirmed');
  await p.act(async()=>{p.labelled('Your title').props.onChange({target:{value:'Head of Partnerships'}});});
  await p.act(async()=>{p.labelled('Authorized to sign').props.onChange({target:{checked:true}});});
  assert.equal(p.button('Continue').props.disabled,false);
  await p.toSign();
  assert.match(JSON.stringify(p.renderer.toJSON()),/I intend this to be my signature on Mutual NDA on behalf of Northbeam Consulting\./);
  assert.equal(p.button('Sign document').props.disabled,true,'consent comes first');
  await p.act(async()=>{p.labelled('Consent to sign').props.onChange({target:{checked:true}});});
  assert.equal(p.button('Sign document').props.disabled,false);
  await p.act(async()=>{await p.button('Sign document').props.onClick();});
  assert.equal(signed.title,'Head of Partnerships');assert.equal(signed.authorityConfirmed,true);
  await p.act(async()=>{p.renderer.unmount();});
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('the signer may decline with a reason instead of signing: the code comes first, then the decline goes through', async()=>{
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  let declined:any;
  const p=await reviewPage({id:'a1',sha256:'h1',intent:'I intend this to be my signature on this document.'},(path,body)=>{if(path==='/api/public/signing/decline'){declined=body;return Response.json({status:'DECLINED'});}return undefined;});
  await p.act(async()=>{await p.button('Decline to sign').props.onClick();});
  assert.equal(p.button('Decline').props.disabled,true,'a reason comes first');
  await p.act(async()=>{p.labelled('Reason for declining').props.onChange({target:{value:'Clause 4 needs changes.'}});});
  await p.act(async()=>{await p.button('Decline').props.onClick();});
  assert.equal(declined,undefined,'not before the code');
  assert.match(JSON.stringify(p.renderer.toJSON()),/Confirm it's you to decline\./);
  await enterCode(p.renderer,p.act);
  await p.act(async()=>{await p.button('Verify code').props.onClick();});
  assert.deepEqual(declined,{reason:'Clause 4 needs changes.'});
  const text=JSON.stringify(p.renderer.toJSON());
  assert.match(text,/You declined to sign\. The sender has been told\./);
  assert.equal(p.button('Sign document'),undefined);
  await p.act(async()=>{p.renderer.unmount();});
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('Review names the document with its fingerprint and offers the PDF; Sign says how the signature reads and what happens next', async()=>{
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  const sha='ab'.repeat(32);
  const p=await reviewPage({id:'a1',sha256:sha,documentName:'Mutual NDA',signerName:'Ana Partner',intent:'I intend this to be my signature on Mutual NDA on behalf of Northbeam Consulting.',signer:{title:'Partner Manager',onBehalfOf:'Northbeam Consulting'}},()=>undefined);
  assert.ok(p.labelled('Document details'));
  assert.ok(p.labelled('Signing steps'));
  assert.match(JSON.stringify(p.renderer.toJSON()),/Mutual NDA/);
  assert.match(JSON.stringify(p.renderer.toJSON()),/abab abab abab … abab abab/);
  const link=p.renderer.root.findAll((n:any)=>n.type==='a'&&n.props.download)[0];
  assert.equal(link.props.download,'Mutual NDA.pdf');assert.match(link.props.href,/^blob:/);
  assert.match(JSON.stringify(p.renderer.toJSON()),/Ana Partner/);
  // The signature line follows the title the signer gives on Review.
  await p.act(async()=>{p.labelled('Your title').props.onChange({target:{value:'Head of Partnerships'}});});
  await p.act(async()=>{p.labelled('Authorized to sign').props.onChange({target:{checked:true}});});
  await p.toSign();
  const out=JSON.stringify(p.renderer.toJSON());
  assert.match(out,/Ana Partner · Head of Partnerships, Northbeam Consulting · Signed electronically through Esign/);
  assert.match(out,/After you sign/);
  // Back returns to Review with what was entered.
  await p.act(async()=>{p.button('Back').props.onClick();});
  assert.equal(p.labelled('Your title').props.value,'Head of Partnerships');
  await p.act(async()=>{p.renderer.unmount();});
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('signatureCaption leaves out what is not known', ()=>{
 assert.equal(page.signatureCaption('Ana Partner','Partner Manager','Northbeam Consulting'),'Ana Partner · Partner Manager, Northbeam Consulting · Signed electronically through Esign');
 assert.equal(page.signatureCaption('Ana Partner','',undefined),'Ana Partner · Signed electronically through Esign');
 assert.equal(page.signatureCaption('','',undefined),'Signed electronically through Esign');
});

test('the code boxes take one digit each, move on, go back and take a paste', ()=>{
  assert.equal(page.nextCode('',0,'4'),'4');
  assert.equal(page.nextCode('4',1,'2'),'42');
  assert.equal(page.nextCode('42',4,'7'),'427','a box past the end types into the next empty one');
  assert.equal(page.nextCode('427',1,'27'),'477','typing over a filled box keeps the new digit');
  assert.equal(page.nextCode('427',1,''),'4','clearing a box drops it and the ones after');
  assert.equal(page.nextCode('',0,'123456'),'123456','a paste fills every box');
  assert.equal(page.nextCode('9',1,'1 2-3 4567'),'912345','only digits, at most six');
  assert.equal(page.nextCode('12',2,'x'),'12');
});

test('the code countdown shows minutes and seconds and stops at zero', ()=>{
  assert.equal(page.codeTimeLeft(10*60*1000),'10:00');
  assert.equal(page.codeTimeLeft(552_000),'9:12');
  assert.equal(page.codeTimeLeft(4_200),'0:05');
  assert.equal(page.codeTimeLeft(-1),'0:00');
});

test('full-width digits from an East Asian input method count as digits', ()=>{
  assert.equal(page.codeDigits('１２３ ４５６'),'123456');
  assert.equal(page.nextCode('',0,'４'),'4');
  assert.equal(page.nextCode('',0,'１２３４５６'),'123456');
});

test('a refused code or send says what to do next', ()=>{
  assert.deepEqual(page.codeProblem(401,'invalid_otp',{attemptsLeft:4},'verify'),{text:'That code is not right. Use the code in the latest email. 4 tries left.',clear:true,retryAfterMs:0});
  assert.match(page.codeProblem(401,'invalid_otp',{attemptsLeft:1},'verify').text,/1 try left/);
  assert.deepEqual(page.codeProblem(429,'otp_rate_limited',{retryAfterSeconds:42},'send'),{text:'Too many codes were asked for. You can ask for a new code in 0:42.',clear:false,retryAfterMs:42000});
  assert.equal(page.codeProblem(429,'otp_attempts_exhausted',{retryAfterSeconds:600},'verify').text,'Too many wrong codes. You can ask for a new code in 10:00.');
  assert.match(page.codeProblem(409,'otp_superseded',{},'verify').text,/newer code was sent/);
  assert.match(page.codeProblem(401,'otp_expired',{},'verify').text,/expired/);
  assert.match(page.codeProblem(401,'invalid_session',{},'verify').text,/session has ended/);
  // A lost response: the same code may still work.
  assert.equal(page.codeProblem(0,'',{},'verify').text,'Code verification unavailable. Retry the same code.');
  assert.match(page.codeProblem(429,'otp_unavailable',{},'send').text,/Could not send a code/);
});

test('the code card shows a wrong code and a refused send beside the boxes, and Resend waits', async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let renderer:any;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test-code',pathname:'/'},history:{replaceState(){}}};
    let sends=0;
    globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
      if(path==='/api/public/signing-page') return Response.json({hosts:[],signingEnabled:true});
      if(path==='/api/public/page-sessions/exchange') return Response.json({token:'test-token'});
      if(path==='/api/public/signing/otp') return ++sends===1?Response.json({messageId:'m',emailed:true},{status:202}):Response.json({error:'otp_rate_limited',retryAfterSeconds:42},{status:429});
      if(path==='/api/public/signing/otp/verify') return Response.json({error:'invalid_otp',attemptsLeft:3},{status:401});
      if(path==='/api/public/signing/current') return Response.json({id:'d0',sha256:'h0'});
      if(path==='/api/public/signing/pdf') return new Response(new Blob(['pdf'],{type:'application/pdf'}));
      throw new Error('Unexpected request');};
    await act(async()=>{renderer=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:async()=>{}}),{createNodeMock:()=>({ownerDocument:{createElement:()=>({})},replaceChildren(){},focus(){}})});}); await settle(act);
    const button=(text:RegExp)=>renderer.root.findAllByType('button').find((b:any)=>text.test(visibleText(b.children)));
    const alert=()=>renderer.root.findAll((n:any)=>n.type==='p'&&n.props.role==='alert').map((n:any)=>visibleText(n.children)).join(' ');
    const digits=()=>renderer.root.findAll((n:any)=>n.type==='input'&&/^Digit/.test(n.props['aria-label'])).map((n:any)=>n.props.value).join('');
    await act(async()=>{button(/^Continue$/).props.onClick();});
    await enterCode(renderer,act);
    // Resend waits the minute the Worker asks for between sends.
    assert.match(visibleText(button(/^Resend code/).children),/^Resend code in (0:59|1:00)$/);
    assert.equal(button(/^Resend code/).props.disabled,true);
    await act(async()=>{await button(/^Verify code$/).props.onClick();});
    assert.equal(alert(),'That code is not right. Use the code in the latest email. 3 tries left.');
    assert.equal(digits(),'','the boxes are cleared for the right code');
    // Typing clears the note.
    await enterCode(renderer,act,'1');
    assert.equal(alert(),'');
  } finally {await act(async()=>{renderer?.unmount();});globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('About signing explains the steps, the code, declining and the copy link, and closes again', async()=>{
 const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 try {
  const p=await reviewPage({id:'a1',sha256:'ab'.repeat(32),documentName:'Mutual NDA',signerName:'Ana Partner'},()=>undefined);
  const dialog=()=>p.renderer.root.findAll((n:any)=>n.props?.role==='dialog'&&n.props['aria-label']==='About signing')[0];
  assert.equal(dialog(),undefined);
  await p.act(async()=>{p.button('About signing').props.onClick();});
  const help=visibleText(dialog().children);
  assert.match(help,/asked you to sign Mutual NDA/);
  for(const words of [/Review/,/6-digit code/,/10 minutes/,/Decline to sign/,/once, within 30 days/,/audit trail/])assert.match(help,words);
  await p.act(async()=>{p.button('Close').props.onClick();});
  assert.equal(dialog(),undefined);
  await p.act(async()=>{p.renderer.unmount();});
 } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('Back and Continue again keep the signature preview\'s image alive: the Sign step never shows a revoked URL', async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL,oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 const revoked=new Set<string>();let made=0;
 URL.createObjectURL=()=>`blob:test/${++made}`;URL.revokeObjectURL=(url:string)=>{revoked.add(url);};
 try{
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
  globalThis.fetch=async(input:any)=>{const path=new URL(String(input)).pathname;
   if(path.endsWith('/signing-page'))return Response.json({hosts:[],signingEnabled:true});
   if(path.endsWith('/exchange'))return Response.json({token:'token'});
   if(path.endsWith('/otp'))return Response.json({messageId:'test'});
   if(path.endsWith('/verify'))return new Response(null,{status:204});
   if(path.endsWith('/current'))return Response.json({id:'d0',sha256:'hash',fields:[{id:'s1',type:'Signature',page:1,required:true,rect:{x:0.1,y:0.6,width:0.4,height:0.08}}]});
   if(path.endsWith('/pdf'))return new Response(new Blob(['pdf']));
   if(path.endsWith('/api/public/signing/preview'))return new Response(new Blob(['png']),{headers:{'X-Signature-Preview':'a'.repeat(64),'X-Signature-Width':'0.4','X-Signature-Height':'0.08'}});
   throw new Error(path);};
  // Just enough DOM for one rendered page: a canvas the page wraps in its host.
  const node=():any=>({nodeType:1,style:{},dataset:{},children:[] as any[],appendChild(child:any){this.children.push(child);},replaceChildren(...nodes:any[]){this.children=nodes;},replaceWith(){},querySelectorAll(){return this.children.filter((c:any)=>c.canvas);},ownerDocument:{createElement:()=>node()}});
  const render=async(_blob:Blob,target:any)=>{target.appendChild({...node(),canvas:true});};
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:render}),{createNodeMock:()=>node()});}); await settle(act);
  const button=(s:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(s));
  await toSignStep(r,act);
  await act(async()=>{r.root.findAll((n:any)=>n.props?.['aria-label']==='Full name')[0].props.onChange({target:{value:'Ana Ribeiro'}});}); await settle(act);
  const shown=()=>r.root.findAll((n:any)=>n.type==='img'&&n.props.alt==='Your signature')[0]?.props.src;
  const first=shown();
  assert.ok(first&&!revoked.has(first),'the preview shows');
  await act(async()=>{button('Back').props.onClick();});
  await act(async()=>{button('Continue').props.onClick();});
  const again=shown();
  assert.ok(again,'the preview shows again');
  assert.ok(!revoked.has(again),`the image a person sees is never a revoked URL: ${again} of ${[...revoked]}`);
  await act(async()=>{r.unmount();});
 } finally {URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('each field is signed by selecting it: Sign waits for every required one, an optional one may stay empty, and only the signed ones are sent', async()=>{
 const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL,oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
 let made=0,signed:any=null;
 URL.createObjectURL=()=>`blob:test/${++made}`;URL.revokeObjectURL=()=>{};
 const rect=(y:number)=>({x:0.1,y,width:0.4,height:0.08});
 try{
  (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
  globalThis.fetch=async(input:any,init?:any)=>{const path=new URL(String(input)).pathname;
   if(path.endsWith('/signing-page'))return Response.json({hosts:[],signingEnabled:true});
   if(path.endsWith('/exchange'))return Response.json({token:'token'});
   if(path.endsWith('/otp'))return Response.json({messageId:'test'});
   if(path.endsWith('/verify'))return new Response(null,{status:204});
   if(path.endsWith('/current'))return Response.json({id:'d0',sha256:'hash',fields:[{id:'s1',type:'Signature',page:1,required:true,rect:rect(0.1)},{id:'s2',type:'Signature',page:1,required:false,rect:rect(0.3)},{id:'t1',type:'Title',page:1,required:false,rect:rect(0.5)}]});
   if(path.endsWith('/pdf'))return new Response(new Blob(['pdf']));
   if(path.endsWith('/api/public/signing/preview'))return new Response(new Blob(['png']),{headers:{'X-Signature-Preview':'a'.repeat(64),'X-Signature-Width':'0.4','X-Signature-Height':'0.08'}});
   if(path.endsWith('/api/public/signing/sign')){signed=JSON.parse(init.body);return Response.json({});}
   throw new Error(path);};
  const node=():any=>({nodeType:1,style:{},dataset:{},children:[] as any[],appendChild(child:any){this.children.push(child);},replaceChildren(...nodes:any[]){this.children=nodes;},replaceWith(){},querySelectorAll(){return this.children.filter((c:any)=>c.canvas);},ownerDocument:{createElement:()=>node(),querySelector:()=>null}});
  const render=async(_blob:Blob,target:any)=>{target.appendChild({...node(),canvas:true});};
  let r:any;await act(async()=>{r=Renderer.create(React.createElement(page.RecipientPage,{renderDocument:render}),{createNodeMock:()=>node()});}); await settle(act);
  const button=(s:string)=>r.root.findAllByType('button').find((b:any)=>b.children.includes(s));
  const text=()=>r.root.findAll((n:any)=>typeof n.type==='string').flatMap((n:any)=>n.children.filter((c:any)=>typeof c==='string')).join(' ');
  const item=(i:number)=>r.root.findAll((n:any)=>n.type==='li'&&n.props['data-field-state'])[i];
  await toSignStep(r,act);
  await act(async()=>{r.root.findAll((n:any)=>n.props?.['aria-label']==='Full name')[0].props.onChange({target:{value:'Ana Ribeiro'}});}); await settle(act);
  await act(async()=>{r.root.findAll((n:any)=>n.props?.['aria-label']==='Consent to sign'&&n.type==='input')[0].props.onChange({target:{checked:true}});}); await settle(act);
  // Nothing is signed yet: the required signature holds Sign back.
  assert.deepEqual([0,1,2].map(i=>item(i).props['data-field-state']),['required','optional','optional']);
  assert.match(text(),/1 required field left to sign/);
  assert.equal(button('Sign document').props.disabled,true,'a required field is not signed');
  // Signing the optional one alone isn't enough; removing it again leaves it empty.
  await act(async()=>{item(1).findAllByType('button')[0].props.onClick();}); await settle(act);
  assert.equal(item(1).props['data-field-state'],'signed');
  assert.equal(button('Sign document').props.disabled,true);
  await act(async()=>{item(1).findAllByType('button')[0].props.onClick();}); await settle(act);
  assert.equal(item(1).props['data-field-state'],'optional');
  // The required one signed: Sign goes ahead, with that field and its preview only.
  await act(async()=>{item(0).findAllByType('button')[0].props.onClick();}); await settle(act);
  assert.match(text(),/Every required field is signed/);
  assert.equal(button('Sign document').props.disabled,false);
  await act(async()=>{await button('Sign document').props.onClick();}); await settle(act);
  assert.deepEqual(signed.signatures,{s1:'Ana Ribeiro'});
  assert.deepEqual(Object.keys(signed.signaturePreviews),['s1']);
  assert.deepEqual(signed.textPreviews,{});
  await act(async()=>{r.unmount();});
 } finally {URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
