// The members' navigation as members see it (DESIGN.md §3.2): the shell around every member page for each role, the
// Envelopes views and the breadcrumb, Settings opening the gateway's pages on the apex, each level collapsing with its
// choice remembered in localStorage `insulin-nav`, the organization switcher and the person from /__insulin/me, the
// drawer on narrow screens, and no navigation on the signers' public pages.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {PlatformMe} from '../src/app/member/navigation.ts';
import {EDITOR,VIEWER,json,me,renderMember,visibleText,type Call} from './helpers/member.ts';

const APEX='https://insulinapps.example.test';
const PLATFORM:PlatformMe={
 user:{name:'Ana Example',email:'ana@example.com'},
 organization:{id:'org-1',name:'Northwind Example',role:'ADMIN',roleLabel:'Admin'},
 organizations:[{id:'org-1',name:'Northwind Example',role:'ADMIN',roleLabel:'Admin',active:true},{id:'org-2',name:'Southwind Example',role:'VIEWER',roleLabel:'Viewer',active:false}],
 links:{account:`${APEX}/account`,apps:`${APEX}/`,organizations:`${APEX}/`},
};
const links=(node:any)=>node.findAll((n:any)=>n.type==='a').map((a:any)=>[visibleText(a.children).trim(),a.props.href]);
const named=(node:any,type:string,name:string)=>node.findAll((n:any)=>n.type===type&&visibleText(n.children).trim()===name)[0];
const byId=(app:any,id:string)=>app.renderer.root.findAll((n:any)=>typeof n.type==='string'&&n.props.id===id)[0];
const controlsOf=(app:any,id:string)=>app.renderer.root.findAll((n:any)=>n.type==='button'&&n.props['aria-controls']===id);
const crumbs=(app:any)=>visibleText(app.byLabel('Breadcrumb').children).trim().split(/\s+/).join(' ');
// The app's own API for a role, and /__insulin/me as the gateway answers it (or not at all, as in the local preview).
const routes=(who:unknown,platform:PlatformMe|null=null,extra:(c:Call)=>Response|undefined=()=>undefined)=>(c:Call)=>{
 const answer=extra(c);if(answer)return answer;
 if(c.path==='/api/me')return json(who);
 if(c.path==='/__insulin/me')return platform?json(platform):new Response('<!doctype html>',{status:200,headers:{'content-type':'text/html'}});
 if(c.path==='/api/envelopes'||c.path.startsWith('/api/envelopes?'))return json({envelopes:[]});
 if(c.path==='/api/templates')return json({templates:[]});
};

for(const [who,session,editor] of [['an Admin',me('ADMIN',['esign.manage','esign.view']),true],['an Editor',EDITOR,true],['a Viewer',VIEWER,false],['a custom role on Viewer',me('VIEWER',['esign.view']),false]] as const){
 test(`the shell for ${who}: Envelopes with its views, the breadcrumb, Templates without a level 2`,async()=>{
  const app=await renderMember('/',routes(session));
  try{
   const root=app.renderer.root.findAll((n:any)=>typeof n.type==='string'&&'data-insulin-shell' in n.props);
   assert.equal(root.length,1,'the root says it draws the navigation');
   const primary=app.byLabel('Primary');
   assert.deepEqual(links(primary),[['Envelopes','/envelopes'],['Templates','/templates'],['Docs','/docs']]);
   assert.ok(named(primary,'button','Settings'));
   assert.match(visibleText(primary.children),/^\s*Esign\b/,'the sections under the app\'s heading');
   assert.equal(named(primary,'a','Envelopes').props['aria-current'],'true','the open section; its view is the page');
   const section=app.byLabel('Section');
   const views=links(section).map(([label]:[string])=>label);
   assert.deepEqual(views,['All envelopes',...(editor?['New envelope']:[]),'Out for signature','Finishing','Completed','Declined','Expired','Voided']);
   assert.match(visibleText(section.children),/Status/,'the status views under their heading');
   assert.equal(named(section,'a','All envelopes').props['aria-current'],'page');
   assert.equal(crumbs(app),'Envelopes All envelopes');
   await app.click(named(section,'a','Completed'),'Completed');
   assert.equal(app.location.pathname,'/envelopes');assert.equal(app.location.search,'?status=completed');
   assert.ok(app.calls.some(c=>c.path==='/api/envelopes?status=COMPLETED'),'the list asks for that status');
   assert.equal(app.byId('envelope-status').props.value,'COMPLETED','the filter agrees with the address');
   assert.equal(named(app.byLabel('Section'),'a','Completed').props['aria-current'],'page');
   assert.equal(crumbs(app),'Envelopes Completed');
   await app.act(async()=>{app.byId('envelope-status').props.onChange({target:{value:'DECLINED'}});});await app.settle();
   assert.equal(app.location.search,'?status=declined','choosing a status moves to its view');
   assert.equal(named(app.byLabel('Section'),'a','Declined').props['aria-current'],'page');
   await app.click(named(app.byLabel('Breadcrumb'),'a','Envelopes'),'the section in the breadcrumb');
   assert.equal(app.location.pathname,'/envelopes');assert.equal(app.location.search,'');
   await app.click(named(app.byLabel('Primary'),'a','Templates'),'Templates');
   assert.equal(byId(app,'insulin-nav-l2').props.hidden,true,'Templates has no level 2');
   assert.equal(named(app.byLabel('Primary'),'a','Templates').props['aria-current'],'page');
   assert.equal(crumbs(app),'Templates');
  }finally{await app.unmount();}
 });
}

