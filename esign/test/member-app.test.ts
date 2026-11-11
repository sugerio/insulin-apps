// The members' pages drive the app's API on its own origin as the signed-in member (the platform identity): templates
// uploaded or given fields in the embedded editor, envelopes sent from them, each signer's page opened in a dialog,
// voiding, and the results of a completed envelope. A role that only views sees the same pages without the actions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {route} from '../src/app/member/MemberApp.ts';
import {envelopeRequest,signByTime} from '../src/app/member/api.ts';
import {checkRoles} from '../src/app/member/TemplatesPage.ts';
import {EDITOR,ENV_ID,ORIGIN,VIEWER,json,renderMember} from './helpers/member.ts';

const pdf=()=>new File(['%PDF-1.7 synthetic'],'synthetic.pdf',{type:'application/pdf'});
const envelope=(status:string,tasks:[string,string][])=>({id:ENV_ID,templateId:'tpl-1',status,createdAt:Date.parse('2026-11-07T00:00:00Z'),tasks:tasks.map(([name,s],i)=>({id:`task-${i}`,role:`signer-${i+1}`,recipientName:name,recipientEmail:`${name.toLowerCase()}@partner.example`,status:s,routingOrder:i+1}))});
const TEMPLATE={id:'tpl-1',roles:['partner','seller'],fields:[],createdAt:Date.parse('2026-11-01T00:00:00Z')};
const CERTIFICATE={envelope:{id:ENV_ID,template_id:'tpl-1',created_at:0,status:'COMPLETED'},source:{id:'d0',sha256:'a'.repeat(64)},finalArtifactId:'x',finalSha256:'b'.repeat(64),recipients:[],signatures:[],mode:'LOCAL TEST ONLY'};

test('addresses name pages: envelopes, a new one, one by id, templates and the Docs',()=>{
 assert.deepEqual(route('/'),{section:'envelopes',page:'list'});
 assert.deepEqual(route('/envelopes/'),{section:'envelopes',page:'list'});
 assert.deepEqual(route('/envelopes/new'),{section:'envelopes',page:'new'});
 assert.deepEqual(route(`/envelopes/${ENV_ID}`),{section:'envelopes',page:'envelope',id:ENV_ID});
 assert.deepEqual(route('/envelopes/not-an-id').page,'missing');
 assert.deepEqual(route('/templates'),{section:'templates',page:'list'});
 assert.deepEqual(route('/docs'),{section:'docs',page:'docs',topic:undefined});
 assert.deepEqual(route('/docs/roles'),{section:'docs',page:'docs',topic:'roles'});
 assert.equal(route('/docs/roles/more').page,'missing');
 assert.equal(route('/elsewhere').page,'missing');
});

test('an Editor sees the actions; a Viewer the same pages without them; a visitor is asked to sign in',async()=>{
 const routes=(who:unknown)=>(c:{path:string;method:string})=>{
  if(c.path==='/api/me')return json(who);
  if(c.path==='/api/envelopes')return json({envelopes:[{id:ENV_ID,templateId:'tpl-1',status:'IN_PROGRESS',createdAt:0,documentName:'Mutual NDA'}]});
  if(c.path==='/api/templates')return json({templates:[TEMPLATE]});
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(envelope('IN_PROGRESS',[['Ana','ACTIVE'],['Marcus','PENDING']]));
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:[]});
 };
 const editor=await renderMember('/',routes(EDITOR));
 try{
  assert.ok(editor.button('Process due work'));assert.ok(editor.link('New envelope'));
  assert.match(editor.text(),/Mutual NDA/);assert.match(editor.text(),/Out for signature/);assert.match(editor.text(),/Sam Example · +Editor/);
  const me=editor.calls.find(c=>c.path==='/api/me')!;
  assert.equal(me.headers.authorization,undefined,'no key: the session is the platform\'s');
  assert.equal(editor.session.map.size+editor.local.map.size,0,'nothing is stored in the browser');
  await editor.click(editor.link('Templates'),'Templates');
  assert.ok(editor.byLabel('New template'));assert.ok(editor.button('Place fields'));assert.ok(editor.link('Send'));
  await editor.click(editor.link('Envelopes'),'Envelopes');
  assert.equal(editor.location.pathname,'/');
 }finally{await editor.unmount();}
 const viewer=await renderMember('/',routes(VIEWER));
 try{
  assert.match(viewer.text(),/Mutual NDA/);
  assert.equal(viewer.button('Process due work'),undefined);assert.equal(viewer.link('New envelope'),undefined);
  await viewer.click(viewer.link('Mutual NDA'),'the envelope');
  assert.equal(viewer.location.pathname,`/envelopes/${ENV_ID}`);
  assert.match(viewer.text(),/Asked to sign/);
  assert.equal(viewer.button('Void envelope'),undefined);assert.equal(viewer.button("Open Ana's signing page"),undefined);
  await viewer.click(viewer.link('Templates'),'Templates');
  assert.equal(viewer.byLabel('New template'),undefined);assert.equal(viewer.button('Place fields'),undefined);assert.equal(viewer.link('Send'),undefined);
  assert.match(viewer.text(),/Your role can see templates but not change them/);
 }finally{await viewer.unmount();}
 const viewerSending=await renderMember('/envelopes/new',routes(VIEWER));
 try{
  assert.match(viewerSending.text(),/Your role can see envelopes but not send them/);
  assert.equal(viewerSending.button('Send for signature'),undefined);
 }finally{await viewerSending.unmount();}
 const visitor=await renderMember('/',c=>{if(c.path==='/api/me')return json({error:'unauthorized'},401);});
 try{
  assert.match(visitor.text(),/Sign in to use E-sign\./);
  assert.equal(visitor.calls.length,1,'nothing else is asked for');
 }finally{await visitor.unmount();}
});

