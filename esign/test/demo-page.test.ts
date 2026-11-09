// The /demo page drives the Worker API on its own origin with a pasted tenant key: upload a
// PDF, send to one or two signers (signature page or editor-placed fields), open each signer's
// page, and fetch the results once the Worker has completed the envelope.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

const ORIGIN='https://esign.example.test';
const KEY='d'.repeat(64);
type Call={path:string;method:string;headers:Record<string,string>;body:unknown};

function memoryStorage(){const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v),removeItem:(k:string)=>void m.delete(k),map:m};}

async function harness(routes:(call:Call)=>Response|undefined,{storedKey=''}={}){
 const {default:Renderer,act}=await import('react-test-renderer');
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const session=memoryStorage(),local=memoryStorage();if(storedKey)session.setItem('esign-demo-key',storedKey);
 const listeners=new Set<(e:unknown)=>void>();
 (globalThis as any).window={location:{origin:ORIGIN},sessionStorage:session,localStorage:local,
  addEventListener:(type:string,f:(e:unknown)=>void)=>{if(type==='message')listeners.add(f);},removeEventListener:(type:string,f:(e:unknown)=>void)=>listeners.delete(f)};
 const calls:Call[]=[];
 globalThis.fetch=(async(input:any,init:RequestInit={})=>{
  const call={path:String(input),method:init.method??'GET',headers:{...(init.headers as Record<string,string>)},body:init.body};
  calls.push(call);
  const response=routes(call);
  if(!response)throw new Error(`unexpected ${call.method} ${call.path}`);
  return response;
 }) as typeof fetch;
 const posted:unknown[]=[];const editorWindow={postMessage:(m:unknown)=>posted.push(m)};
 const {DemoPage}=await import('../ui/DemoPage.ts');
 let renderer:any;
 await act(async()=>{renderer=Renderer.create(React.createElement(DemoPage),{createNodeMock:()=>({contentWindow:editorWindow})});});
 const text=()=>JSON.stringify(renderer.toJSON());
 const byLabel=(label:string)=>renderer.root.find((n:any)=>n.props['aria-label']===label);
 const button=(name:string)=>renderer.root.findAllByType('button').find((b:any)=>JSON.stringify(b.children).includes(name));
 const type=async(label:string,value:string)=>act(async()=>{byLabel(label).props.onChange({target:{value}});});
 const click=async(name:string)=>{const b=button(name);assert.ok(b,`button ${name}: ${text()}`);await act(async()=>{b.props.onClick();await new Promise(r=>setTimeout(r,0));});};
 const dispatch=async(event:unknown)=>act(async()=>{for(const f of listeners)f(event);await new Promise(r=>setTimeout(r,0));});
 return {renderer,act,calls,session,local,text,byLabel,button,type,click,dispatch,posted,editorWindow,unmount:async()=>act(async()=>renderer.unmount())};
}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const pdf=()=>new File(['%PDF-1.7 synthetic'],'synthetic.pdf',{type:'application/pdf'});
const envelope=(status:string,tasks:[string,string][])=>({id:'11111111-1111-4111-8111-111111111111',templateId:'t',status,tasks:tasks.map(([name,s],i)=>({id:`task-${i}`,role:`signer-${i+1}`,recipientName:name,recipientEmail:`${name.toLowerCase()}@partner.example`,status:s,routingOrder:i+1}))});
const ENV_ID='11111111-1111-4111-8111-111111111111';

test('connecting checks the pasted key and keeps it only in this tab', async()=>{
 const h=await harness(c=>{if(c.path==='/v1/me')return c.headers.authorization===`Bearer ${KEY}`?json({tenantId:'demo-tenant'}):json({error:'unauthorized'},401);});
 try {
  await h.type('Tenant management key','e'.repeat(64));await h.click('Connect');
  assert.match(h.text(),/The key was not accepted/);assert.equal(h.session.map.size,0);
  await h.type('Tenant management key',KEY);await h.click('Connect');
  assert.match(h.text(),/demo-tenant/);assert.equal(h.session.getItem('esign-demo-key'),KEY);assert.equal(h.local.map.has('esign-demo-key'),false);
  await h.click('Disconnect');assert.equal(h.session.map.size,0);assert.match(h.text(),/Tenant management key/);
 } finally {await h.unmount();}
});