test('a page outside the navigation keeps its section: an envelope, a new envelope, an address that isn\'t a page',async()=>{
 const ID='11111111-1111-4111-8111-111111111111';
 const app=await renderMember(`/envelopes/${ID}`,routes(EDITOR,null,c=>{
  if(c.path===`/api/envelopes/${ID}`)return json({id:ID,templateId:'tpl-1',status:'IN_PROGRESS',createdAt:0,tasks:[]});
  if(c.path===`/api/envelopes/${ID}/audit`)return json({events:[]});
 }));
 try{
  assert.equal(crumbs(app),'Envelopes Envelope');
  assert.equal(named(app.byLabel('Primary'),'a','Envelopes').props['aria-current'],'page','no view of it is the page');
  assert.deepEqual(app.byLabel('Section').findAll((n:any)=>n.props['aria-current']==='page'),[]);
  await app.click(named(app.byLabel('Section'),'a','New envelope'),'New envelope');
  assert.equal(app.location.pathname,'/envelopes/new');assert.equal(crumbs(app),'Envelopes New envelope');
 }finally{await app.unmount();}
 const lost=await renderMember('/elsewhere',routes(EDITOR));
 try{
  assert.equal(crumbs(lost),'Page not found');
  assert.equal(byId(lost,'insulin-nav-l2').props.hidden,true);
  assert.deepEqual(lost.byLabel('Primary').findAll((n:any)=>n.props['aria-current']!==undefined&&typeof n.type==='string'),[]);
 }finally{await lost.unmount();}
});

test('Settings opens People, Integrations, API access and Connect AI on the apex, for every role',async()=>{
 for(const session of [EDITOR,VIEWER]){
  const app=await renderMember('/templates',routes(session,PLATFORM));
  try{
   const settings=named(app.byLabel('Primary'),'button','Settings');
   assert.equal(settings.props['aria-expanded'],false);assert.equal(settings.props['aria-controls'],'insulin-nav-l2');
   await app.click(settings,'Settings');
   assert.equal(named(app.byLabel('Primary'),'button','Settings').props['aria-expanded'],true);
   assert.equal(byId(app,'insulin-nav-l2').props.hidden,false);
   assert.equal(visibleText(byId(app,'insulin-nav-l2-title').children),'Settings');
   assert.deepEqual(links(app.byLabel('Section')),[
    ['People',`${APEX}/apps/esign/settings/users`],['Integrations',`${APEX}/apps/esign/settings/integrations`],
    ['API access',`${APEX}/apps/esign/settings/api`],['Connect AI',`${APEX}/apps/esign/settings/connect-ai`]]);
   assert.equal(app.location.pathname,'/templates','opening Settings doesn\'t leave the page');
   await app.click(named(app.byLabel('Primary'),'button','Settings'),'Settings again');
   assert.equal(byId(app,'insulin-nav-l2').props.hidden,true,'closing it shows the page\'s own section again');
  }finally{await app.unmount();}
 }
 const preview=await renderMember('/',routes(EDITOR));
 try{
  await preview.click(named(preview.byLabel('Primary'),'button','Settings'),'Settings');
  assert.deepEqual(links(preview.byLabel('Section')).map(([,href]:[string,string])=>href),['/settings/users','/settings/integrations','/settings/api','/settings/connect-ai'],'without /__insulin/me, the paths the gateway redirects');
  await preview.click(named(preview.byLabel('Primary'),'a','Templates'),'Templates');
  assert.equal(byId(preview,'insulin-nav-l2').props.hidden,true,'moving to a page closes Settings');
 }finally{await preview.unmount();}
});