test('sending from a template: one signer per role, the document, a sign-by day, and a retry with the same key',async()=>{
 let fail=true;
 const app=await renderMember('/envelopes/new?template=tpl-1',c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path==='/api/templates')return json({templates:[TEMPLATE]});
  if(c.path==='/api/envelopes'&&c.method==='POST'){if(fail){fail=false;return json({error:'unavailable'},503);}return json({id:ENV_ID,status:'IN_PROGRESS'},201);}
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(envelope('IN_PROGRESS',[['Ana','ACTIVE'],['Marcus','PENDING']]));
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:[]});
 });
 try{
  assert.equal(app.byId('envelope-template').props.value,'tpl-1','the template the address names');
  assert.match(app.text(),/1\. partner/);assert.match(app.text(),/2\. seller/);
  await app.click(app.button('Send for signature'),'Send');
  assert.match(app.text(),/Enter a name and an email address for each signer\./);
  await app.type(app.byId('signer-0-name'),'Ana');await app.type(app.byId('signer-0-email'),'ana@partner.example');
  await app.type(app.byId('signer-0-title'),'Partner Manager');await app.type(app.byId('signer-0-company'),'Partner Company Ltd');
  await app.type(app.byId('signer-0-after'),'Your onboarding moves on.\n\nTraining opens.');
  await app.type(app.byId('signer-1-name'),'Marcus');await app.type(app.byId('signer-1-email'),'marcus@seller.example');
  await app.type(app.byId('doc-name'),'Mutual NDA');await app.type(app.byId('doc-version'),'v3');await app.type(app.byId('doc-published'),'2026-09-02');
  await app.type(app.byId('doc-sender'),'Sam Seller');await app.type(app.byId('doc-sender-company'),'Example Seller Inc.');
  await app.type(app.byId('sign-by'),'2020-01-01');
  await app.click(app.button('Send for signature'),'Send');
  assert.match(app.text(),/Choose a sign-by day from today up to 400 days ahead\./);
  const day=new Date(Date.now()+7*86_400_000).toISOString().slice(0,10);
  await app.type(app.byId('sign-by'),day);
  await app.click(app.button('Send for signature'),'Send');
  assert.match(app.text(),/Request failed \(503 unavailable\)/);
  await app.click(app.button('Send for signature'),'Send again');
  const sends=app.calls.filter(c=>c.path==='/api/envelopes'&&c.method==='POST');
  assert.equal(sends.length,2);
  assert.match(sends[0].headers['idempotency-key'],/^[0-9a-f-]{36}$/);
  assert.equal(sends[0].headers['idempotency-key'],sends[1].headers['idempotency-key'],'a retry is the same send');
  const deadline=signByTime(day);
  assert.deepEqual(JSON.parse(String(sends[1].body)),{templateId:'tpl-1',documentName:'Mutual NDA',documentVersion:{label:'v3',publishedAt:'2026-09-02T00:00:00.000Z'},sender:{name:'Sam Seller',organization:'Example Seller Inc.'},
   recipients:[{role:'partner',name:'Ana',email:'ana@partner.example',expiresAt:deadline,title:'Partner Manager',onBehalfOf:'Partner Company Ltd',afterSigning:['Your onboarding moves on.','Training opens.']},{role:'seller',name:'Marcus',email:'marcus@seller.example',expiresAt:deadline}]});
  assert.ok(!app.calls.some(c=>c.path.endsWith('/prepare')),'creating the envelope prepares it');
  assert.equal(app.location.pathname,`/envelopes/${ENV_ID}`,'the new envelope opens');
  assert.match(app.text(),/Signers/);assert.ok(app.button("Open Ana's signing page"));
 }finally{await app.unmount();}
});

