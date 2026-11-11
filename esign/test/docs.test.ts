// The in-app Docs: a Docs entry in the members' navigation for every role (custom roles, someone not signed in, and an
// organization with no template yet included), one Docs component with its topic list and "On this page" links, a
// "not found" for a topic that doesn't exist, and static content that links only within the app.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Docs} from '../src/app/components/Docs.ts';
import {TOPIC_SLUGS,anchorId} from '../src/app/pages/docs/parts.ts';
import {DOC_TOPICS,docTopic} from '../src/app/pages/docs/topics.ts';
import {json,me,renderMember,visibleText} from './helpers/member.ts';
import {statusLabel,taskLabel} from '../src/app/member/api.ts';

const render=(topic:string|undefined)=>renderToStaticMarkup(React.createElement(Docs,{topic}));
const textOf=(html:string)=>html.replace(/<[^>]+>/g,' ').replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\s+/g,' ');

// Every role as Esign sees it, and the visitor the platform hasn't signed in.
const SESSIONS:[string,unknown,number][]=[
 ['an Owner',me('OWNER',['esign.manage','esign.view']),200],
 ['an Admin',me('ADMIN',['esign.manage','esign.view']),200],
 ['an Editor',me('EDITOR',['esign.manage','esign.view']),200],
 ['a User',me('USER',['esign.view']),200],
 ['a Viewer',me('VIEWER',['esign.view']),200],
 ['a custom role that only views',me('OWNER',['esign.view']),200],
 ['someone not signed in',{error:'unauthorized'},401],
];

for(const [who,session,status] of SESSIONS){
 test(`the Docs entry is in ${who}'s navigation, before any template exists, and opens Getting started`,async()=>{
  const app=await renderMember('/',c=>{
   if(c.path==='/api/me')return json(session,status);
   if(c.path==='/api/envelopes')return json({envelopes:[]});
   if(c.path==='/api/templates')return json({templates:[]});
  });
  try{
   const nav=app.byLabel('Primary');assert.ok(nav,'the primary navigation');
   assert.deepEqual(nav.findAll((n:any)=>n.type==='a').map((a:any)=>[visibleText(a.children).trim(),a.props.href]),[['Envelopes','/'],['Templates','/templates'],['Docs','/docs']]);
   if(status===401)assert.match(app.text(),/Sign in to use Esign\./);
   else assert.match(app.text(),/No envelopes yet\./,'an organization that has sent nothing yet');
   const entry=nav.findAll((n:any)=>n.type==='a'&&n.props.href==='/docs')[0];
   assert.equal(entry.props['aria-current'],undefined);
   await app.click(entry,'Docs');
   assert.equal(app.location.pathname,'/docs');
   assert.equal(nav.findAll((n:any)=>n.type==='a'&&n.props.href==='/docs')[0].props['aria-current'],'page');
   const title=app.renderer.root.findAll((n:any)=>n.type==='h1')[0];
   assert.equal(visibleText(title.children),'Getting started');
   assert.ok(app.byLabel('Docs topics'));
   // A topic link moves to that topic in place.
   await app.click(app.link('Roles and permissions'),'Roles and permissions');
   assert.equal(app.location.pathname,'/docs/roles');
   assert.match(app.text(),/Service accounts and AI agents/);
  }finally{await app.unmount();}
 });
}

test('a Viewer can open a topic by its address, and the Templates page points them to it',async()=>{
 const app=await renderMember('/templates',c=>{
  if(c.path==='/api/me')return json(me('VIEWER',['esign.view']));
  if(c.path==='/api/templates')return json({templates:[]});
 });
 try{
  assert.match(app.text(),/Your role can see templates but not change them\./);
  await app.click(app.link('Roles and permissions'),'the roles link');
  assert.equal(app.location.pathname,'/docs/roles');
  assert.equal(visibleText(app.renderer.root.findAll((n:any)=>n.type==='h1')[0].children),'Roles and permissions');
 }finally{await app.unmount();}
});

