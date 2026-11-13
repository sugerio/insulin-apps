// The members' pages drive the app's API on its own origin as the signed-in member (the platform identity): templates
// uploaded or given fields in the embedded editor, envelopes sent from them, each signer's page opened in a dialog,
// voiding, and the results of a completed envelope. A role that only views sees the same pages without the actions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {route} from '../src/app/member/MemberApp.ts';
import {envelopeRequest,signByTime} from '../src/app/member/api.ts';
import {checkRoles} from '../src/app/member/TemplatesPage.ts';
import {EDITOR,ENV_ID,ORIGIN,VIEWER,json,renderMember,visibleText} from './helpers/member.ts';

const pdf=()=>new File(['%PDF-1.7 synthetic'],'synthetic.pdf',{type:'application/pdf'});
// The member owns it (server/esign/ownership.ts): they may change it.
const OWNED={myRole:'owner',owner:{id:'u1',kind:'person',name:'Sam Example',email:'sam@example.com'},tags:[]};
const SHARING={id:ENV_ID,myRole:'owner',owner:OWNED.owner,shares:[]};
const envelope=(status:string,tasks:[string,string][])=>({id:ENV_ID,templateId:'tpl-1',status,createdAt:Date.parse('2026-11-07T00:00:00Z'),...OWNED,tasks:tasks.map(([name,s],i)=>({id:`task-${i}`,role:`signer-${i+1}`,recipientName:name,recipientEmail:`${name.toLowerCase()}@partner.example`,status:s,routingOrder:i+1}))});
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
  if(c.path===`/api/envelopes/${ENV_ID}/shares`)return json(SHARING);
 };
 const editor=await renderMember('/',routes(EDITOR));
 try{
  assert.ok(editor.button('Process due work'));assert.ok(editor.link('New envelope'));
  assert.match(editor.text(),/Mutual NDA/);assert.match(editor.text(),/Out for signature/);assert.match(editor.text(),/Sam Example\s+Editor/);
  const me=editor.calls.find(c=>c.path==='/api/me')!;
  assert.equal(me.headers.authorization,undefined,'no key: the session is the platform\'s');
  assert.equal(editor.session.map.size+editor.local.map.size,0,'nothing is stored in the browser');
  await editor.click(editor.link('Templates'),'Templates');
  assert.ok(editor.button('New template'),'New template opens its dialog');assert.ok(editor.button('Place fields'));assert.ok(editor.link('Send'));
  await editor.click(editor.link('Envelopes'),'Envelopes');
  assert.equal(editor.location.pathname,'/envelopes');
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
  assert.equal(viewer.button('New template'),undefined);assert.equal(viewer.button('Place fields'),undefined);assert.equal(viewer.link('Send'),undefined);
  assert.match(viewer.text(),/Your role can see templates but not change them/);
 }finally{await viewer.unmount();}
 const viewerSending=await renderMember('/envelopes/new',routes(VIEWER));
 try{
  assert.match(viewerSending.text(),/Your role can see envelopes but not send them/);
  assert.equal(viewerSending.button('Send for signature'),undefined);
 }finally{await viewerSending.unmount();}
 const visitor=await renderMember('/',c=>{if(c.path==='/api/me')return json({error:'unauthorized'},401);});
 try{
  assert.match(visitor.text(),/Sign in to use Esign\./);
  assert.deepEqual(visitor.calls.map(c=>c.path).sort(),['/__insulin/me','/api/me'],'nothing else is asked for: who the app and the platform say is signed in');
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
  if(c.path===`/api/envelopes/${ENV_ID}/shares`)return json(SHARING);
 });
 try{
  assert.equal(app.byId('envelope-template').props.value,'tpl-1','the template the address names');
  assert.match(app.text(),/1\. partner/);assert.match(app.text(),/2\. seller/);
  await app.click(app.button('Send for signature'),'Send');
  assert.match(app.text(),/Enter a name and an email address for each signer\./);
  await app.type(app.byId('signer-0-name'),'Ana');await app.type(app.byId('signer-0-email'),'ana@partner.example');
  await app.type(app.byId('signer-0-title'),'Partner Manager');await app.type(app.byId('signer-0-company'),'Partner Company Ltd');
  await app.type(app.byId('signer-1-name'),'Marcus');await app.type(app.byId('signer-1-email'),'marcus@seller.example');
  await app.type(app.byId('doc-name'),'Mutual NDA');await app.type(app.byId('doc-version'),'v3');await app.type(app.byId('doc-published'),'2026-09-02');
  await app.type(app.byId('doc-sender'),'Sam Seller');await app.type(app.byId('doc-sender-company'),'Example Seller Inc.');
  // A message for everybody, then one of their own for each instead: only theirs is sent.
  await app.type(app.byId('message-subject'),'Please sign the NDA');await app.type(app.byId('message-body'),'Hi both,\nThe NDA.');
  assert.equal(app.byId('signer-0-body'),undefined,'no message of their own until asked for');
  await app.act(async()=>{app.byId('message-per-signer').props.onChange({target:{checked:true}});});
  assert.equal(app.byId('message-body'),undefined,'the message for everybody is gone');
  await app.type(app.byId('signer-0-subject'),'Ana, please sign');await app.type(app.byId('signer-0-body'),'Hi Ana,\nOver to you.');
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
   recipients:[{role:'partner',name:'Ana',email:'ana@partner.example',expiresAt:deadline,title:'Partner Manager',onBehalfOf:'Partner Company Ltd',delivery:'email',message:{subject:'Ana, please sign',body:'Hi Ana,\nOver to you.'}},{role:'seller',name:'Marcus',email:'marcus@seller.example',expiresAt:deadline,delivery:'email'}]});
  assert.ok(!app.calls.some(c=>c.path.endsWith('/prepare')),'creating the envelope prepares it');
  assert.equal(app.location.pathname,`/envelopes/${ENV_ID}`,'the new envelope opens');
  assert.match(app.text(),/Signers/);assert.equal(app.button("Open Ana's signing page"),undefined);
 }finally{await app.unmount();}
});