test('a sign-by day ends that day in the member\'s time zone, and empty facts are left out',()=>{
 assert.equal(signByTime(''),'');assert.equal(signByTime('2026-13-45'),'');assert.equal(signByTime('soon'),'');
 const end=new Date(signByTime('2026-12-01'));assert.equal(end.getFullYear(),2026);assert.equal(end.getMonth(),11);assert.equal(end.getDate(),1);assert.equal(end.getHours(),23);
 const signer={name:' Ana ',email:'ana@partner.example',title:'',company:'',after:''};
 assert.deepEqual(envelopeRequest('t',['partner'],[signer],{name:'',version:'',published:'',senderName:'',senderCompany:'Ignored without a name'}),{templateId:'t',recipients:[{role:'partner',name:'Ana',email:'ana@partner.example'}]});
});

test('templates: upload with a signature page, with roles checked first',async()=>{
 const app=await renderMember('/templates',c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path==='/api/templates'&&c.method==='GET')return json({templates:[]});
  if(c.path==='/api/templates'&&c.method==='POST')return json({id:'tpl-1',roles:['partner','seller']},201);
 });
 try{
  assert.match(app.text(),/No templates yet/);
  await app.click(app.button('Upload with a signature page'),'Upload');
  assert.match(app.text(),/Choose a PDF\./);
  await app.act(async()=>{app.byId('template-pdf').props.onChange({target:{files:[pdf()]}});});
  await app.type(app.byLabel('Role 1'),'partner seller');
  await app.click(app.button('Upload with a signature page'),'Upload');
  assert.match(app.text(),/Use letters, digits, - and _ in role names/);
  await app.type(app.byLabel('Role 1'),'partner');
  await app.click(app.button('Add a role'),'Add a role');
  await app.type(app.byLabel('Role 2'),'seller');
  await app.click(app.button('Upload with a signature page'),'Upload');
  const upload=app.calls.find(c=>c.path==='/api/templates'&&c.method==='POST')!;
  assert.ok(upload.body instanceof FormData);assert.equal((upload.body as FormData).get('roles'),'["partner","seller"]');
  assert.equal(upload.headers.authorization,undefined,'the member\'s session, not a key');
  assert.match(app.text(),/Template uploaded/);
 }finally{await app.unmount();}
 assert.equal(checkRoles(['a','A']),'Give each role a different name.');
 assert.equal(checkRoles(['a','']),'Name every role.');
 assert.equal(checkRoles(['partner','seller-2']),'');
});