test('sending adds a signature page, signs in order through the embedded signing page, and offers the results', async()=>{
 let state=envelope('IN_PROGRESS',[['Ana','ACTIVE'],['Marcus','PENDING']]);
 const h=await harness(c=>{
  if(c.path==='/v1/me')return json({tenantId:'demo-tenant'});
  if(c.path==='/v1/templates'&&c.method==='POST')return json({id:'tpl-1',roles:['signer-1','signer-2']},201);
  if(c.path==='/v1/envelopes'&&c.method==='POST')return json({id:ENV_ID,status:'IN_PROGRESS'},201);
  if(c.path===`/v1/envelopes/${ENV_ID}`)return json(state);
  if(c.path===`/v1/envelopes/${ENV_ID}/tasks/task-0/recipient-view`)return json({code:'c0de'},201);
  if(c.path===`/v1/envelopes/${ENV_ID}/delivery-pdf`)return new Response(new Blob(['%PDF-delivery']),{status:200});
 },{storedKey:KEY});
 try {
  await h.act(async()=>{await new Promise(r=>setTimeout(r,0));});
  await h.act(async()=>{h.byLabel('PDF').props.onChange({target:{files:[pdf()]}});});
  await h.type('Signer 1 name','Ana');await h.type('Signer 1 email','ana@partner.example');
  await h.type('Signer 2 name','Marcus');await h.type('Signer 2 email','marcus@seller.example');
  await h.click('Send for signature');
  const template=h.calls.find(c=>c.path==='/v1/templates')!;
  assert.ok(template.body instanceof FormData);assert.equal((template.body as FormData).get('roles'),'["signer-1","signer-2"]');
  assert.equal(template.headers.authorization,`Bearer ${KEY}`);
  const send=h.calls.find(c=>c.path==='/v1/envelopes')!;
  assert.match(send.headers['idempotency-key'],/^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(String(send.body)),{templateId:'tpl-1',recipients:[{role:'signer-1',name:'Ana',email:'ana@partner.example'},{role:'signer-2',name:'Marcus',email:'marcus@seller.example'}]});
  assert.ok(!h.calls.some(c=>c.path.endsWith('/prepare')),'creating the envelope prepares it');
  assert.deepEqual(JSON.parse(h.local.getItem('esign-demo-envelopes')!),[ENV_ID]);
  await h.click("Open Ana's signing page");
  const view=h.calls.find(c=>c.path.endsWith('/recipient-view'))!;
  assert.deepEqual(JSON.parse(String(view.body)),{origin:ORIGIN},'the code is bound to this origin, which serves /sign');
  const frame=h.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Recipient signing page');
  assert.equal(frame.props.src,'/sign#code=c0de');
  assert.equal(h.button("Open Marcus's signing page"),undefined,'only the signer whose turn it is');
  state=envelope('COMPLETED',[['Ana','SIGNED'],['Marcus','SIGNED']]);
  await h.click('Close the signing page');
  await h.act(async()=>{h.renderer.root.findAllByType('button').find((b:any)=>JSON.stringify(b.children).includes(ENV_ID)).props.onClick();await new Promise(r=>setTimeout(r,0));});
  assert.match(h.text(),/COMPLETED/);
  await h.click('View signed PDF with certificate');
  assert.ok(h.calls.some(c=>c.path===`/v1/envelopes/${ENV_ID}/delivery-pdf`));
  assert.ok(h.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Signed PDF'));
 } finally {await h.unmount();}
});

test('one signer, and a send that fails is retried with the same idempotency key', async()=>{
 let fail=true;
 const h=await harness(c=>{
  if(c.path==='/v1/me')return json({tenantId:'demo-tenant'});
  if(c.path==='/v1/templates')return json({id:'tpl-1'},201);
  if(c.path==='/v1/envelopes'&&c.method==='POST'){if(fail){fail=false;return json({error:'unavailable'},503);}return json({id:ENV_ID},201);}
  if(c.path===`/v1/envelopes/${ENV_ID}`)return json(envelope('IN_PROGRESS',[['Ana','ACTIVE']]));
 },{storedKey:KEY});
 try {
  await h.act(async()=>{await new Promise(r=>setTimeout(r,0));});
  await h.act(async()=>{h.byLabel('PDF').props.onChange({target:{files:[pdf()]}});});
  await h.act(async()=>{h.renderer.root.find((n:any)=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:false}});});
  await h.type('Signer 1 name','Ana');await h.type('Signer 1 email','ana@partner.example');
  await h.click('Send for signature');
  assert.match(h.text(),/Request failed \(503 unavailable\)/);
  await h.click('Send for signature');
  const sends=h.calls.filter(c=>c.path==='/v1/envelopes'&&c.method==='POST');
  assert.equal(sends.length,2);assert.equal(sends[0].headers['idempotency-key'],sends[1].headers['idempotency-key']);
  assert.deepEqual(JSON.parse(String(sends[1].body)).recipients,[{role:'signer-1',name:'Ana',email:'ana@partner.example'}]);
  assert.equal((h.calls.find(c=>c.path==='/v1/templates')!.body as FormData).get('roles'),'["signer-1"]');
 } finally {await h.unmount();}
});