test('a sign-by day ends that day in the member\'s time zone, and empty facts are left out',()=>{
 assert.equal(signByTime(''),'');assert.equal(signByTime('2026-13-45'),'');assert.equal(signByTime('soon'),'');
 const end=new Date(signByTime('2026-12-01'));assert.equal(end.getFullYear(),2026);assert.equal(end.getMonth(),11);assert.equal(end.getDate(),1);assert.equal(end.getHours(),23);
 const signer={name:' Ana ',email:'ana@partner.example',title:'',company:'',after:''};
 assert.deepEqual(envelopeRequest('t',['partner'],[signer],{name:'',version:'',published:'',senderName:'',senderCompany:'Ignored without a name'}),{templateId:'t',recipients:[{role:'partner',name:'Ana',email:'ana@partner.example'}]});
});

test('templates: the roles and default signers are checked before the editor opens',async()=>{
 const SESSION='c'.repeat(64);
 const app=await renderMember('/templates',c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path==='/api/templates'&&c.method==='GET')return json({templates:[]});
  if(c.path==='/api/template-editing-sessions'&&c.method==='POST')return json({sessionId:SESSION,url:`${ORIGIN}/editor/page/${SESSION}#${'d'.repeat(64)}`},201);
  if(c.path===`/api/template-editing-sessions/${SESSION}/source`)return json({},201);
 });
 try{
  assert.match(app.text(),/No templates yet/);
  assert.equal(app.button('Upload and place fields'),undefined,'the page is the list: New template opens a dialog');
  await app.click(app.button('New template'),'New template');
  assert.ok(app.byLabel('New template'),'the dialog');
  assert.equal(app.button('Upload with a signature page'),undefined,'templates are made with placed fields here');
  await app.click(app.button('Upload and place fields'),'Place fields');
  assert.match(app.text(),/Choose a PDF\./);
  await app.act(async()=>{app.byId('template-pdf').props.onChange({target:{files:[pdf()]}});});
  await app.type(app.byLabel('Role 1'),'partner seller');
  await app.click(app.button('Upload and place fields'),'Place fields');
  assert.match(app.text(),/Use letters, digits, - and _ in role names/);
  await app.type(app.byLabel('Role 1'),'partner');
  await app.click(app.button('Add a role'),'Add a role');
  await app.type(app.byLabel('Role 2'),'seller');
  // Who usually signs as a role: optional, and an email must be one.
  await app.type(app.byId('role-1-email'),'sam@');
  await app.click(app.button('Upload and place fields'),'Place fields');
  assert.match(app.text(),/Enter a valid email address for seller, or leave it empty\./);
  assert.ok(!app.calls.some(c=>c.path==='/api/template-editing-sessions'),'nothing is sent until the form is right');
  await app.type(app.byId('role-1-email'),'sam@seller.example');
  await app.click(app.button('Upload and place fields'),'Place fields');
  const session=app.calls.find(c=>c.path==='/api/template-editing-sessions')!;
  assert.deepEqual(JSON.parse(String(session.body)),{allowedParentOrigin:ORIGIN,roles:['partner','seller']});
  assert.equal(session.headers.authorization,undefined,'the member\'s session, not a key');
  assert.ok(app.renderer.root.findAll((n:any)=>n.type==='iframe').length===1,'the editor opens');
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
  if(c.path===`/api/templates/${SAVED}`)return json({id:SAVED,roles:['partner'],fields:[],createdAt:0});
  if(c.path===`/api/templates/${SAVED}/default-signers`)return json({id:SAVED,defaultSigners:{partner:{email:'pat@partner.example'}}});
 });
 try{
  await app.click(app.button('New template'),'New template');
  await app.act(async()=>{app.byId('template-pdf').props.onChange({target:{files:[pdf()]}});});
  await app.type(app.byLabel('Role 1'),'partner');
  await app.type(app.byId('role-0-email'),'pat@partner.example');
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
  // The default signers are set on the saved template, for the roles it kept.
  assert.deepEqual(JSON.parse(String(app.calls.find(c=>c.path===`/api/templates/${SAVED}/default-signers`)!.body)),{defaultSigners:{partner:{email:'pat@partner.example'}}});
  assert.equal(app.renderer.root.findAll((n:any)=>n.type==='iframe').length,0,'the editor closes');
 }finally{await app.unmount();}
});

