// The members' navigation as data (DESIGN.md §3.2): the manifest in package.json `insulin.navigation` and the rules it
// keeps, the items each role sees, which item an address opens, each level's state in localStorage `insulin-nav`, and
// Settings' links to the gateway's pages on the apex. shell.test.ts covers the navigation as members see it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {route} from '../src/app/member/MemberApp.ts';
import {ICONS} from '../src/app/member/Shell.ts';
import {statusFilter} from '../src/app/member/api.ts';
import {
 ICON_NAMES,NAVIGATION,NAV_STORAGE_KEY,apexOrigin,appRole,grouped,isAt,isWithin,navigationProblems,readNavState,settingsLinks,visibleNavigation,writeNavState,
 type NavItem,type PlatformMe,
} from '../src/app/member/navigation.ts';

const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).insulin.navigation as NavItem[];
const APEX='https://insulinapps.example.test';
const PLATFORM:PlatformMe={
 user:{name:'Ana Example',email:'ana@example.com'},
 organization:{id:'org-1',name:'Northwind Example',role:'ADMIN',roleLabel:'Admin'},
 organizations:[{id:'org-1',name:'Northwind Example',role:'ADMIN',roleLabel:'Admin',active:true},{id:'org-2',name:'Southwind Example',role:'VIEWER',roleLabel:'Viewer',active:false}],
 links:{account:`${APEX}/account`,apps:`${APEX}/`,organizations:`${APEX}/`},
};

test('the navigation manifest in package.json is valid, and the members\' app renders from it',()=>{
 assert.deepEqual(navigationProblems(manifest),[]);
 assert.deepEqual(NAVIGATION,manifest,'the shell reads package.json itself');
 assert.deepEqual(manifest.map(i=>i.key),['envelopes','templates']);
 assert.ok(!manifest.some(i=>i.key==='docs'||i.key==='settings'),'Docs and Settings are the platform\'s, not the manifest\'s');
 for(const item of manifest.flatMap(i=>[i,...(i.children??[])])){
  const [pathname,search='']=item.path.split('?');
  assert.notEqual(route(pathname!).page,'missing',`${item.path} is a page of the app`);
  if(search)assert.notEqual(statusFilter(`?${search}`),'',`${item.path} filters by a status the list knows`);
 }
 assert.deepEqual(Object.keys(ICONS).sort(),[...ICON_NAMES].sort(),'every bundled icon can be drawn');
});