test('each level collapses to its icons with their labels as tooltips, remembered in localStorage insulin-nav',async()=>{
 const app=await renderMember('/',routes(EDITOR));
 try{
  assert.equal(app.local.map.size,0,'nothing is stored until a level is collapsed');
  const toggle=app.byLabel('Collapse navigation');
  assert.equal(toggle.props['aria-expanded'],true);assert.equal(toggle.props['aria-controls'],'insulin-nav-l1');
  await app.click(toggle,'Collapse navigation');
  assert.equal(app.local.map.get('insulin-nav'),'{"l1":"collapsed","l2":"expanded"}');
  assert.equal(byId(app,'insulin-nav-l1').props['data-state'],'collapsed');
  assert.equal(app.byLabel('Expand navigation').props['aria-expanded'],false);
  const envelopes=named(app.byLabel('Primary'),'a','Envelopes');
  assert.equal(envelopes.props.title,'Envelopes');assert.equal(envelopes.props['aria-label'],'Envelopes');
  assert.equal(named(app.byLabel('Primary'),'button','Settings').props.title,'Settings');
  assert.equal(named(app.byLabel('Section'),'a','Completed').props.title,undefined,'level 2 has its own toggle');
  await app.click(app.byLabel('Collapse section'),'Collapse section');
  assert.equal(app.local.map.get('insulin-nav'),'{"l1":"collapsed","l2":"collapsed"}');
  assert.equal(named(app.byLabel('Section'),'a','Completed').props.title,'Completed');
  assert.equal(app.byLabel('Expand section').props['aria-controls'],'insulin-nav-l2');
 }finally{await app.unmount();}
 const again=await renderMember('/',routes(EDITOR),{'insulin-nav':'{"l1":"collapsed","l2":"collapsed"}'});
 try{
  assert.equal(byId(again,'insulin-nav-l1').props['data-state'],'collapsed','the next visit starts as it was left');
  assert.equal(byId(again,'insulin-nav-l2').props['data-state'],'collapsed');
  await again.click(again.byLabel('Expand navigation'),'Expand navigation');
  assert.equal(again.local.map.get('insulin-nav'),'{"l1":"expanded","l2":"collapsed"}');
  assert.equal(named(again.byLabel('Primary'),'a','Envelopes').props.title,undefined);
 }finally{await again.unmount();}
});

test('the organization switcher and the person come from /__insulin/me, switching and signing out through the gateway',async()=>{
 let failSwitch=true;
 const app=await renderMember('/',routes(EDITOR,PLATFORM,c=>{
  if(c.path==='/__insulin/switch-org'){if(failSwitch){failSwitch=false;return json({error:'not_found'},404);}return json({ok:true});}
  if(c.path==='/__insulin/logout')return json({ok:true,next:`${APEX}/`});
 }));
 try{
  const [orgButton]=controlsOf(app,'insulin-org-menu');
  assert.ok(orgButton,'the switcher heads level 1');
  assert.match(visibleText(orgButton.children),/Northwind Example\s+Admin/);
  assert.equal(orgButton.props['aria-expanded'],false);assert.equal(byId(app,'insulin-org-menu').props.hidden,true);
  await app.click(orgButton,'the switcher');
  const menu=byId(app,'insulin-org-menu');
  assert.equal(menu.props.hidden,false);
  assert.equal(named(menu,'button','Northwind Example Admin').props['aria-current'],'true');
  assert.deepEqual(links(menu),[['Create an organization',`${APEX}/orgs/new`]]);
  await app.click(named(menu,'button','Southwind Example Viewer'),'Southwind');
  assert.match(app.text(),/Couldn’t switch organization\. Please try again\./);assert.deepEqual(app.assigned,[]);
  await app.click(named(byId(app,'insulin-org-menu'),'button','Southwind Example Viewer'),'Southwind again');
  const sw=app.calls.filter(c=>c.path==='/__insulin/switch-org').at(-1)!;
  assert.equal(sw.method,'POST');assert.equal(sw.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(String(sw.body)),{orgId:'org-2'});
  assert.deepEqual(app.assigned,['/'],'the new organization\'s app opens at its start');
  // Escape closes the menu where the focus is.
  await app.click(controlsOf(app,'insulin-org-menu')[0],'the switcher');
  await app.keyDown(byId(app,'insulin-org-menu').parent,'Escape');
  assert.equal(byId(app,'insulin-org-menu').props.hidden,true);
  // The person: initials and name, Account and Sign out.
  const [person]=controlsOf(app,'insulin-person-menu');
  assert.match(visibleText(person.children),/AE\s+Ana Example\s+Editor/);
  await app.click(person,'the person');
  const account=byId(app,'insulin-person-menu');
  assert.deepEqual(links(account),[['Account',`${APEX}/account`]]);
  await app.click(named(account,'button','Sign out'),'Sign out');
  const out=app.calls.find(c=>c.path==='/__insulin/logout')!;
  assert.equal(out.method,'POST');assert.equal(out.headers['Content-Type'],'application/x-www-form-urlencoded');
  assert.equal(app.assigned.at(-1),`${APEX}/`);
 }finally{await app.unmount();}
 // Without the gateway (the local preview), the app's own name heads level 1 and the person has no menu.
 const preview=await renderMember('/',routes(EDITOR));
 try{
  assert.deepEqual(controlsOf(preview,'insulin-org-menu'),[]);assert.deepEqual(controlsOf(preview,'insulin-person-menu'),[]);
  assert.match(preview.text(),/Esign/);assert.match(preview.text(),/SE\s+Sam Example\s+Editor/);
 }finally{await preview.unmount();}
});