test('an envelope: no signer\'s page opens here; the active invited signer\'s invitation can be resent; the results once completed',async()=>{
 const inviting=envelope('IN_PROGRESS',[['Ana','ACTIVE'],['Marcus','PENDING'],['Host','PENDING']]);
 inviting.tasks=inviting.tasks.map((t,i)=>i<2?{...t,delivery:'email',...(i===0?{invitedAt:'2026-11-07T00:10:00.000Z'}:{})}:{...t,delivery:'host'});
 const app=await renderMember(`/envelopes/${ENV_ID}`,c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(inviting);
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:[]});
  if(c.path===`/api/envelopes/${ENV_ID}/shares`)return json(SHARING);
  if(c.path===`/api/envelopes/${ENV_ID}/tasks/task-0/invitation`&&c.method==='POST')return new Response(null,{status:204});
 });
 try{
  assert.equal(app.button("Open Ana's signing page"),undefined,'Esign\'s pages never open a signer\'s page');
  assert.match(app.text(),/Invited by email/);assert.match(app.text(),/Signs in the sender's own system/);
  assert.equal(app.renderer.root.findAll((n:any)=>n.type==='button'&&visibleText(n.children).trim()==='Resend invitation').length,1,'only for the signer whose turn it is');
  await app.click(app.button('Resend invitation'),'Resend');
  assert.ok(app.calls.some(c=>c.path===`/api/envelopes/${ENV_ID}/tasks/task-0/invitation`&&c.method==='POST'));
  assert.ok(!app.calls.some(c=>c.path.endsWith('/recipient-view')));
  assert.match(app.text(),/The invitation was emailed again to ana@partner\.example/);
 }finally{await app.unmount();}
 const done=await renderMember(`/envelopes/${ENV_ID}`,c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(envelope('COMPLETED',[['Ana','SIGNED'],['Marcus','SIGNED']]));
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:[{type:'SIGNED',at:'2026-11-07T01:00:00.000Z',recipient:{role:'signer-1',name:'Ana',email:'ana@partner.example'},ip:'203.0.113.9'}]});
  if(c.path===`/api/envelopes/${ENV_ID}/shares`)return json(SHARING);
  if(c.path===`/api/envelopes/${ENV_ID}/delivery-pdf`)return new Response(new Blob(['%PDF-delivery']),{status:200});
  if(c.path===`/api/envelopes/${ENV_ID}/certificate`)return json(CERTIFICATE);
 });
 try{
  assert.match(done.text(),/Completed/);assert.match(done.text(),/203\.0\.113\.9/);
  assert.equal(done.button('Void envelope'),undefined,'a completed envelope can\'t be voided');
  assert.equal(done.button('Resend invitation'),undefined);
  await done.click(done.button('Signed PDF with certificate'),'Signed PDF');
  assert.ok(done.renderer.root.find((n:any)=>n.type==='iframe'&&n.props.title==='Signed PDF'));
  assert.ok(done.renderer.root.find((n:any)=>n.type==='a'&&n.props.download==='signed-with-certificate.pdf'));
  await done.click(done.button('Certificate of completion'),'Certificate');
  assert.ok(done.byLabel('Certificate of completion'));assert.match(done.text(),/LOCAL TEST ONLY/);
 }finally{await done.unmount();}
});