test('a malformed manifest is refused, with the reason',()=>{
 const item={key:'envelopes',label:'Envelopes',icon:'inbox',path:'/envelopes'};
 const refused=(raw:unknown,reason:RegExp)=>assert.ok(navigationProblems(raw).some(p=>reason.test(p)),`${JSON.stringify(raw)}: ${navigationProblems(raw).join('; ')}`);
 refused({},/must be an array/);
 refused(Array.from({length:13},(_,i)=>({...item,key:`k${i}`})),/at most 12/);
 refused([{...item,key:'Envelopes'}],/key must match/);
 refused([item,{...item}],/used twice/);
 refused([{...item,children:[{...item,key:'all'},{...item,key:'envelopes'}]}],/used twice/);
 refused([{...item,label:''}],/label/);
 refused([{...item,label:'x'.repeat(41)}],/label/);
 refused([{...item,icon:'rocket'}],/icon/);
 for(const path of ['envelopes','//elsewhere.example','/a/../b','/a#b'])refused([{...item,path}],/path must be a path/);
 for(const path of ['/__insulin/me','/settings','/settings/users','/mcp','/.well-known/oauth-authorization-server'])refused([{...item,path}],/gateway's paths/);
 refused([{...item,role:'OWNER'}],/role/);
 refused([{...item,group:''}],/group/);
 refused([{...item,children:[{...item,key:'nested',children:[]}]}],/unknown field "children"/);
 refused([{...item,children:Array.from({length:13},(_,i)=>({...item,key:`c${i}`}))}],/children must be an array of at most 12/);
 refused([{...item,colour:'red'}],/unknown field "colour"/);
 assert.deepEqual(navigationProblems([{...item,path:'/envelopes?status=draft',group:'Work',role:'EDITOR',children:[{...item,key:'drafts',group:'Status'}]}]),[]);
});

test('each role sees the items its role reaches: New envelope is for editors and admins',()=>{
 assert.deepEqual(['OWNER','ADMIN','EDITOR','USER','VIEWER',undefined,'SOMETHING'].map(appRole),['ADMIN','ADMIN','EDITOR','VIEWER','VIEWER','VIEWER','VIEWER']);
 const children=(role:'ADMIN'|'EDITOR'|'VIEWER')=>visibleNavigation(NAVIGATION,role)[0]!.children!.map(c=>c.key);
 assert.ok(!children('VIEWER').includes('new-envelope'));
 assert.ok(children('EDITOR').includes('new-envelope'));assert.ok(children('ADMIN').includes('new-envelope'));
 assert.deepEqual(visibleNavigation(NAVIGATION,'VIEWER').map(i=>i.key),['envelopes','templates'],'every role sees both sections');
 const synthetic:NavItem[]=[{key:'a',label:'A',icon:'home',path:'/a'},{key:'b',label:'B',icon:'key',path:'/b',role:'ADMIN'},{key:'c',label:'C',icon:'bot',path:'/c',role:'EDITOR'}];
 assert.deepEqual(visibleNavigation(synthetic,'VIEWER').map(i=>i.key),['a']);
 assert.deepEqual(visibleNavigation(synthetic,'EDITOR').map(i=>i.key),['a','c']);
 assert.deepEqual(visibleNavigation(synthetic,'ADMIN').map(i=>i.key),['a','b','c']);
 assert.deepEqual(grouped([{group:'X'},{group:'X'},{},{},{group:'Y'}] as {group?:string}[]).map(r=>[r.heading,r.items.length]),[['X',2],[undefined,2],['Y',1]]);
});

test('an address opens its section and names its item',()=>{
 assert.ok(isAt('/envelopes','/',''),'/ is the Envelopes list');
 assert.ok(isAt('/envelopes','/envelopes/',''));
 assert.ok(!isAt('/envelopes','/envelopes','?status=completed'));
 assert.ok(isAt('/envelopes?status=completed','/envelopes','?status=completed'));
 assert.ok(!isAt('/envelopes?status=completed','/envelopes','?status=voided'));
 assert.ok(isWithin('/envelopes','/envelopes/new'));assert.ok(isWithin('/envelopes','/'));
 assert.ok(!isWithin('/envelopes','/envelopes-archive'));assert.ok(!isWithin('/docs','/'));
});

test('each level\'s state is read and written as localStorage insulin-nav, and survives broken storage',()=>{
 const store=()=>{const m=new Map<string,string>();return {getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v),m};};
 const s=store();
 assert.deepEqual(readNavState(s),{l1:'expanded',l2:'expanded'});
 writeNavState(s,{l1:'collapsed',l2:'expanded'});
 assert.equal(s.m.get(NAV_STORAGE_KEY),'{"l1":"collapsed","l2":"expanded"}');
 assert.deepEqual(readNavState(s),{l1:'collapsed',l2:'expanded'});
 s.m.set(NAV_STORAGE_KEY,'{not json');assert.deepEqual(readNavState(s),{l1:'expanded',l2:'expanded'});
 s.m.set(NAV_STORAGE_KEY,'{"l1":"tiny","l2":"collapsed"}');assert.deepEqual(readNavState(s),{l1:'expanded',l2:'collapsed'});
 const broken={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
 assert.deepEqual(readNavState(broken),{l1:'expanded',l2:'expanded'});
 assert.doesNotThrow(()=>writeNavState(broken,{l1:'collapsed',l2:'collapsed'}));
 assert.deepEqual(readNavState(null),{l1:'expanded',l2:'expanded'});
});

test('Settings links to the gateway\'s pages for Esign on the apex, or to the app host\'s paths that lead there',()=>{
 assert.deepEqual(settingsLinks(APEX).map(l=>[l.label,l.href]),[
  ['People',`${APEX}/apps/esign/settings/users`],['Integrations',`${APEX}/apps/esign/settings/integrations`],
  ['API access',`${APEX}/apps/esign/settings/api`],['Connect AI',`${APEX}/apps/esign/settings/connect-ai`]]);
 assert.deepEqual(settingsLinks(null).map(l=>l.href),['/settings/users','/settings/integrations','/settings/api','/settings/connect-ai']);
 assert.equal(apexOrigin(PLATFORM),APEX);
 assert.equal(apexOrigin({...PLATFORM,apex:'https://apex.example.test'}),'https://apex.example.test','an explicit apex first');
 assert.equal(apexOrigin({...PLATFORM,links:{apps:'javascript:alert(1)',account:`${APEX}/account`}}),APEX,'never a script address');
 assert.equal(apexOrigin({...PLATFORM,links:{}}),null);assert.equal(apexOrigin(null),null);
});