test('placing fields opens the editor on this origin, saves through it, and sends with the saved template', async()=>{
 const SESSION='a'.repeat(64),TEMPLATE='22222222-2222-4222-8222-222222222222';
 const h=await harness(c=>{
  if(c.path==='/v1/me')return json({tenantId:'demo-tenant'});
  if(c.path==='/v1/template-editing-sessions'&&c.method==='POST')return json({sessionId:SESSION,url:`${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}`},201);
  if(c.path===`/v1/template-editing-sessions/${SESSION}/source`)return json({},201);
  if(c.path===`/v1/template-editing-sessions/${SESSION}`)return json({templateId:TEMPLATE});
  if(c.path==='/v1/envelopes'&&c.method==='POST')return json({id:ENV_ID},201);
  if(c.path===`/v1/envelopes/${ENV_ID}`)return json(envelope('IN_PROGRESS',[['Ana','ACTIVE'],['Marcus','PENDING']]));
 },{storedKey:KEY});
 try {
  await h.act(async()=>{await new Promise(r=>setTimeout(r,0));});
  await h.act(async()=>{h.byLabel('PDF').props.onChange({target:{files:[pdf()]}});});
  await h.act(async()=>{h.renderer.root.findAll((n:any)=>n.type==='input'&&n.props.type==='radio')[1].props.onChange();});
  assert.equal(h.button('Send for signature').props.disabled,true,'fields come first');
  await h.click('Place signature fields');
  const session=h.calls.find(c=>c.path==='/v1/template-editing-sessions')!;
  assert.deepEqual(JSON.parse(String(session.body)),{allowedParentOrigin:ORIGIN,roles:['signer-1','signer-2']});
  const source=h.calls.find(c=>c.path.endsWith('/source'))!;assert.equal(source.headers['content-type'],'application/pdf');
  const frame=h.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Signature field editor');
  assert.equal(frame.props.src,`${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}`);
  assert.equal(h.button('Save fields').props.disabled,true,'until the editor is ready');
  // Messages from anywhere but this origin's editor frame are ignored.
  await h.dispatch({origin:'https://evil.example.test',source:h.editorWindow,data:{type:'esign.editor.ready'}});
  assert.equal(h.button('Save fields').props.disabled,true);
  await h.dispatch({origin:ORIGIN,source:h.editorWindow,data:{type:'esign.editor.ready'}});
  await h.click('Save fields');
  const request=h.posted[0] as {type:string;requestId:string};assert.equal(request.type,'esign.editor.save');
  await h.dispatch({origin:ORIGIN,source:h.editorWindow,data:{type:'esign.editor.saved',requestId:request.requestId,templateId:TEMPLATE}});
  assert.match(h.text(),/Signature fields saved/);
  await h.type('Signer 1 name','Ana');await h.type('Signer 1 email','ana@partner.example');
  await h.type('Signer 2 name','Marcus');await h.type('Signer 2 email','marcus@seller.example');
  await h.click('Send for signature');
  assert.equal(h.calls.some(c=>c.path==='/v1/templates'),false);
  assert.equal(JSON.parse(String(h.calls.find(c=>c.path==='/v1/envelopes')!.body)).templateId,TEMPLATE);
 } finally {await h.unmount();}
});

