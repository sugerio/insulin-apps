import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HostPage, CompletionCertificate} from '../ui/HostPage.ts';
const certificate={mode:'LOCAL TEST ONLY',envelope:{id:'envelope',template_id:'template',created_at:1700000000000,status:'COMPLETED'},source:{id:'doc-0',sha256:'a'.repeat(64)},finalArtifactId:'doc-2',finalSha256:'c'.repeat(64),recipients:[{id:'task-1',role:'first',recipient_name:'<img src=x onerror=alert(1)>',recipient_email:'ana@example.com',routing_order:1,status:'SIGNED'},{id:'task-2',role:'second',recipient_name:'Marcus',recipient_email:'marcus@example.com',routing_order:2,status:'SIGNED'}],signatures:[{id:'sig-1',sequence:1,task_id:'task-1',recipient_name:'<img src=x onerror=alert(1)>',input_artifact_id:'doc-0',input_sha256:'a'.repeat(64),otp_verified_at:1700000000000,consented_at:1700000001000,previous_hash:'',event_hash:'d'.repeat(64),artifact_id:'doc-1',sha256:'b'.repeat(64)},{id:'sig-2',sequence:2,task_id:'task-2',recipient_name:'Marcus',input_artifact_id:'doc-1',input_sha256:'b'.repeat(64),otp_verified_at:1700000002000,consented_at:1700000003000,previous_hash:'d'.repeat(64),event_hash:'e'.repeat(64),artifact_id:'doc-2',sha256:'c'.repeat(64)}]};
async function loadTemplate(renderer:any,act:any) {
  await act(async()=>{renderer.root.findByProps({'aria-label':'Template ID'}).props.onChange({target:{value:'t'}});});
  await act(async()=>{renderer.root.findAllByType('button').find((b:any)=>b.children.includes('Load template')).props.onClick();});
  for(const [name,value] of [['first name','Ana'],['first email','ana@example.com'],['second name','Marcus'],['second email','marcus@example.com']])
    await act(async()=>{renderer.root.findByProps({'aria-label':name}).props.onChange({target:{value}});});
}
test('certificate is readable, accurate, and escapes untrusted names',()=>{
  const html=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate}));
  for(const text of ['Certificate of completion','LOCAL TEST ONLY','doc-0','doc-2','Marcus','ana@example.com','2023-11-14T22:13:21.000Z','OTP','consent','manifest','not sealed','not a legal guarantee', 'a'.repeat(64),'e'.repeat(64)]) assert.ok(html.includes(text),text);
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('host launches from templates without the legacy upload workflow',()=>{
  const html=renderToStaticMarkup(React.createElement(HostPage));
  assert.match(html,/synthetic/i); assert.match(html,/Template ID/); assert.doesNotMatch(html,/Create envelope|First signer|Second signer|Synthetic PDF|type="file"|management key/i);
});