test('voiding asks first, sends the reason, and the envelope says it is voided',async()=>{
 let state=envelope('IN_PROGRESS',[['Ana','ACTIVE']]);
 const app=await renderMember(`/envelopes/${ENV_ID}`,c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path===`/api/envelopes/${ENV_ID}`)return json(state);
  if(c.path===`/api/envelopes/${ENV_ID}/audit`)return json({events:state.status==='VOIDED'?[{type:'VOIDED',at:'2026-11-07T01:00:00.000Z',detail:{reason:'Wrong version'}}]:[]});
  if(c.path===`/api/envelopes/${ENV_ID}/shares`)return json(SHARING);
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
 const managed=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...base,mode:'KEY_TSA',seal:{keyId:'c'.repeat(64),timestampTime:Date.parse('2026-11-07T01:02:03Z'),tsaUrl:'http://timestamp.digicert.com'}} as never}));
 assert.match(managed,/Esign seal key/);assert.doesNotMatch(managed,/KMS/);assert.match(managed,/2026-11-07T01:02:03.000Z/);assert.match(managed,/c{64}/);assert.match(managed,/timestamp\.digicert\.com/);
 assert.doesNotMatch(managed,/LOCAL TEST ONLY/);
 assert.doesNotMatch(managed,/Original filename|Test email/);
 const local=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...base,mode:'LOCAL TEST ONLY'} as never}));
 assert.match(local,/LOCAL TEST ONLY/);
});

test('the completion certificate shows each signer\'s sealed email, role and consent text, not the current ones', async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {CompletionCertificate}=await import('../src/app/ui/CompletionCertificate.ts');
 const signature={id:'s1',sequence:1,task_id:'t1',recipient_name:'Ana Partner',input_artifact_id:'d0',input_sha256:'a'.repeat(64),otp_verified_at:0,consented_at:0,previous_hash:'',event_hash:'e'.repeat(64),artifact_id:'signed:s1',sha256:'b'.repeat(64)};
 const certificate={mode:'KEY_TSA',seal:{keyId:'c'.repeat(64),timestampTime:0,tsaUrl:'http://timestamp.digicert.com'},envelope:{id:'e1',template_id:'t',created_at:0,status:'COMPLETED'},source:{id:'d0',sha256:'a'.repeat(64)},finalArtifactId:'signed:s1',finalSha256:'b'.repeat(64),
  recipients:[{id:'t1',role:'partner',recipient_name:'Ana Partner',recipient_email:'current@partner.test',routing_order:1,status:'SIGNED'}],signatures:[signature],
  identities:[{signatureId:'s1',email:'ana@partner.test',role:'partner',disclosure:{version:'2026-11',sha256:'d'.repeat(64)},authority:{title:'CFO',onBehalfOf:'Partner Co'}}]};
 const html=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:certificate as never}));
 assert.match(html,/Email, where the code was sent \(sealed\)/);assert.match(html,/ana@partner\.test/);
 assert.match(html,/Role \(sealed\)/);assert.match(html,/Version 2026-11, SHA-256 d{64}/);assert.match(html,/CFO, Partner Co/);
 assert.doesNotMatch(html,/current@partner\.test/,'the sealed email replaces the current one');
 assert.match(html,/Task status \(unsealed\)/);
 const withoutIdentities=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:{...certificate,identities:undefined} as never}));
 assert.match(withoutIdentities,/Current email \(unsealed\)/);assert.match(withoutIdentities,/current@partner\.test/);
});