test('below 768px a menu button opens both levels in a drawer, which Escape and moving to a page close',async()=>{
 const app=await renderMember('/',routes(EDITOR,PLATFORM));
 try{
  const menuButton=()=>controlsOf(app,'insulin-nav')[0];
  assert.equal(menuButton().props['aria-expanded'],false);assert.equal(menuButton().props['aria-label'],'Open menu');
  assert.ok(controlsOf(app,'insulin-org-mobile-menu')[0],'the top bar has the switcher too');
  assert.equal(byId(app,'insulin-nav').props['data-open'],'false');
  assert.match(byId(app,'insulin-nav').props.className,/(^|\s)hidden(\s|$)/);
  await app.click(menuButton(),'Open menu');
  assert.equal(menuButton().props['aria-expanded'],true);assert.equal(menuButton().props['aria-label'],'Close menu');
  assert.equal(byId(app,'insulin-nav').props['data-open'],'true');
  assert.match(byId(app,'insulin-nav').props.className,/max-md:fixed/);
  const root=app.renderer.root.find((n:any)=>typeof n.type==='string'&&'data-insulin-shell' in n.props);
  await app.keyDown(root,'Escape');
  assert.equal(byId(app,'insulin-nav').props['data-open'],'false');
  await app.click(menuButton(),'Open menu');
  await app.click(named(app.byLabel('Section'),'a','Completed'),'Completed');
  assert.equal(byId(app,'insulin-nav').props['data-open'],'false','choosing a page closes the drawer');
 }finally{await app.unmount();}
});

test('the signers\' public pages have no navigation',async()=>{
 const app=readFileSync(new URL('../src/app/App.tsx',import.meta.url),'utf8');
 assert.match(app,/'\/sign'[^\n]*return RecipientPage/);assert.match(app,/editor\\\/page[^\n]*return EditorPage/);assert.match(app,/'\/copy'[^\n]*return CopyPage/);
 const {RecipientPage}=await import('../src/app/ui/RecipientPage.ts');
 const {EditorPage}=await import('../src/app/ui/EditorPage.ts');
 const {CopyPage}=await import('../src/app/ui/CopyPage.ts');
 for(const Page of [RecipientPage,EditorPage,CopyPage]){
  const html=renderToStaticMarkup(React.createElement(Page));
  assert.doesNotMatch(html,/data-insulin-shell|aria-label="(Primary|Section|Breadcrumb)"|insulin-nav/,`${Page.name} has no navigation`);
 }
 for(const file of ['ui/RecipientPage.ts','ui/EditorPage.ts','ui/CopyPage.ts']){
  assert.doesNotMatch(readFileSync(new URL(`../src/app/${file}`,import.meta.url),'utf8'),/member\/(Shell|MemberApp)|__insulin/,`${file} doesn't load the members' shell`);
 }
});