test('placing fields opens the editor on this origin, ignores other frames, and confirms the save with the server',async()=>{
 const SESSION='a'.repeat(64),SAVED='22222222-2222-4222-8222-222222222222';
 let templates:unknown[]=[];
 const app=await renderMember('/templates',c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path==='/api/templates')return json({templates});
  if(c.path==='/api/template-editing-sessions'&&c.method==='POST')return json({sessionId:SESSION,url:`${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}`},201);
  if(c.path===`/api/template-editing-sessions/${SESSION}/source`)return json({},201);
  if(c.path===`/api/template-editing-sessions/${SESSION}`)return json({templateId:SAVED});
 });
 try{
  await app.act(async()=>{app.byId('template-pdf').props.onChange({target:{files:[pdf()]}});});
  await app.type(app.byLabel('Role 1'),'partner');
  await app.click(app.button('Upload and place fields'),'Place fields');
  const session=app.calls.find(c=>c.path==='/api/template-editing-sessions')!;
  assert.deepEqual(JSON.parse(String(session.body)),{allowedParentOrigin:ORIGIN,roles:['partner']});
  assert.equal(app.calls.find(c=>c.path.endsWith('/source'))!.headers['content-type'],'application/pdf');
  const frame=app.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Signature field editor');
  assert.equal(frame.props.src,`${ORIGIN}/editor/page/${SESSION}#${'b'.repeat(64)}`);
  assert.equal(app.button('Save fields').props.disabled,true,'until the editor is ready');
  await app.dispatch({origin:'https://other.example.test',source:app.frameWindow,data:{type:'esign.editor.ready'}});
  assert.equal(app.button('Save fields').props.disabled,true,'another origin is ignored');
  await app.dispatch({origin:ORIGIN,source:{},data:{type:'esign.editor.ready'}});
  assert.equal(app.button('Save fields').props.disabled,true,'another frame is ignored');
  await app.dispatch({origin:ORIGIN,source:app.frameWindow,data:{type:'esign.editor.ready'}});
  await app.click(app.button('Save fields'),'Save fields');
  const request=app.posted[0] as {type:string;requestId:string};assert.equal(request.type,'esign.editor.save');
  templates=[{id:SAVED,roles:['partner'],fields:[{type:'Signature',role:'partner',page:1}],createdAt:0}];
  await app.dispatch({origin:ORIGIN,source:app.frameWindow,data:{type:'esign.editor.saved',requestId:request.requestId,templateId:SAVED}});
  assert.match(app.text(),/Fields saved as a new template/);
  assert.match(app.text(),/1 placed field/);
  assert.equal(app.renderer.root.findAll((n:any)=>n.type==='iframe').length,0,'the editor closes');
 }finally{await app.unmount();}
});

test('an envelope: the active signer\'s page in a dialog, its messages followed, and the results once completed',async()=>{
 let state=envelope('IN_PROGRESS',[['Ana','ACTIVE'],['Marcus','PENDING']]);
 const app=await renderMember(`/envelopes/${ENV_ID}`,c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(state);
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:state.status==='COMPLETED'?[{type:'SIGNED',at:'2026-11-07T01:00:00.000Z',recipient:{role:'signer-1',name:'Ana',email:'ana@partner.example'},ip:'203.0.113.9'}]:[]});
  if(c.path===`/api/envelopes/${ENV_ID}/tasks/task-0/recipient-view`)return json({code:'c0de'},201);
  if(c.path===`/api/envelopes/${ENV_ID}/delivery-pdf`)return new Response(new Blob(['%PDF-delivery']),{status:200});
  if(c.path===`/api/envelopes/${ENV_ID}/certificate`)return json(CERTIFICATE);
 });
 try{
  assert.equal(app.button("Open Marcus's signing page"),undefined,'only the signer whose turn it is');
  await app.click(app.button("Open Ana's signing page"),'Open');
  const view=app.calls.find(c=>c.path.endsWith('/recipient-view'))!;
  assert.deepEqual(JSON.parse(String(view.body)),{origin:ORIGIN},'the code is for this origin, which serves /sign');
  const frame=app.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Recipient signing page');
  assert.equal(frame.props.src,`/sign#code=c0de&host=${encodeURIComponent(ORIGIN)}`,'this page is the host the signing page reports to');
  await app.dispatch({origin:'https://other.example.test',source:app.frameWindow,data:{type:'esign.signing.finished',outcome:'signed'}});
  assert.equal(app.renderer.root.findAll((n:any)=>n.type==='iframe'&&n.props.title==='Recipient signing page').length,1,'another origin is ignored');
  state=envelope('COMPLETED',[['Ana','SIGNED'],['Marcus','SIGNED']]);
  await app.dispatch({origin:ORIGIN,source:app.frameWindow,data:{type:'esign.signing.finished',outcome:'signed'}});
  assert.equal(app.renderer.root.findAll((n:any)=>n.type==='iframe'&&n.props.title==='Recipient signing page').length,0,'the dialog closes');
  assert.match(app.text(),/Ana signed\./);assert.match(app.text(),/Completed/);assert.match(app.text(),/203\.0\.113\.9/);
  assert.equal(app.button('Void envelope'),undefined,'a completed envelope can\'t be voided');
  await app.click(app.button('Signed PDF with certificate'),'Signed PDF');
  assert.ok(app.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Signed PDF'));
  assert.ok(app.renderer.root.find((n:any)=>n.type==='a'&&n.props.download==='signed-with-certificate.pdf'));
  await app.click(app.button('Certificate of completion'),'Certificate');
  assert.ok(app.byLabel('Certificate of completion'));assert.match(app.text(),/LOCAL TEST ONLY/);
 }finally{await app.unmount();}
});