test('a saved key is dropped only when the service rejects it, not when a check is interrupted', async()=>{
 const h1=await harness(c=>{if(c.path==='/v1/me')throw new TypeError('Failed to fetch');},{storedKey:KEY});
 try {
  await h1.act(async()=>{await new Promise(r=>setTimeout(r,0));});
  assert.equal(h1.session.getItem('esign-demo-key'),KEY,'an interrupted check keeps the key');
  assert.match(h1.text(),/Could not reach the service/);
  assert.equal(h1.calls.filter(c=>c.path==='/v1/me').length,1);
 } finally {await h1.unmount();}
 const h2=await harness(c=>{if(c.path==='/v1/me')return json({error:'unauthorized'},401);},{storedKey:KEY});
 try {
  await h2.act(async()=>{await new Promise(r=>setTimeout(r,0));});
  assert.equal(h2.session.getItem('esign-demo-key'),null);
  assert.match(h2.text(),/The saved key was not accepted/);
 } finally {await h2.unmount();}
 const h3=await harness(c=>{if(c.path==='/v1/me')return json({tenantId:'demo-tenant'});});
 try {
  await h3.type('Tenant management key',KEY);await h3.click('Connect');
  await h3.act(async()=>{await new Promise(r=>setTimeout(r,0));});
  assert.equal(h3.calls.filter(c=>c.path==='/v1/me').length,1,'connecting checks the key once');
 } finally {await h3.unmount();}
});

test('the completion certificate shows the managed seal, and keeps the local test wording for the local seal', async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {CompletionCertificate}=await import('../ui/HostPage.ts');
 const base={envelope:{id:'e1',template_id:'t1',created_at:Date.parse('2026-11-07T00:00:00Z'),status:'COMPLETED'},source:{id:'d0',sha256:'a'.repeat(64)},finalArtifactId:'signed:x',finalSha256:'b'.repeat(64),recipients:[],signatures:[]};
 const managed=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...base,mode:'KMS_TSA',seal:{keyArn:'arn:aws:kms:us-west-2:123456789012:key/k',publicKeySha256:'c'.repeat(64),timestampTime:Date.parse('2026-11-07T01:02:03Z'),tsaUrl:'http://timestamp.digicert.com'}} as never}));
 assert.match(managed,/AWS KMS/);assert.match(managed,/2026-11-07T01:02:03.000Z/);assert.match(managed,/c{64}/);assert.match(managed,/timestamp\.digicert\.com/);
 assert.doesNotMatch(managed,/LOCAL TEST ONLY/);
 const local=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...base,mode:'LOCAL TEST ONLY'} as never}));
 assert.match(local,/LOCAL TEST ONLY/);
});

test('the completion certificate lists the audit trail, marking events recorded after sealing', async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {CompletionCertificate}=await import('../ui/HostPage.ts');
 const event=(id:number,type:string,extra:Record<string,unknown>={})=>({id,envelopeId:'e1',taskId:'t1',type,occurredAt:Date.parse('2026-11-07T01:00:00Z')+id*1000,ip:'203.0.113.9',userAgent:'Mozilla/5.0 (Synthetic)',detail:null,...extra});
 const certificate={envelope:{id:'e1',template_id:'t1',created_at:0,status:'COMPLETED'},source:{id:'d0',sha256:'a'.repeat(64)},finalArtifactId:'x',finalSha256:'b'.repeat(64),
  recipients:[{id:'t1',role:'partner',recipient_name:'Ana Partner',recipient_email:'ana@partner.test',routing_order:1,status:'SIGNED'}],signatures:[],mode:'KMS_TSA',
  seal:{keyArn:'arn:aws:kms:us-west-2:123456789012:key/k',publicKeySha256:'c'.repeat(64),timestampTime:0,tsaUrl:'http://timestamp.digicert.com'},
  audit:{sealed:[event(1,'OTP_VERIFIED'),event(2,'SIGNED')],afterSeal:[event(3,'COPY_SENT',{ip:null,userAgent:null})]}};
 const html=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:certificate as never}));
 assert.match(html,/Audit trail/);
 assert.match(html,/OTP verified/);assert.match(html,/Ana Partner/);assert.match(html,/203\.0\.113\.9/);assert.match(html,/Mozilla\/5\.0 \(Synthetic\)/);
 assert.match(html,/2026-11-07T01:00:02/);
 assert.equal((html.match(/recorded after sealing/g)??[]).length,1);
});