test('the topics are listed in reading order, in two groups, and /docs opens the first',()=>{
 assert.deepEqual(DOC_TOPICS.map(t=>t.slug),[...TOPIC_SLUGS]);
 assert.deepEqual([...new Set(DOC_TOPICS.map(t=>t.group))],['app','background']);
 assert.equal(docTopic(undefined)?.slug,'getting-started');
 assert.equal(docTopic('no-such-topic'),undefined);
 const html=render(undefined);
 assert.match(html,/<h1[^>]*>Getting started<\/h1>/);
 for(const topic of DOC_TOPICS)assert.ok(html.includes(`href="/docs/${topic.slug}"`),`the list links ${topic.slug}`);
 assert.ok(html.includes('aria-current="page"'));
});

for(const topic of DOC_TOPICS){
 test(`the "${topic.title}" topic renders its title, summary, sections and contents, linking only within the app`,()=>{
  const html=render(topic.slug);
  assert.ok(html.includes(`>${topic.title}</h1>`));
  assert.ok(textOf(html).includes(topic.summary),'the summary');
  assert.ok(topic.sections.length>0);
  for(const section of topic.sections){
   assert.match(html,new RegExp(`<h2 id="${section.id}"[^>]*>`),`the heading of ${section.id}`);
   assert.ok(html.includes(`href="#${section.id}"`),`"On this page" links ${section.id}`);
   assert.ok(textOf(renderToStaticMarkup(React.createElement(React.Fragment,null,section.body))).trim().length>20,`${section.id} has text`);
  }
  // General information, not legal advice: on the background topic only.
  assert.equal(html.includes('General information, not legal advice'),!!topic.generalInformation);
  for(const [,href] of html.matchAll(/href="([^"]*)"/g)){
   if(href.startsWith('#'))continue;
   assert.match(href,/^\/(docs\/[a-z0-9-]+(#[a-z0-9-]+)?|templates)?$/,`${href} stays in the app`);
   const [, slug, section]=href.match(/^\/docs\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/)??[];
   if(!slug)continue;
   const target=docTopic(slug);assert.ok(target,`${href} names a topic`);
   if(section)assert.ok(render(slug).includes(`id="${section}"`),`${href} names a section of ${slug}`);
  }
 });
}

test('only the background on electronic signatures is general information, and it says what Esign does',()=>{
 assert.deepEqual(DOC_TOPICS.filter(t=>t.generalInformation).map(t=>t.slug),['e-signatures']);
 const text=textOf(render('e-signatures'));
 assert.match(text,/It isn't legal advice/);
 assert.match(text,/ESIGN Act/);assert.match(text,/eIDAS/);
 assert.match(text,/In Esign: the signer adopts their typed name/);
 assert.match(text,/doesn't make advanced or qualified signatures/);
});

test('the Docs cover the main tasks, what each role sees, signers, statuses, evidence, and due work every five minutes',()=>{
 const all=textOf(DOC_TOPICS.map(t=>render(t.slug)).join(' '));
 for(const words of [/Upload with a signature page/,/Upload and place fields/,/Send for signature/,/Void envelope/,/Process due work/,/Owner/,/Admin/,/Editor/,/User/,/Viewer/,/custom role/,/Service accounts/,/AI agents/,/About signing/,/Decline to sign/,/6-digit code/,/LOCAL TEST ONLY/,/RFC 3161/,/audit trail/])
  assert.match(all,words);
 for(const slug of ['getting-started','statuses']){
  const text=textOf(render(slug));
  assert.match(text,/The platform runs (Esign's due work|it) for every organization every five minutes/,`${slug} says the platform runs due work every five minutes`);
  assert.match(text,/POST \/api\/process-due/,`${slug} says process-due finishes it at once`);
  assert.doesNotMatch(text,/Hosts call POST \/api\/process-due on a schedule/,`${slug} no longer asks hosts to schedule it`);
 }
 assert.match(textOf(render('roles')),/Every role can read these Docs/);
});

// The first column of the table labelled `label` in a rendered topic.
const tableRows=(html:string,label:string)=>{
 const table=new RegExp(`<table aria-label="${label}"[\\s\\S]*?</table>`).exec(html)?.[0];
 assert.ok(table,`the ${label} table`);
 return [...table.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map(m=>textOf(m[1]).trim());
};
// Every source file of the server, to read which statuses it writes.
const serverSources=()=>{
 const dir=new URL('../src/app/server/',import.meta.url);
 return (readdirSync(dir,{recursive:true}) as string[]).filter(name=>name.endsWith('.ts')).map(name=>readFileSync(new URL(name,dir),'utf8')).join('\n');
};

test('the statuses topic lists exactly the envelope and signer statuses the API sets, and says signers keep theirs when an envelope ends early',()=>{
 const html=render('statuses');
 const envelopeStatuses=['IN_PROGRESS','FINALIZING','COMPLETED','VOIDED','DECLINED','EXPIRED'];
 assert.deepEqual(tableRows(html,'Envelope statuses'),envelopeStatuses.map(statusLabel));
 // A signer's task is created PENDING or ACTIVE and only ever updated to ACTIVE or SIGNED: voiding, declining and
 // expiring change the envelope's status, never a task's.
 const source=serverSources();
 const written=new Set([...source.matchAll(/UPDATE tasks SET status\s*=\s*'([A-Z_]+)'/g)].map(m=>m[1]));
 assert.deepEqual([...written].sort(),['ACTIVE','SIGNED'],'the task statuses the server updates to');
 assert.match(source,/index === 0 \? 'ACTIVE' : 'PENDING'/,'a new envelope\'s tasks start ACTIVE (the first) or PENDING');
 assert.deepEqual(tableRows(html,'Signer statuses'),['PENDING','ACTIVE','SIGNED'].map(taskLabel));
 assert.deepEqual(tableRows(html,'Signer statuses'),['Waiting for an earlier signer','Asked to sign','Signed']);
 const text=textOf(html);
 assert.match(text,/signers who hadn't signed keep the status they had/);
 assert.match(text,/the signer who declined still shows Asked to sign/);
});

test('the glossary defines each term once, A to Z, each with its own anchor',()=>{
 const topic=docTopic('glossary')!;
 assert.ok(topic.compactContents);
 const html=render('glossary');
 const terms=[...html.matchAll(/<dt id="([^"]+)"[^>]*>([^<]+)<\/dt>/g)].map(m=>[m[1],m[2]]);
 assert.ok(terms.length>=25,`${terms.length} terms`);
 for(const [id,term] of terms)assert.equal(id,anchorId(term));
 const names=terms.map(([,term])=>term.toLowerCase());
 assert.deepEqual(names,[...names].sort(),'alphabetical');
 assert.equal(new Set(names).size,names.length,'each once');
 for(const term of ['envelope','template','audit trail','seal','verification code','void','service account','ai agent'])assert.ok(names.includes(term),term);
 assert.deepEqual(topic.sections.map(s=>s.title),[...new Set(names.map(n=>n[0].toUpperCase()))]);
});

// Esign's Docs at https://esign.insulinapps.com/docs showed everything in one narrow column: a misplaced parenthesis
// rendered the article inside the topic list's <nav>, so the two-column grid had one child, in its 13rem column.
test('the topic list and the topic are the grid\'s two columns: the article is never inside the navigation',()=>{
 for(const topic of [undefined,...DOC_TOPICS.map(t=>t.slug)]){
  const html=render(topic);
  const stack:string[]=[];let parents:string[]|undefined;
  for(const [,close,name,self] of html.matchAll(/<(\/?)([a-z0-9]+)\b[^>]*?(\/?)>/g)){
   if(self||['br','img','input','path','circle','rect','line','polyline'].includes(name))continue;
   if(close){stack.pop();continue;}
   if(name==='article'){parents=[...stack];break;}
   stack.push(name);
  }
  assert.deepEqual(parents,['div'],`${topic ?? '/docs'}: the article is a column of the grid, beside the topic list`);
 }
});

test('a topic that does not exist says so and points to the start',()=>{
 const html=render('no-such-topic');
 assert.match(html,/Topic not found/);
 assert.ok(html.includes('href="/docs/getting-started"'));
});

test('the Docs are static: no requests, no outside addresses',()=>{
 const dir=new URL('../src/app/pages/docs/',import.meta.url);
 const files=[...readdirSync(dir).map(name=>new URL(name,dir)),new URL('../src/app/components/Docs.ts',import.meta.url)];
 for(const file of files){
  const source=readFileSync(file,'utf8');
  assert.doesNotMatch(source,/\bfetch\(|XMLHttpRequest|https?:\/\//,`${file.pathname} is static`);
 }
});