test('voiding asks first, sends the reason, and the envelope says it is voided',async()=>{
 let state=envelope('IN_PROGRESS',[['Ana','ACTIVE']]);
 const app=await renderMember(`/envelopes/${ENV_ID}`,c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(state);
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:state.status==='VOIDED'?[{type:'VOIDED',at:'2026-11-07T01:00:00.000Z',detail:{reason:'Wrong version'}}]:[]});
  // Voiding changes the envelope's status; the signer's task keeps its own (the API never sets a task to VOIDED).
  if(c.path===`/api/envelopes/${ENV_ID}/void`){state=envelope('VOIDED',[['Ana','ACTIVE']]);return new Response(null,{status:204});}
 });
 try{
  await app.click(app.button('Void envelope'),'Void');
  assert.ok(app.byLabel('Void envelope'),'it asks first');
  assert.ok(app.button('Keep it'));
  await app.type(app.byId('void-reason'),'Wrong version');
  const confirm=app.byLabel('Void envelope').findAll((n:any)=>n.type==='button'&&n.children.includes('Void envelope'))[0];
  await app.click(confirm,'Confirm');
  const call=app.calls.find(c=>c.path.endsWith('/void'))!;
  assert.equal(call.method,'POST');assert.deepEqual(JSON.parse(String(call.body)),{reason:'Wrong version'});
  assert.match(app.text(),/The envelope is voided/);assert.match(app.text(),/Reason: Wrong version/);assert.match(app.text(),/Voided/);
  assert.match(app.text(),/Asked to sign/,'the signer keeps the status they had');
  assert.equal(app.button('Void envelope'),undefined);
  assert.equal(app.button("Open Ana's signing page"),undefined,'nobody can sign a voided envelope');
 }finally{await app.unmount();}
});

test('Process due work says what it did, and a deployment without signing says so',async()=>{
 const app=await renderMember('/',c=>{
  if(c.path==='/api/me')return json({...EDITOR,signingEnabled:false});
  if(c.path==='/api/envelopes')return json({envelopes:[]});
  if(c.path==='/api/process-due')return json({expired:1,completed:2,waiting:0,failed:0});
 });
 try{
  assert.match(app.text(),/Signing isn't set up on this deployment yet/);
  await app.click(app.button('Process due work'),'Process due work');
  assert.equal(app.calls.find(c=>c.path==='/api/process-due')!.method,'POST');
  assert.match(app.text(),/Due work done: 1 expired, 2 completed\./);
 }finally{await app.unmount();}
});

test('the completion certificate shows the managed seal, and keeps the local test wording for the local seal', async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {CompletionCertificate}=await import('../src/app/ui/CompletionCertificate.ts');
 const base={envelope:{id:'e1',template_id:'t1',created_at:Date.parse('2026-11-07T00:00:00Z'),status:'COMPLETED'},source:{id:'d0',sha256:'a'.repeat(64)},finalArtifactId:'signed:x',finalSha256:'b'.repeat(64),recipients:[],signatures:[]};
 const managed=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...base,mode:'KMS_TSA',seal:{keyArn:'arn:aws:kms:us-west-2:123456789012:key/k',publicKeySha256:'c'.repeat(64),timestampTime:Date.parse('2026-11-07T01:02:03Z'),tsaUrl:'http://timestamp.digicert.com'}} as never}));
 assert.match(managed,/AWS KMS/);assert.match(managed,/2026-11-07T01:02:03.000Z/);assert.match(managed,/c{64}/);assert.match(managed,/timestamp\.digicert\.com/);
 assert.doesNotMatch(managed,/LOCAL TEST ONLY/);
 const local=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...base,mode:'LOCAL TEST ONLY'} as never}));
 assert.match(local,/LOCAL TEST ONLY/);
});

test('the completion certificate lists the audit trail, marking events recorded after sealing', async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {CompletionCertificate}=await import('../src/app/ui/CompletionCertificate.ts');
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
