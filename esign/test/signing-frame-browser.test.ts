// The signing page in a host's frame, in Chrome, served as the platform serves it: the built page, with the headers
// page-headers.ts gives it behind the gateway (its frame-ancestors from the link's ?host=). Reloaded in its frame after
// its code was used, the page is still allowed there and says so itself; and "Confirm it's you" fits a phone, framed
// 280 to 320 px wide or on its own, light and dark, without scrolling sideways. Synthetic data only.
import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {build} from 'vite';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {applyMigrations,blobStore} from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import {pageHeaders} from '../src/app/server/page-policy.ts';

const chrome=process.env.ESIGN_TEST_CHROME??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const APP='http://127.0.0.1:8787',HOST='http://127.0.0.1:5173';
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
const button=(name:string)=>`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(name)}&&!b.disabled)`;
const frameAncestors=(csp:string)=>csp.split('; ').find(d=>d.startsWith('frame-ancestors '));

/** The app (its API and built pages), a host's page on another origin, and Chrome, shared by the tests below. */
async function start(){
 const temp=await mkdtemp(join(tmpdir(),'esign-signing-frame-')),output=join(temp,'build');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 const stops:(()=>Promise<unknown>)[]=[()=>mf.dispose(),()=>rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200})];
 const stop=async()=>{for(const s of stops.reverse())await s().catch(()=>{});};
 try{
  await build({configFile:false,root:resolve('.'),logLevel:'silent',build:{outDir:output,rollupOptions:{input:{index:resolve('index.html')}}}});
  const db=await mf.getD1Database('DB');await applyMigrations(db);
  const key='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('a')"),db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(digest)]);
  const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),TEST_MAIL:await blobStore(mf,'test-mail'),OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request(APP+path,init),env),mgmt={authorization:`Bearer ${key}`};
  const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const pdf=await PDFDocument.create();pdf.addPage([612,792]);const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["ana"]');
  const template=await (await req('/api/templates',{method:'POST',headers:mgmt,body:form})).json() as {id:string};
  /** A code for a new envelope's signer (each with a code of their own to send), and the link to the signing page. */
  let envelopes=0;
  const view=async(body:Record<string,unknown>)=>{
   const created=await req('/api/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana Example',email:'ana@example.com'}]},{...mgmt,'idempotency-key':`signing-frame-${++envelopes}`}));assert.equal(created.status,201,await created.clone().text());
   const envelope=(await created.json() as {id:string}).id,task=(await (await req(`/api/envelopes/${envelope}`,{headers:mgmt})).json() as {tasks:{id:string}[]}).tasks[0]!.id;
   const r=await req(`/api/envelopes/${envelope}/tasks/${task}/recipient-view`,post({signedInEmail:'ana@example.com',...body},mgmt));assert.equal(r.status,201,await r.clone().text());
   return await r.json() as {code:string;url:string};
  };

  // What Chrome asked the app for: every page (its query and the CSP it was sent with) and every code exchange.
  const pages:{path:string;search:string;csp:string}[]=[],counts={exchanges:0};
  const asset=async(path:string)=>{try{const data=await readFile(join(output,path));return new Response(data,{headers:{'content-type':path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.css')?'text/css':path.endsWith('.js')||path.endsWith('.mjs')?'text/javascript':'application/octet-stream'}});}catch{return new Response(null,{status:404});}};
  const proxy=createServer(async(rq,rs)=>{try{
   const url=new URL(rq.url!);let response:Response;
   if(url.origin===HOST&&url.pathname==='/host.html'){
    // A host's page: the signing page framed at the width the test gives.
    const src=url.searchParams.get('src')??'about:blank',width=Number(url.searchParams.get('w')??300);
    response=new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Host</title><style>body{margin:0}iframe{display:block;border:0;width:${width}px;height:720px}</style></head><body><iframe id="esign" title="Sign" src="${esc(src)}"></iframe></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}});
   }else if(url.origin===APP&&url.pathname.startsWith('/api/')){
    const parts:Buffer[]=[];for await(const part of rq)parts.push(Buffer.from(part));const body=Buffer.concat(parts);
    const headers=new Headers();for(const [k,v] of Object.entries(rq.headers))if(v!==undefined&&k!=='host'&&k!=='connection')headers.set(k,Array.isArray(v)?v.join(','):v);
    if(url.pathname==='/api/public/page-sessions/exchange')counts.exchanges++;
    response=await app.fetch(new Request(url,{method:rq.method,headers,...(body.length?{body}:{})}),env);
   }else if(url.origin===APP){
    // The built pages as the platform serves them (index.html for every page path), with the headers the app's page
    // middleware adds behind the gateway: the signing page's frame-ancestors comes from its address's ?host=.
    response=await asset(url.pathname.startsWith('/assets/')?url.pathname:'/index.html');
    const page=await pageHeaders(url.pathname,response.headers.get('content-type'),{signingHost:url.searchParams.get('host'),viaGateway:true,editorParent:async()=>null});
    if(page){for(const [name,value] of Object.entries(page))response.headers.set(name,value);pages.push({path:url.pathname,search:url.search,csp:page['Content-Security-Policy']!});}
   }else response=new Response(null,{status:404});
   rs.writeHead(response.status,Object.fromEntries(response.headers));rs.end(Buffer.from(await response.arrayBuffer()));
  }catch{rs.writeHead(500).end();}});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');stops.push(()=>new Promise<void>(r=>proxy.close(()=>r())));
  const port=(proxy.address() as import('node:net').AddressInfo).port;
  const browser=spawn(chrome!,['--headless=new','--window-size=1280,1100','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${temp}/chrome`,`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>','about:blank'],{stdio:'ignore'});
  // Chrome can still be writing its profile as it exits: it stops before the profile is removed.
  stops.push(async()=>{browser.kill('SIGTERM');await Promise.race([once(browser,'exit'),sleep(3000)]);});
  let debug='';for(let i=0;i<200;i++){try{debug=(await readFile(join(temp,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0]!;break;}catch{if(browser.exitCode!==null)throw new Error('Chrome exited');await sleep(100);}}assert.ok(debug);
  const target=await (await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`,{method:'PUT'})).json() as {webSocketDebuggerUrl:string};
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws.onopen=()=>r();ws.onerror=()=>j(new Error('CDP unavailable'));});stops.push(async()=>ws.close());
  let seq=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression:string,contextId?:number)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  // The signing page's frame (same site as the host, so in the host's process), and a world to read and click in it.
  const signingFrame=async()=>((await call('Page.getFrameTree')).frameTree.childFrames??[]).map((f:any)=>f.frame).find((f:any)=>f.url.startsWith(APP)||f.url.startsWith('chrome-error:'));
  const inFrame=async(expression:string)=>{const frame=await signingFrame();if(!frame?.url.startsWith(APP))throw new Error(`no signing page in the frame: ${frame?.url}`);const {executionContextId}=await call('Page.createIsolatedWorld',{frameId:frame.id,worldName:'test'});return evaluate(expression,executionContextId);};
  const waitFor=async(read:()=>Promise<any>,label:string,ms=30000)=>{const end=Date.now()+ms;let last:unknown;while(Date.now()<end){try{last=await read();if(last)return last;}catch(error){last=String(error);}await sleep(100);}throw new Error(`Timed out: ${label} (${JSON.stringify(last)})`);};
  /** Opens a link in the host's frame `width` px wide, on a fresh page. */
  const openFramed=async(url:string,width:number)=>{await call('Page.navigate',{url:'about:blank'});await call('Page.navigate',{url:`${HOST}/host.html?w=${width}&src=${encodeURIComponent(url)}`});await waitFor(()=>inFrame(`Boolean(${button('Continue')})`),'the framed page opens');};
  return {view,pages,counts,call,evaluate,signingFrame,inFrame,waitFor,openFramed,stop};
 }catch(error){await stop();throw error;}
}
let shared:ReturnType<typeof start>|undefined;
const stack=()=>shared??=start();
after(async()=>{if(shared)await (await shared).stop();});

test('a framed signing page reloaded in its frame keeps its host: still framed, it says it has no code',{skip:!chrome,timeout:180000},async()=>{
 const s=await stack();
 const link=await s.view({allowedParentOrigin:HOST});
 assert.equal(link.url,`${APP}/sign?host=${encodeURIComponent(HOST)}#code=${link.code}`);
 const before=s.pages.length,exchanges=s.counts.exchanges;
 await s.openFramed(link.url,390);
 // The page took the code out of its address (and so out of the history and any log of it), and kept the host.
 assert.equal(await s.inFrame('location.href'),`${APP}/sign?host=${encodeURIComponent(HOST)}`,'the address keeps the link\'s host, never the code');
 assert.equal(s.counts.exchanges,exchanges+1);
 await s.inFrame('location.reload()');
 await s.waitFor(async()=>s.pages.length===before+2,'the frame reloads');
 const reload=s.pages.at(-1)!;
 assert.equal(`${reload.path}${reload.search}`,`/sign?host=${encodeURIComponent(HOST)}`,'the reload asks for the page with its host');
 assert.equal(frameAncestors(reload.csp),`frame-ancestors 'self' ${HOST}`,'and is sent the host in frame-ancestors');
 await s.waitFor(async()=>/No recipient code provided\./.test(await s.inFrame('document.body.innerText')),'the reloaded page says it has no code',10000)
  .catch(async error=>{throw new Error(`${error.message}; the frame is ${(await s.signingFrame())?.url}`);});
 assert.equal(s.counts.exchanges,exchanges+1,'the reload exchanges nothing');
});

test('"Confirm it\'s you" fits a phone: framed 280 to 320 px wide or on its own, light and dark',{skip:!chrome,timeout:180000},async()=>{
 const s=await stack();
 // Nothing scrolls sideways (the steps above included), the six boxes sit inside their card, Back and Verify code are on
 // screen, and the boxes are 44 px wide where there is room and never narrower than 32 px or lower than 44 px, a
 // comfortable touch target.
 const measure=`(()=>{const d=document.documentElement,group=document.querySelector('.esign-code-boxes'),boxes=[...group.querySelectorAll('input')].map(b=>b.getBoundingClientRect()),card=group.closest('.esign-check-card'),c=card.getBoundingClientRect(),s=getComputedStyle(card),actions=[...document.querySelectorAll('.esign-actions button')].map(b=>b.getBoundingClientRect());
  return {scroll:d.scrollWidth,client:d.clientWidth,widths:boxes.map(b=>Math.round(b.width*10)/10),heights:boxes.map(b=>b.height),left:Math.min(...boxes.map(b=>b.left)),right:Math.max(...boxes.map(b=>b.right)),cardLeft:c.left+parseFloat(s.paddingLeft)+parseFloat(s.borderLeftWidth),cardRight:c.right-parseFloat(s.paddingRight)-parseFloat(s.borderRightWidth),actionsRight:Math.max(...actions.map(b=>b.right)),steps:[...document.querySelectorAll('.esign-step-number')].map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height];}),border:getComputedStyle(group.querySelector('input')).borderTopColor,background:s.backgroundColor};})()`;
 const check=(m:any,label:string,wide:boolean)=>{
  assert.ok(m.scroll<=m.client,`${label}: scrolls sideways (scrollWidth ${m.scroll} > clientWidth ${m.client}); boxes ${m.widths}`);
  assert.equal(m.widths.length,6,label);
  assert.ok(m.left>=m.cardLeft-.5&&m.right<=m.cardRight+.5,`${label}: the boxes leave their card (${m.left}..${m.right} in ${m.cardLeft}..${m.cardRight})`);
  assert.ok(m.actionsRight<=m.client+.5,`${label}: an action is off screen (${m.actionsRight} > ${m.client})`);
  for(const w of m.widths)assert.ok(wide?Math.abs(w-44)<.5:w>=32&&w<=44.5,`${label}: box widths ${m.widths}`);
  for(const h of m.heights)assert.ok(h>=44,`${label}: box heights ${m.heights}`);
  assert.deepEqual(m.steps,[[24,24],[24,24],[24,24]],`${label}: the step numbers stay round`);
  assert.notEqual(m.border,m.background,`${label}: the boxes' borders don't show on their card`);
 };
 const settle=(read:(e:string)=>Promise<any>)=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const scheme=(value:string)=>s.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value}]});

 // In a host's frame: the frame narrows as the host's column does.
 await s.openFramed((await s.view({allowedParentOrigin:HOST})).url,300);
 await s.inFrame(`${button('Continue')}.click()`);
 await s.waitFor(()=>s.inFrame(`document.querySelectorAll('.esign-code-boxes input:not(:disabled)').length===6`),'the code is sent');
 for(const value of ['light','dark']){
  await scheme(value);
  for(const width of [390,320,300,280]){
   await s.evaluate(`document.getElementById('esign').style.width='${width}px'`);await settle(s.inFrame);
   check(await s.inFrame(measure),`framed ${width} px wide, ${value}`,width>=390);
  }
 }

 // On its own (a code issued with no host), as a phone lays it out.
 await scheme('light');await s.call('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:2,mobile:true});
 await s.call('Page.navigate',{url:'about:blank'});await s.call('Page.navigate',{url:(await s.view({})).url});
 await s.waitFor(()=>s.evaluate(`Boolean(${button('Continue')})`),'the page opens on its own');await s.evaluate(`${button('Continue')}.click()`);
 await s.waitFor(()=>s.evaluate(`document.querySelectorAll('.esign-code-boxes input:not(:disabled)').length===6`),'the code is sent on its own page');
 for(const value of ['light','dark']){
  await scheme(value);
  for(const width of [390,320,280]){
   await s.call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:2,mobile:true});await settle(s.evaluate);
   check(await s.evaluate(measure),`on its own ${width} px wide, ${value}`,width>=390);
  }
 }
});