test('host interaction creates ordered envelope, opens views, processes and displays the delivery PDF',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldStorage=(globalThis as any).localStorage;
  const calls:{path:string;init:RequestInit}[]=[];let status='ACTIVE', active=0;const storage=new Map<string,string>();
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'}};
    (globalThis as any).localStorage={getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v)};
    globalThis.fetch=async (input:any,init:RequestInit={})=>{const path=String(input);calls.push({path,init});
      if(path==='/host/templates/t') return Response.json({id:'t',roles:['first','second'],hasPositionedFields:false});
      if(path==='/host/envelopes') return Response.json({id:'envelope'});
      if(path==='/host/envelopes/envelope') return Response.json({id:'envelope',templateId:'t',status,tasks:[0,1].map(i=>({id:`task-${i}`,recipientName:i?'Marcus':'Ana',recipientEmail:i?'marcus@example.com':'ana@example.com',status:i===active?'ACTIVE':'PENDING',routingOrder:i+1}))});
      if(path.endsWith('/recipient-view')) return Response.json({code:`code-${active}`});
      if(path.endsWith('/process')) {if(active===0) active=1;else status='FINALIZING';return new Response(null,{status:204});}
      if(path.endsWith('/finalize')) {status='COMPLETED';return new Response(null,{status:204});}
      if(path.endsWith('/certificate')) return Response.json(certificate);
      if(path.endsWith('/delivery-pdf')) return new Response(new Blob(['pdf'],{type:'application/pdf'}));
      throw new Error(`Unexpected ${path}`);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await loadTemplate(renderer,act);
    await act(async()=>{await button('Start signing from template').props.onClick();});
    const body=JSON.parse(String(calls.find(c=>c.path==='/host/envelopes')!.init.body));
    assert.deepEqual(body.recipients.map((r:any)=>r.email),['ana@example.com','marcus@example.com']);
    assert.equal(storage.get('esign-local-envelope'),'envelope');
    const envelopeText=JSON.stringify(renderer.toJSON());assert.match(envelopeText,/Template ID: /);assert.match(envelopeText,/\"t\"/);assert.match(envelopeText,/Existing envelopes do not change/);
    await act(async()=>{await button('Open signing view').props.onClick();});
    assert.equal(renderer.root.findByType('iframe').props.src,'/#code=code-0');
    await act(async()=>{await button('Process signature').props.onClick();});
    await act(async()=>{await renderer.root.findAllByType('button').filter((b:any)=>b.children.includes('Open signing view'))[1].props.onClick();});
    assert.equal(renderer.root.findByType('iframe').props.src,'/#code=code-1');
    await act(async()=>{await button('Process signature').props.onClick();});
    await act(async()=>{await button('Finalize').props.onClick();});
    await act(async()=>{await button('View delivery PDF with certificate').props.onClick();});
    assert.ok(renderer.root.findAllByType('a').some((a:any)=>a.props.download==='delivery-local-test.pdf'));
    assert.ok(!calls.some(c=>c.path.endsWith('/prepare')),'creating the envelope prepares it');
    await act(async()=>{await button('View completion certificate').props.onClick();});
    const rendered=JSON.stringify(renderer.toJSON());
    for(const value of ['Certificate of completion','Marcus','ana@example.com','doc-0','doc-2','2023-11-14T22:13:21.000Z','d'.repeat(64)]) assert.ok(rendered.includes(value),value);
    assert.equal(renderer.root.findAllByType('img').length,0);
    assert.ok(rendered.includes('<img src=x onerror=alert(1)>'));
    assert.ok(renderer.root.findAllByType('a').some((a:any)=>a.props.download==='local-test-certificate.json'));
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('host restores only envelope ID and requests a new one-use view after refresh',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldStorage=(globalThis as any).localStorage;
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'}};
    (globalThis as any).localStorage={getItem:()=> 'restored'};
    let views=0;
    globalThis.fetch=async(input:any)=>String(input).endsWith('/recipient-view')?(views++,Response.json({code:'fresh-code'})):Response.json({id:'restored',templateId:'old-template',status:'ACTIVE',tasks:[{id:'task',recipientName:'Ana',recipientEmail:'ana@example.com',status:'ACTIVE',routingOrder:1}]});
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    assert.equal(renderer.root.findAllByType('iframe').length,0);assert.match(JSON.stringify(renderer.toJSON()),/old-template/);
    await act(async()=>{await renderer.root.findAllByType('button').find((b:any)=>b.children.includes('Open signing view')).props.onClick();});
    assert.equal(views,1);assert.equal(renderer.root.findByType('iframe').props.src,'/#code=fresh-code');
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('a delayed delivery PDF for the previous envelope is discarded after creating another envelope',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldStorage=(globalThis as any).localStorage,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  let pdfCalls=0;let resolvePdf!:(r:Response)=>void;const pending=new Promise<Response>(resolve=>{resolvePdf=resolve;});const created:string[]=[],revoked:string[]=[];
  try {
    URL.createObjectURL=()=>{const url=`blob:test-${created.length}`;created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);};
    (globalThis as any).localStorage={getItem:()=> 'A',setItem() {}};
    globalThis.fetch=async(input:any)=>{const path=String(input);
      if(path==='/host/envelopes/A')return Response.json({id:'A',status:'COMPLETED',tasks:[]});
      if(path==='/host/envelopes/A/delivery-pdf')return ++pdfCalls===1?new Response(new Blob(['earlier A'])):pending;
      if(path==='/host/templates/t')return Response.json({id:'t',roles:['first','second'],hasPositionedFields:false});
      if(path==='/host/envelopes')return Response.json({id:'B'});
      if(path==='/host/envelopes/B')return Response.json({id:'B',status:'IN_PROGRESS',tasks:[]});
      throw new Error(path);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{await button('View delivery PDF with certificate').props.onClick();});
    assert.equal(renderer.root.findAllByType('a').find((a:any)=>a.props.download==='delivery-local-test.pdf').props.href,'blob:test-0');
    let pdfRequest:Promise<void>;await act(async()=>{pdfRequest=button('View delivery PDF with certificate').props.onClick();});
    await loadTemplate(renderer,act);
    await act(async()=>{await button('Start signing from template').props.onClick();});
    await act(async()=>{resolvePdf(new Response(new Blob(['A'])));await pdfRequest;});
    assert.match(JSON.stringify(renderer.toJSON()),/Envelope.*B/);
    assert.equal(renderer.root.findAllByType('a').filter((a:any)=>a.props.download==='delivery-local-test.pdf').length,0);
    assert.deepEqual(created,['blob:test-0']);assert.deepEqual(revoked,['blob:test-0']);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('late signing view from previous envelope cannot appear after selecting a new envelope',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldStorage=(globalThis as any).localStorage;
  let viewCalls=0;let resolveView!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>{resolveView=resolve;});
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'}};
    (globalThis as any).localStorage={getItem:()=> 'A',setItem() {}};
    globalThis.fetch=async(input:any)=>{const path=String(input);
      if(path==='/host/envelopes/A')return Response.json({id:'A',status:'ACTIVE',tasks:[{id:'task-a',recipientName:'Ana',recipientEmail:'ana@example.com',status:'ACTIVE',routingOrder:1}]});
      if(path==='/host/envelopes/A/tasks/task-a/recipient-view')return ++viewCalls===1?Response.json({code:'earlier-a'}):pending;
      if(path==='/host/templates/t')return Response.json({id:'t',roles:['first','second'],hasPositionedFields:false});
      if(path==='/host/envelopes')return Response.json({id:'B'});
      if(path==='/host/envelopes/B')return Response.json({id:'B',status:'ACTIVE',tasks:[]});
      throw new Error(path);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    await act(async()=>{await button('Open signing view').props.onClick();});
    assert.equal(renderer.root.findByType('iframe').props.src,'/#code=earlier-a');
    let view:Promise<void>;await act(async()=>{view=button('Open signing view').props.onClick();});
    assert.equal(renderer.root.findAllByType('iframe').length,0);
    await loadTemplate(renderer,act);
    await act(async()=>{await button('Start signing from template').props.onClick();});
    assert.match(JSON.stringify(renderer.toJSON()),/Envelope.*B/);
    await act(async()=>{resolveView(Response.json({code:'old-a'}));await view;});
    assert.equal(renderer.root.findAllByType('iframe').length,0);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('concurrent signing views show only the latest requested recipient regardless of response order',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldStorage=(globalThis as any).localStorage;
  let resolveFirst!:(response:Response)=>void,resolveSecond!:(response:Response)=>void;
  const first=new Promise<Response>(resolve=>{resolveFirst=resolve;}),second=new Promise<Response>(resolve=>{resolveSecond=resolve;});
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'}};
    (globalThis as any).localStorage={getItem:()=> 'A'};
    globalThis.fetch=async(input:any)=>{const path=String(input);
      if(path==='/host/envelopes/A')return Response.json({id:'A',status:'ACTIVE',tasks:['first','second'].map((id,i)=>({id,recipientName:id,recipientEmail:`${id}@example.com`,status:'ACTIVE',routingOrder:i+1}))});
      if(path==='/host/envelopes/A/tasks/first/recipient-view')return first;
      if(path==='/host/envelopes/A/tasks/second/recipient-view')return second;
      throw new Error(path);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    const buttons=()=>renderer.root.findAllByType('button').filter((b:any)=>b.children.includes('Open signing view'));
    let firstRequest:Promise<void>,secondRequest:Promise<void>;
    await act(async()=>{firstRequest=buttons()[0].props.onClick();secondRequest=buttons()[1].props.onClick();});
    await act(async()=>{resolveSecond(Response.json({code:'second-code'}));await secondRequest;});
    assert.equal(renderer.root.findByType('iframe').props.src,'/#code=second-code');
    await act(async()=>{resolveFirst(Response.json({code:'first-code'}));await firstRequest;});
    assert.equal(renderer.root.findByType('iframe').props.src,'/#code=second-code');
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('processing invalidates a pending signing view',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window,oldStorage=(globalThis as any).localStorage;
  let resolveView!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>{resolveView=resolve;});
  try {
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173'}};(globalThis as any).localStorage={getItem:()=> 'A'};
    globalThis.fetch=async(input:any)=>{const path=String(input);
      if(path==='/host/envelopes/A')return Response.json({id:'A',status:'ACTIVE',tasks:[{id:'task',recipientName:'Ana',recipientEmail:'ana@example.com',status:'ACTIVE',routingOrder:1}]});
      if(path.endsWith('/recipient-view'))return pending;
      if(path.endsWith('/process'))return new Response(null,{status:204});
      throw new Error(path);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    let view:Promise<void>;await act(async()=>{view=button('Open signing view').props.onClick();});
    await act(async()=>{await button('Process signature').props.onClick();});
    await act(async()=>{resolveView(Response.json({code:'old-code'}));await view;});
    assert.equal(renderer.root.findAllByType('iframe').length,0);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('certificate is limited to completed envelopes and ignores a late response after switching',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldStorage=(globalThis as any).localStorage;
  let resolve!:(response:Response)=>void;const pending=new Promise<Response>(r=>resolve=r);
  try {
    (globalThis as any).localStorage={getItem:()=> 'A',setItem() {}};
    globalThis.fetch=async(input:any)=>{const path=String(input);
      if(path==='/host/envelopes/A')return Response.json({id:'A',status:'COMPLETED',tasks:[]});
      if(path==='/host/envelopes/A/certificate')return pending;
      if(path==='/host/templates/t')return Response.json({id:'t',roles:['first','second'],hasPositionedFields:false});
      if(path==='/host/envelopes')return Response.json({id:'B'});
      if(path==='/host/envelopes/B')return Response.json({id:'B',status:'ACTIVE',tasks:[]});
      throw new Error(path);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    let request:Promise<void>;await act(async()=>{request=button('View completion certificate').props.onClick();});
    await loadTemplate(renderer,act);
    await act(async()=>{await button('Start signing from template').props.onClick();});
    assert.equal(button('View completion certificate'),undefined);
    await act(async()=>{resolve(Response.json(certificate));await request;});
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()),/Certificate of completion|doc-0/);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('template launch locks duplicate requests and ignores a late restore',async()=>{
  const {default:Renderer,act}=await import('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldStorage=(globalThis as any).localStorage;
  let resolveRestore!:(r:Response)=>void,resolveCreate!:(r:Response)=>void,creates=0;
  const restore=new Promise<Response>(r=>resolveRestore=r),create=new Promise<Response>(r=>resolveCreate=r);
  try {
    (globalThis as any).localStorage={getItem:()=> 'old',setItem(){}};
    globalThis.fetch=async(input:any)=>{const path=String(input);
      if(path==='/host/envelopes/old')return restore;
      if(path==='/host/templates/t')return Response.json({id:'t',roles:['first','second'],hasPositionedFields:false});
      if(path==='/host/envelopes'){creates++;return create;}
      if(path==='/host/envelopes/B')return Response.json({id:'B',status:'ACTIVE',tasks:[]});
      throw new Error(path);
    };
    let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(HostPage));});
    await loadTemplate(renderer,act);
    const start=()=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes('Start signing from template'));
    let first:Promise<void>;await act(async()=>{first=start().props.onClick();start().props.onClick();});
    assert.equal(creates,1);assert.equal(start().props.disabled,true);
    await act(async()=>{resolveCreate(Response.json({id:'B'}));await first;resolveRestore(Response.json({id:'old',status:'ACTIVE',tasks:[]}));});
    assert.match(JSON.stringify(renderer.toJSON()),/Envelope.*B/);assert.doesNotMatch(JSON.stringify(renderer.toJSON()),/Could not restore/);
    await act(async()=>renderer.unmount());
  } finally {globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