test('the completion certificate lists the audit trail, marking events recorded after sealing', async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {CompletionCertificate}=await import('../src/app/ui/CompletionCertificate.ts');
 const event=(id:number,type:string,extra:Record<string,unknown>={})=>({id,envelopeId:'e1',taskId:'t1',type,occurredAt:Date.parse('2026-11-07T01:00:00Z')+id*1000,ip:'203.0.113.9',userAgent:'Mozilla/5.0 (Synthetic)',detail:null,...extra});
 const certificate={envelope:{id:'e1',template_id:'t1',created_at:0,status:'COMPLETED'},source:{id:'d0',sha256:'a'.repeat(64)},finalArtifactId:'x',finalSha256:'b'.repeat(64),
  recipients:[{id:'t1',role:'partner',recipient_name:'Ana Partner',recipient_email:'ana@partner.test',routing_order:1,status:'SIGNED'}],signatures:[],mode:'KEY_TSA',
  seal:{keyId:'c'.repeat(64),timestampTime:0,tsaUrl:'http://timestamp.digicert.com'},
  audit:{sealed:[event(0,'RECIPIENT_VIEW_ISSUED'),event(1,'OTP_VERIFIED'),event(2,'SIGNED')],afterSeal:[event(3,'COMPLETED',{taskId:null,ip:null,userAgent:null}),event(4,'COPY_SENT',{ip:null,userAgent:null})]}};
 const html=renderToStaticMarkup(React.createElement(CompletionCertificate,{certificate:certificate as never}));
 assert.match(html,/Audit trail/);
 assert.match(html,/OTP verified/);assert.match(html,/Ana Partner/);assert.match(html,/203\.0\.113\.9/);assert.match(html,/Mozilla\/5\.0 \(Synthetic\)/);
 assert.match(html,/2026-11-07T01:00:02/);
 assert.equal((html.match(/recorded after sealing/g)??[]).length,1,'the copy sent');
 assert.match(html,/Sealed and completed/);assert.match(html,/records the seal/);
 assert.match(html,/Signing link issued \(by the sender\)/);assert.match(html,/those of whoever issued it/);
});

const CONTACT_ID='22222222-2222-4222-8222-222222222222';
const ANA={id:CONTACT_ID,email:'ana@partner.example',name:'Ana Example',title:'Partner Manager',company:'Partner Company Ltd',envelopeCount:2,lastUsedAt:Date.parse('2026-11-10T00:00:00Z'),createdAt:0,updatedAt:0};

test('contacts: the address book lists, searches and adds; a contact\'s page changes or deletes them and lists their envelopes',async()=>{
 assert.deepEqual(route('/contacts'),{section:'contacts',page:'list'});
 assert.deepEqual(route(`/contacts/${CONTACT_ID}`),{section:'contacts',page:'contact',id:CONTACT_ID});
 assert.equal(route('/contacts/not-an-id').page,'missing');
 let current={...ANA};let deleted=false;
 const routes=(who:unknown)=>(c:{path:string;method:string;body:unknown})=>{
  if(c.path==='/api/me')return json(who);
  if(c.path.startsWith('/api/contacts?')){const q=new URL(c.path,ORIGIN).searchParams.get('q')??'';return json({contacts:deleted||(q&&!'ana example ana@partner.example'.includes(q.toLowerCase()))?[]:[current]});}
  if(c.path==='/api/contacts'&&c.method==='POST'){const b=JSON.parse(String(c.body));return json({...ANA,id:CONTACT_ID,...b,envelopeCount:0,lastUsedAt:undefined},201);}
  if(c.path===`/api/contacts/${CONTACT_ID}`&&c.method==='GET')return json({...current,envelopes:[{id:ENV_ID,status:'COMPLETED',createdAt:0,documentName:'Mutual NDA',role:'partner',taskStatus:'SIGNED'}]});
  if(c.path===`/api/contacts/${CONTACT_ID}`&&c.method==='POST'){const b=JSON.parse(String(c.body));current={...current,name:b.name,title:b.title||undefined,company:b.company||undefined};return json(current);}
  if(c.path===`/api/contacts/${CONTACT_ID}/delete`){deleted=true;return json({id:CONTACT_ID,deleted:true});}
 };
 const app=await renderMember('/contacts',routes(EDITOR));
 try{
  assert.match(app.text(),/Ana Example/);assert.match(app.text(),/ana@partner\.example/);assert.match(app.text(),/Partner Company Ltd/);
  await app.type(app.byId('contact-search'),'nobody');await app.settle();
  assert.match(app.text(),/No contact matches\./);
  assert.ok(app.calls.some(c=>c.path==='/api/contacts?limit=50&q=nobody'));
  await app.type(app.byId('contact-search'),'');await app.settle();
  await app.click(app.button('Add contact'),'Add contact');
  await app.click(app.button('Save contact'),'Save');
  assert.match(app.text(),/Enter a name and an email address\./);
  await app.type(app.byId('contact-name'),'Lee Buyer');await app.type(app.byId('contact-email'),'lee@buyer.example');
  await app.click(app.button('Save contact'),'Save');
  assert.deepEqual(JSON.parse(String(app.calls.find(c=>c.path==='/api/contacts'&&c.method==='POST')!.body)),{name:'Lee Buyer',email:'lee@buyer.example'});
  assert.equal(app.location.pathname,`/contacts/${CONTACT_ID}`,'the new contact opens');
  // Their page: the envelopes that name them, a change, and a delete asked twice.
  assert.match(app.text(),/Mutual NDA/);assert.match(app.text(),/Signed/);
  await app.type(app.byId('contact-name'),'Ana E.');await app.type(app.byId('contact-company'),'');
  await app.click(app.button('Save contact'),'Save');
  assert.deepEqual(JSON.parse(String(app.calls.filter(c=>c.path===`/api/contacts/${CONTACT_ID}`&&c.method==='POST').at(-1)!.body)),{name:'Ana E.',title:'Partner Manager',company:''});
  assert.match(app.text(),/Contact saved\./);
  await app.click(app.button('Delete contact'),'Delete');
  assert.ok(!app.calls.some(c=>c.path.endsWith('/delete')),'not until confirmed');
  await app.click(app.button('Delete for good'),'Confirm');
  assert.equal(app.location.pathname,'/contacts');
  assert.match(app.text(),/No contacts yet\./);
 }finally{await app.unmount();}
 deleted=false;current={...ANA};
 const viewer=await renderMember(`/contacts/${CONTACT_ID}`,routes(VIEWER));
 try{
  assert.match(viewer.text(),/Mutual NDA/);
  assert.equal(viewer.button('Save contact'),undefined);assert.equal(viewer.button('Delete contact'),undefined);
  assert.equal(viewer.byId('contact-name').props.disabled,true);
  await viewer.click(viewer.link('Contacts'),'back');
  assert.equal(viewer.button('Add contact'),undefined);
 }finally{await viewer.unmount();}
});

test('sending: a contact suggested as a name or email is typed fills in the signer, title and company included',async()=>{
 const app=await renderMember('/envelopes/new?template=tpl-1',c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path==='/api/templates')return json({templates:[TEMPLATE]});
  if(c.path.startsWith('/api/contacts?'))return json({contacts:[ANA]});
 });
 try{
  assert.equal(app.button('Choose partner from contacts'),undefined,'no browsing: suggestions as you type');
  assert.equal(app.byId('signer-0-delivery'),undefined,'every signer is invited by email');
  await app.type(app.byId('signer-0-title'),'Typed title');
  // Suggested as they are typed: from two characters on; arrow keys and Enter choose one.
  await app.type(app.byId('signer-1-name'),'a');await app.settle();
  assert.equal(app.byLabel('Contacts matching name'),undefined,'not after one character');
  await app.type(app.byId('signer-1-name'),'an');await app.settle();
  assert.ok(app.calls.some(c=>c.path==='/api/contacts?limit=6&q=an'));
  assert.ok(app.byLabel('Contacts matching name'));
  assert.equal(app.byId('signer-1-name').props['aria-expanded'],true);
  await app.keyDown(app.byId('signer-1-name'),'ArrowDown');
  assert.equal(app.byId('signer-1-name').props['aria-activedescendant'],'signer-1-name-suggestions-0');
  await app.keyDown(app.byId('signer-1-name'),'Enter');
  assert.deepEqual(['signer-1-name','signer-1-email','signer-1-title','signer-1-company'].map(id=>app.byId(id).props.value),['Ana Example','ana@partner.example','Partner Manager','Partner Company Ltd']);
  assert.equal(app.byId('signer-0-title').props.value,'Typed title','the other signer is untouched');
  assert.equal(app.byLabel('Contacts matching name'),undefined,'the suggestions close');
  // Or clicked, under the Email field; Escape closes them without choosing.
  await app.type(app.byId('signer-0-email'),'ana@');await app.settle();
  await app.keyDown(app.byId('signer-0-email'),'Escape');
  assert.equal(app.byLabel('Contacts matching email'),undefined);
  await app.type(app.byId('signer-0-email'),'ana@p');await app.settle();
  await app.click(app.byLabel('Choose Ana Example (ana@partner.example)'),'the suggestion');
  assert.equal(app.byId('signer-0-email').props.value,'ana@partner.example');
  // Nothing is suggested once the field holds a contact's email exactly.
  await app.type(app.byId('signer-0-email'),'ana@partner.example');await app.settle();
  assert.equal(app.byLabel('Contacts matching email'),undefined);
 }finally{await app.unmount();}
});

test('sending: a template\'s default signers are filled in, can be changed, and give way to another template\'s',async()=>{
 const WITH={...TEMPLATE,id:'tpl-2',defaultSigners:{seller:{name:'Sam Seller',email:'sam@seller.example'}}};
 const OTHER_DEFAULTS={...TEMPLATE,id:'tpl-3',defaultSigners:{seller:{name:'Nia New',email:'nia@seller.example'}}};
 const app=await renderMember('/envelopes/new?template=tpl-2',c=>{
  if(c.path==='/api/me')return json(EDITOR);
  if(c.path==='/api/templates')return json({templates:[TEMPLATE,WITH,OTHER_DEFAULTS]});
  if(c.path.startsWith('/api/contacts?'))return json({contacts:[]});
 });
 try{
  assert.deepEqual([app.byId('signer-0-name').props.value,app.byId('signer-1-name').props.value,app.byId('signer-1-email').props.value],['','Sam Seller','sam@seller.example']);
  await app.act(async()=>{app.byId('envelope-template').props.onChange({target:{value:'tpl-3'}});});await app.settle();
  assert.equal(app.byId('signer-1-name').props.value,'Nia New','a default not changed gives way to the next template\'s');
  await app.type(app.byId('signer-1-name'),'Typed Seller');
  await app.act(async()=>{app.byId('envelope-template').props.onChange({target:{value:'tpl-2'}});});await app.settle();
  assert.equal(app.byId('signer-1-name').props.value,'Typed Seller','what was typed is kept');
 }finally{await app.unmount();}
});

test('contacts: a row is deleted from the list after it is confirmed; a Viewer sees no delete',async()=>{
 const LEE={...ANA,id:'33333333-3333-4333-8333-333333333333',email:'lee@buyer.example',name:'Lee Buyer'};
 const routes=(who:unknown)=>(c:{path:string;method:string})=>{
  if(c.path==='/api/me')return json(who);
  if(c.path.startsWith('/api/contacts?'))return json({contacts:[ANA,LEE]});
  if(c.path===`/api/contacts/${LEE.id}/delete`&&c.method==='POST')return json({id:LEE.id,deleted:true});
 };
 const app=await renderMember('/contacts',routes(EDITOR));
 try{
  await app.click(app.byLabel('Delete Lee Buyer'),'Delete');
  assert.ok(!app.calls.some(c=>c.path.endsWith('/delete')),'not until confirmed');
  await app.click(app.button('Keep'),'Keep');
  assert.equal(app.button('Delete for good'),undefined);
  await app.click(app.byLabel('Delete Lee Buyer'),'Delete');
  await app.click(app.button('Delete for good'),'Confirm');
  assert.ok(app.calls.some(c=>c.path===`/api/contacts/${LEE.id}/delete`&&c.method==='POST'));
  assert.doesNotMatch(app.text(),/lee@buyer\.example/);assert.match(app.text(),/Ana Example/);
  assert.match(app.text(),/Lee Buyer was deleted from your contacts\. Their envelopes are kept\./);
 }finally{await app.unmount();}
 const viewer=await renderMember('/contacts',routes(VIEWER));
 try{assert.equal(viewer.byLabel('Delete Lee Buyer'),undefined);}finally{await viewer.unmount();}
});
