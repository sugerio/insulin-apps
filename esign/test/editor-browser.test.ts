import {blobStore} from './helpers/platform.ts';
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {build,createServer as createViteServer} from 'vite';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {signatureGeometry} from '../src/app/server/esign/field-render.ts';
import {renderTypedSignature} from '../src/app/server/esign/field-render.ts';
import app from './helpers/gateway.ts';
import {withLocalTestOtp} from './helpers/local-otp-display.ts';
import {signedPdf} from './helpers/signed-pdf.ts';
import {processEnvelopeStep,finalizeEnvelopeStep} from '../src/app/server/esign/envelope-completion.ts';
import {setEditorOrigins} from './helpers/editor-origins.ts';
import {pageHeaders} from '../src/app/server/page-policy.ts';
const chrome=process.env.ESIGN_TEST_CHROME??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
// The window is tall enough for the toolbar and the page it drags onto to be on screen together:
// CDP mouse events outside the viewport never reach the cross-origin frame.
test('cross-origin browser embeds, saves and reopens; hostile parent and spoofed messages fail',{skip:!chrome,timeout:120000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'esign-editor-browser-'));const output=join(temp,'build');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 let releaseSave!:()=>void,releaseBefore!:()=>void,saveHeld=false,beforeHeld=false,holdNextSave=true;const saveGate=new Promise<void>(r=>{releaseSave=r;});const beforeGate=new Promise<void>(r=>{releaseBefore=r;});
 // The UI source, served as modules on its own origin, for rendering PDFs with the page's own renderer.
 const vite=await createViteServer({configFile:false,root:resolve('src/app/ui'),appType:'custom',server:{middlewareMode:true,hmr:false}});
 let browser:ReturnType<typeof spawn>|undefined,ws:WebSocket|undefined,proxy:ReturnType<typeof createServer>|undefined;
 try{
  await build({configFile:false,root:resolve('.'),logLevel:'silent',build:{outDir:output,rollupOptions:{input:{index:resolve('index.html')}}}});
  // The test host page that embeds the editor is a fixture, built next to the pages it embeds.
  await build({configFile:false,root:resolve('test/fixtures'),logLevel:'silent',build:{outDir:output,emptyOutDir:false,rollupOptions:{input:{host:resolve('test/fixtures/editor-host.html')}}}});
  const db=await mf.getD1Database('DB');for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const key='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants (id) VALUES ('tenant')").run();await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?, 'tenant')").bind(digest).run();await setEditorOrigins(db,'tenant',['http://127.0.0.1:5173']);
  const asset=async(path:string)=>{try{if(!/^\/(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(path))return new Response(null,{status:404});const data=await readFile(join(output,path));const content=path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':path.endsWith('.js')||path.endsWith('.mjs')?'text/javascript':'application/octet-stream';return new Response(data,{headers:{'content-type':content}});}catch{return new Response(null,{status:404});}};
  const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),TEST_MAIL:await blobStore(mf,'test-mail'),OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes',ASSETS:{fetch:(request:Request)=>asset(new URL(request.url).pathname)}};
  const signingApp=app;
  const records:{origin:string;path:string;requestOrigin:string|null;referer:string|null;status:number;secretLeaked:boolean}[]=[];
  proxy=createServer(async(req,res)=>{try{
   const url=new URL(req.url!);if(url.origin==='http://127.0.0.1:5175'){if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Renderer</title>');return;}req.url=url.pathname+url.search;vite.middlewares(req,res);return;}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v!==undefined&&k!=='host'&&k!=='connection')headers.set(k,Array.isArray(v)?v.join(','):v);
   let response:Response;
   if(url.pathname==='/api/public/editor/save'&&holdNextSave){beforeHeld=true;await beforeGate;}
   if(url.origin==='http://127.0.0.1:5173'&&url.pathname==='/host/editor-demo-session'){
    const form=await new Request('http://127.0.0.1:5173/host/editor-demo-session',{method:'POST',headers,body:Buffer.concat(chunks)}).formData();const file=form.get('file');if(!(file instanceof File))throw new Error('Invalid file');const roles=JSON.parse(String(form.get('roles')));
    // The host backend opens the session, then uploads the chosen file to it as the source.
    const management={authorization:`Bearer ${key}`};
    response=await app.fetch(new Request('http://127.0.0.1:8787/api/template-editing-sessions',{method:'POST',headers:{...management,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'http://127.0.0.1:5173',roles})}),env);
    if(response.status===201){const created=await response.clone().json() as {sessionId:string};const staged=await app.fetch(new Request(`http://127.0.0.1:8787/api/template-editing-sessions/${created.sessionId}/source`,{method:'POST',headers:{...management,'content-type':'application/pdf'},body:new Uint8Array(await file.arrayBuffer())}),env);if(staged.status!==201)response=staged;}
   }else if(url.origin==='http://127.0.0.1:5173'&&url.pathname.startsWith('/host/template-editing-sessions')){headers.set('authorization',`Bearer ${key}`);const target='http://127.0.0.1:8787/api'+url.pathname.slice('/host'.length);response=await app.fetch(new Request(target,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}),env);}
   else if(url.origin==='http://127.0.0.1:5173'&&url.pathname==='/')response=new Response(await readFile(join(output,'index.html')),{headers:{'content-type':'text/html'}});
   else if(url.origin==='http://127.0.0.1:5173'&&url.pathname==='/editor-host.html'){response=new Response(await readFile(join(output,'editor-host.html')),{headers:{'content-type':'text/html'}});}
   else if(url.origin==='http://127.0.0.1:5173'&&url.pathname.startsWith('/assets/'))response=await asset(url.pathname);
   // The app's origin: its API, and otherwise the built pages, as the platform serves them (index.html for every page path).
   else if(url.origin==='http://127.0.0.1:8787'&&!url.pathname.startsWith('/api/')){
    response=await asset(url.pathname.startsWith('/assets/')?url.pathname:'/index.html');
    // The headers the app's page middleware (src/app/server/page-headers.ts) adds behind the gateway.
    const page=await pageHeaders(url.pathname,response.headers.get('content-type'),{frameAncestors:'',viaGateway:true,editorParent:async id=>(await db.prepare('SELECT parent_origin FROM editor_sessions WHERE id = ?').bind(id).first<{parent_origin:string}>())?.parent_origin??null});
    if(page)for(const [name,value] of Object.entries(page))response.headers.set(name,value);
   }
   else if(url.origin==='http://127.0.0.1:8787'){response=await signingApp.fetch(new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}),env);if(url.pathname==='/api/public/signing/otp'&&req.method==='POST')response=await withLocalTestOtp(response,env.TEST_MAIL);}
   else if(url.origin==='http://127.0.0.1:5174')response=new Response('<html><body>hostile</body></html>',{headers:{'content-type':'text/html'}});
   else response=new Response(null,{status:404});
   if(url.pathname==='/api/public/editor/save'&&holdNextSave){holdNextSave=false;saveHeld=true;await saveGate;}
   records.push({origin:url.origin,path:url.pathname+url.search,requestOrigin:headers.get('origin'),referer:headers.get('referer'),status:response.status,secretLeaked:Buffer.concat(chunks).includes('synthetic-sensitive-token')||JSON.stringify([...headers]).includes('synthetic-sensitive-token')});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500).end();}});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const port=(proxy.address() as import('node:net').AddressInfo).port;
  browser=spawn(chrome!,['--headless=new','--window-size=1280,1100','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${temp}/chrome`,`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>','about:blank'],{stdio:'ignore'});
  let debug='';for(let i=0;i<200;i++){try{debug=(await readFile(join(temp,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await sleep(100);}}assert.ok(debug);
  const target=await(await fetch(`http://127.0.0.1:${debug}/json/new?http://127.0.0.1:5173/editor-host.html`,{method:'PUT'})).json() as any;ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws!.onopen=()=>r();ws!.onerror=()=>j(new Error('CDP'));});
  let seq=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression:string,contextId?:number)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async(fn:()=>Promise<any>,label:string)=>{for(let i=0;i<300;i++){try{const v=await fn();if(v)return v;}catch{}await sleep(100);}throw new Error(`Timed out ${label}: ${await evaluate('document.body.innerText')}`);};
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);pdf.addPage([400,600]);const base64=Buffer.from(await pdf.save()).toString('base64');
  await wait(()=>evaluate("document.readyState==='complete' && Boolean(document.querySelector('#open'))"),'host scripts loaded');assert.match(await evaluate('document.body.innerText'),/Changes are not saved until Save template confirms a new template ID/);
  await evaluate(`(()=>{document.querySelector('#synthetic-confirmation').checked=true;const input=document.querySelector('#file');const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));const d=new DataTransfer();d.items.add(new File([bytes],'synthetic.pdf',{type:'application/pdf'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#open').click();})()`);
  const frameContext=async()=>{const tree=await call('Page.getFrameTree');const frame=tree.frameTree.childFrames?.find((x:any)=>x.frame.url.includes('/editor/page/'));if(!frame)return 0;return (await call('Page.createIsolatedWorld',{frameId:frame.frame.id,worldName:'test'})).executionContextId;};
  const context=await wait(frameContext,'frame');await wait(()=>evaluate("document.body.innerText.includes('Template editor')",context),'editor');
  assert.equal(await evaluate("Boolean(document.querySelector('input[type=file]'))",context),false);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Save template')",context),false);
  await wait(()=>evaluate("document.querySelectorAll('[data-page]').length===2",context),'PDF rendered');
  assert.ok(records.some(r=>r.path==='/host/editor-demo-session'&&r.status===201),'host selected file is staged through the session source upload');
  assert.ok(!records.some(r=>r.path.endsWith('/source')),'the browser never uploads the source itself');
  await wait(()=>evaluate("!document.querySelector('#continue').disabled"),'host editor ready');
  await evaluate("document.querySelector('#continue').click()");
  await wait(()=>evaluate("document.querySelector('#status').textContent.includes('add a Signature field')"),'host shows validation error');
  const scroll=await evaluate(`(()=>{const pdf=document.querySelector('[aria-label="PDF pages"]'),panel=document.querySelector('aside');const before=panel.getBoundingClientRect().top;pdf.scrollTop=300;return {scroll:pdf.scrollTop,panelBefore:before,panelAfter:panel.getBoundingClientRect().top,overflow:getComputedStyle(pdf).overflowY}})()`,context);assert.ok(scroll.scroll>0,'PDF panel scrolls independently');assert.equal(scroll.panelBefore,scroll.panelAfter);assert.match(scroll.overflow,/auto|scroll/);
  // Real toolbar drags: different physical pages and displayed scales, center grab and edge clamp.
  for(const [page,zoom] of [[1,1],[2,.7]] as const){
   await evaluate(`document.querySelector('[aria-label="PDF pages"]').style.zoom=${zoom};document.querySelector('[data-page="${page}"]').scrollIntoView({block:'center'})`,context);
   const frame=await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.left,y:r.top}})()");
   const geometry=await evaluate(`(()=>{const t=document.querySelector('[aria-label="Add Title field"]').getBoundingClientRect(),p=document.querySelector('[data-page="${page}"]').getBoundingClientRect(),c=document.querySelector('[data-page="${page}"] canvas');return {tx:t.left+t.width/2,ty:t.top+t.height/2,px:p.left+p.width/2,py:p.top+p.height/2,pw:p.width,ph:p.height,pdfw:+c.dataset.pdfWidth,pdfh:+c.dataset.pdfHeight}})()`,context);
   await evaluate(`document.addEventListener('dragover',e=>{window.__dragPoint={x:e.clientX,y:e.clientY}})`,context);
   const sx=frame.x+geometry.tx,sy=frame.y+geometry.ty,dx=frame.x+geometry.px,dy=frame.y+geometry.py;
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:sx,y:sy});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:sx,y:sy,button:'left',buttons:1,clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:sx-10,y:sy,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dx,y:dy,button:'left',buttons:1});await sleep(150);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dx+1,y:dy,button:'left',buttons:1});
   const preview=await wait(()=>evaluate(`(()=>{const p=document.querySelector('[data-tool-drag-preview]');if(!p||getComputedStyle(p).display==='none')return null;const r=p.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`,context),'toolbar drag preview');
   assert.ok(Math.abs(preview.w-150*geometry.pw/geometry.pdfw)<1);assert.ok(Math.abs(preview.h-34*geometry.ph/geometry.pdfh)<1);const pointer=await evaluate('window.__dragPoint',context);assert.ok(Math.abs(preview.x+preview.w/2-pointer.x)<2);assert.ok(Math.abs(preview.y+preview.h/2-pointer.y)<1);
   await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:dx+1,y:dy,button:'left',buttons:0,clickCount:1});
   const placed=await wait(()=>evaluate(`(()=>{const f=document.querySelector('[data-page="${page}"] [data-editor-field]');if(!f)return null;const r=f.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`,context),'toolbar drop');
   assert.ok(Math.abs(placed.x-preview.x)<1&&Math.abs(placed.y-preview.y)<1&&Math.abs(placed.w-preview.w)<1&&Math.abs(placed.h-preview.h)<1,'drop matches preview');
   assert.equal(await evaluate("document.querySelector('[data-tool-drag-preview]')===null",context),true);
   await evaluate(`document.querySelector('[data-page="${page}"] [aria-label="Delete Title field"]').click()`,context);
  }
  await evaluate(`document.querySelector('[aria-label="PDF pages"]').style.zoom='';document.querySelector('[data-page="1"]').scrollIntoView({block:'center'})`,context);
  assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"Add Signature field\"]'))",context),true,'keyboard add is available');await evaluate("document.querySelector('[aria-label=\"Add Signature field\"]').focus()",context);assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')",context),'Add Signature field');await evaluate("document.querySelector('[aria-label=\"Add Signature field\"]').click()",context);await wait(()=>evaluate("Boolean(document.querySelector('[data-page=\"1\"] button'))",context),'keyboard field added');
  // Drive a native Chrome drag from inside the field, then compare the saved
  // normalized anchor with the pointer movement rather than its top-left.
  await evaluate("document.querySelector('[data-page=\"1\"] button').scrollIntoView({block:'center'})",context);
  const frameBox=await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.left,y:r.top}})()");
  const beforeDrag=await evaluate("(()=>{const f=document.querySelector('[data-editor-field]'),r=f.getBoundingClientRect(),p=f.closest('[data-page]').getBoundingClientRect();const c=f.closest('[data-page]').querySelector('canvas'),b=f.querySelector('button').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,pageWidth:p.width,pageHeight:p.height,pageLeft:p.left,pageTop:p.top,pdfWidth:Number(c.dataset.pdfWidth),pdfHeight:Number(c.dataset.pdfHeight),buttonWidth:b.width,buttonHeight:b.height}})()",context);
  assert.ok(Math.abs(beforeDrag.width/beforeDrag.pageWidth*beforeDrag.pdfWidth-150)<.1);assert.ok(Math.abs(beforeDrag.height/beforeDrag.pageHeight*beforeDrag.pdfHeight-34)<.1);assert.ok(Math.abs(beforeDrag.buttonWidth-beforeDrag.width)<.1&&Math.abs(beforeDrag.buttonHeight-beforeDrag.height)<.1,'visible drag control matches field box');
  const dragX=frameBox.x+beforeDrag.left+beforeDrag.width*.3,dragY=frameBox.y+beforeDrag.top+beforeDrag.height*.5;
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX,y:dragY});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:dragX,y:dragY,button:'left',buttons:1,clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX+8,y:dragY+2,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX+10,y:dragY+3,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragX+10,y:dragY+3,button:'left',buttons:0,clickCount:1});
  const afterDrag=await evaluate("(()=>{const f=document.querySelector('[data-editor-field]'),r=f.getBoundingClientRect(),p=f.closest('[data-page]').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,pageLeft:p.left,pageTop:p.top}})()",context);
  assert.ok(Math.abs(afterDrag.left-afterDrag.pageLeft-beforeDrag.left+beforeDrag.pageLeft-10)<1.5,`small drag horizontal displacement ${afterDrag.left-beforeDrag.left}`);assert.ok(Math.abs(afterDrag.top-afterDrag.pageTop-beforeDrag.top+beforeDrag.pageTop-3)<1.5,`small drag vertical displacement ${afterDrag.top-beforeDrag.top}`);assert.ok(Math.abs(afterDrag.width-beforeDrag.width)<.1&&Math.abs(afterDrag.height-beforeDrag.height)<.1);
  const anchorBeforeKeyboard=await evaluate("parseFloat(document.querySelector('[data-editor-field]').style.left)",context);
  await evaluate(`(()=>{const field=document.querySelector('[data-page="1"] button');field.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));field.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));})()`,context);
  const keyboardAnchor=await wait(()=>evaluate("document.querySelector('[data-page=\"2\"] [data-editor-field]')?.style.left",context),'keyboard field move and page change');assert.ok(Math.abs(parseFloat(keyboardAnchor)-anchorBeforeKeyboard-1)<.01);assert.equal(await evaluate("document.querySelector('aside [aria-label^=Delete]')===null",context),true);assert.equal(await evaluate("[...document.querySelectorAll('[data-page] button')].find(b=>b.getAttribute('aria-label')==='Delete Signature field').textContent",context),'×');await evaluate("document.querySelector('iframe').focus()");await evaluate("[...document.querySelectorAll('[data-page] button')].find(b=>b.getAttribute('aria-label')==='Delete Signature field').focus()",context);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await wait(()=>evaluate("document.querySelectorAll('[data-editor-field]').length===0",context),'keyboard deletion');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('input[type=radio]')].map(r=>r.value)",context),['Partner','Seller']);
  assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"New role\"], [aria-label=\"Add role\"]'))",context),false);
  // Keep both unequal pages visible and drive an uninterrupted native toolbar drag.
  await call('Emulation.setDeviceMetricsOverride',{width:1600,height:2400,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('iframe').style.height='2200px'`);
  await evaluate(`(()=>{document.querySelectorAll('input[type=radio]')[1].click();document.querySelector('.esign-editor-workspace').style.cssText='height:2000px;width:850px;display:grid;grid-template-columns:minmax(0,1fr) 300px';window.nativeToolEvents=[];for(const name of ['dragstart','dragover','drop','dragend','keydown'])document.addEventListener(name,e=>{const p=e.target.closest('[data-page]');window.nativeToolEvents.push({name,page:p?Number(p.dataset.page):null,x:e.clientX,y:e.clientY,key:e.key});},true);})()`,context);
  const outerTool=await evaluate("(()=>{const f=document.querySelector('iframe'),r=f.getBoundingClientRect();return {x:r.left+f.clientLeft,y:r.top+f.clientTop}})()");
  const toolGeometry=await evaluate(`(()=>{const t=document.querySelector('[aria-label="Add Signature field"]').getBoundingClientRect();return {sx:t.left+t.width/2,sy:t.top+t.height/2,pages:[1,2].map(n=>{const p=document.querySelector('[data-page="'+n+'"]'),r=p.getBoundingClientRect(),c=p.querySelector('canvas');return {x:r.left+r.width*.5,y:r.top+r.height*.5,left:r.left,top:r.top,width:r.width,height:r.height,pdfWidth:+c.dataset.pdfWidth,pdfHeight:+c.dataset.pdfHeight}})};})()`,context);
  const startTool=async()=>{const x=outerTool.x+toolGeometry.sx,y=outerTool.y+toolGeometry.sy;await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x-10,y,button:'left',buttons:1});};
  const hoverTool=async(page:number)=>{const p=toolGeometry.pages[page-1],x=outerTool.x+p.x,y=outerTool.y+p.y;await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'left',buttons:1});await sleep(100);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+1,y,button:'left',buttons:1});return {x:x+1,y};};
  const toolPreview=async(page:number)=>{const result=await wait(()=>evaluate(`(()=>{const p=document.querySelector('[data-tool-drag-preview]');if(!p||getComputedStyle(p).display==='none')return null;const r=p.getBoundingClientRect(),events=window.nativeToolEvents.filter(e=>e.name==='dragover'&&e.page===${page});if(!events.length)return null;return {x:r.left,y:r.top,w:r.width,h:r.height,pointer:events.at(-1)};})()`,context),`native toolbar preview page ${page}`),g=toolGeometry.pages[page-1];assert.ok(Math.abs(result.w-150*g.width/g.pdfWidth)<1&&Math.abs(result.h-34*g.height/g.pdfHeight)<1,`preview physical size page ${page}: ${JSON.stringify(result)}`);assert.ok(Math.abs(result.x+result.w/2-result.pointer.x)<1.5&&Math.abs(result.y+result.h/2-result.pointer.y)<1.5,`center grab page ${page}: ${JSON.stringify(result)}`);return result;};
  const bodyChildrenBefore=await evaluate('document.body.children.length',context);
  await startTool();await hoverTool(1);await toolPreview(1);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  // Headless CDP key injection does not cancel an active native drag. Exercise
  // Chrome's native cancellation explicitly; this does not establish OS Escape behavior.
  await call('Input.cancelDragging');
  await wait(()=>evaluate("document.querySelector('[data-tool-drag-preview]')===null",context),'native cancel cleans toolbar preview');
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:outerTool.x+toolGeometry.pages[0].x,y:outerTool.y+toolGeometry.pages[0].y,button:'left',buttons:0,clickCount:1});
  assert.equal(await evaluate('document.querySelectorAll("[data-editor-field]").length',context),0,'native cancel creates no field');assert.equal(await evaluate('document.body.children.length',context),bodyChildrenBefore,'native cancel removes both preview and drag image');
  await evaluate('window.nativeToolEvents=[]',context);await startTool();await hoverTool(1);const firstToolPreview=await toolPreview(1);const releaseTool=await hoverTool(2);const secondToolPreview=await toolPreview(2);assert.ok(Math.abs(firstToolPreview.w-secondToolPreview.w)>1,'preview resizes across unequal PDF pages');
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:releaseTool.x,y:releaseTool.y,button:'left',buttons:0,clickCount:1});
  const nativeSaved=await wait(()=>evaluate(`(()=>{const f=document.querySelector('[data-page="2"] [data-editor-field]');if(!f)return null;const r=f.getBoundingClientRect(),p=f.closest('[data-page]').getBoundingClientRect();return {id:f.dataset.editorField,x:(r.left-p.left)/p.width,y:(r.top-p.top)/p.height,width:r.width/p.width,height:r.height/p.height,left:r.left,top:r.top,w:r.width,h:r.height};})()`,context),'native cross-page toolbar drop');
  assert.ok(Math.abs(nativeSaved.left-secondToolPreview.x)<1&&Math.abs(nativeSaved.top-secondToolPreview.y)<1&&Math.abs(nativeSaved.w-secondToolPreview.w)<1&&Math.abs(nativeSaved.h-secondToolPreview.h)<1,'native cross-page drop does not jump');
  const nativeEvents=await evaluate('window.nativeToolEvents',context);assert.equal(nativeEvents.filter((e:any)=>e.name==='dragstart').length,1);assert.ok(nativeEvents.some((e:any)=>e.name==='dragover'&&e.page===1)&&nativeEvents.some((e:any)=>e.name==='dragover'&&e.page===2)&&nativeEvents.some((e:any)=>e.name==='drop'&&e.page===2),'one continuous native drag crosses both pages');assert.equal(await evaluate('document.body.children.length',context),bodyChildrenBefore,'drop cleans preview and drag image');
  await evaluate("document.querySelector('[data-page=\"2\"] button').click()",context);
  await evaluate("document.querySelectorAll('input[type=radio]')[0].click();document.querySelector('[aria-label=\"Add Signature field\"]').click()",context);
  await wait(()=>evaluate("document.querySelectorAll('[data-page] [data-editor-field]').length===2",context),'second role field');
  await evaluate("document.querySelector('[data-page=\"2\"] button').click()",context);
  await evaluate("document.querySelector('#continue').click()");
  await wait(async()=>beforeHeld,'save request held before commit');
  await evaluate("document.querySelector('#check').click()");
  await wait(()=>evaluate("document.querySelector('#status').textContent.includes('may still commit')"),'uncertain save warning');
  assert.equal(await evaluate("document.querySelector('#continue').disabled"),true,'null result cannot unlock pending save');
  releaseBefore();
  await wait(async()=>saveHeld,'host-requested save response held');
  assert.equal(await evaluate("document.querySelector('#continue').disabled"),true,'host prevents duplicate saves');
  const locked=async()=>evaluate(`(()=>{const roles=[...document.querySelectorAll('input[type=radio]')],del=[...document.querySelectorAll('[data-page] button')].find(b=>b.getAttribute('aria-label')==='Delete Signature field'),palette=[...document.querySelectorAll('[draggable]')];return roles.every(r=>r.matches(':disabled'))&&del.disabled&&palette.every(e=>!e.draggable)})()`,context);
  assert.equal(await locked(),true,'all editing controls must lock while saving');
  const attempt=()=>evaluate(`(()=>{document.querySelector('input[type=radio]').click();[...document.querySelectorAll('[data-page] button')].find(b=>b.getAttribute('aria-label')==='Delete Signature field').click();const target=document.querySelector('[data-page="1"] > div');const data=new DataTransfer();data.setData('text/plain','Text box');target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data,clientX:20,clientY:20}));})()`,context);
  await attempt();assert.equal(await evaluate("document.querySelectorAll('[data-page] [data-editor-field]').length",context),2);assert.equal(await evaluate("[...document.querySelectorAll('input[type=radio]')].some(o=>o.value==='Intruder')",context),false);
  await evaluate("document.querySelector('#check').click()");
  await wait(()=>evaluate("document.querySelector('#status').textContent.includes('Saved template:')"),'backend confirms save despite missing response');
  releaseSave();
  const status=await wait(()=>evaluate("document.querySelector('#status').textContent.match(/Saved template: ([a-f0-9-]+)/)?.[1]"),'confirmed save');
  assert.equal(await locked(),true,'all editing controls remain locked after saving');await attempt();assert.equal(await evaluate("document.querySelectorAll('[data-page] [data-editor-field]').length",context),2);assert.match(await evaluate('document.body.innerText',context),/new session/i);
  assert.ok(records.some(r=>r.path==='/api/public/editor/exchange'&&r.requestOrigin==='http://127.0.0.1:8787'&&r.status===200));
  assert.ok(records.every(r=>!r.path.includes('#')));
  assert.ok(records.filter(r=>r.origin==='http://127.0.0.1:8787').every(r=>!r.path.includes('?')),'editor requests never send credentials in URL query');
  assert.ok(records.filter(r=>r.origin==='http://127.0.0.1:8787'&&(r.path.startsWith('/assets/')||r.path.startsWith('/api/public/editor/'))).every(r=>!r.referer),'editor subrequests send no Referer');
  await evaluate("window.dispatchEvent(new MessageEvent('message',{origin:'http://evil.example.com',source:document.querySelector('iframe').contentWindow,data:{type:'esign.editor.saved'}}))");await sleep(100);assert.match(await evaluate("document.querySelector('#status').textContent"),/Saved template/);
  await evaluate(`document.querySelector('#file').value='';document.querySelector('#source').value=${JSON.stringify(status)};document.querySelector('#open').click()`);
  const context2=await wait(async()=>{const c=await frameContext();return c&&c!==context?c:0;},'reopen frame');await wait(()=>evaluate("[...document.querySelectorAll('[data-page] button')].some(b=>b.textContent.endsWith(' — Signature'))",context2),'reopened field');
  assert.equal(await evaluate("[...document.querySelectorAll('input[type=radio]')].some(o=>o.value==='Seller')",context2),true);
  const nativeReopened=await wait(()=>evaluate(`(()=>{const f=document.querySelector('[data-editor-field="${nativeSaved.id}"]');if(!f)return null;const p=f.closest('[data-page]'),r=f.getBoundingClientRect(),b=p.getBoundingClientRect();return {page:+p.dataset.page,x:(r.left-b.left)/b.width,y:(r.top-b.top)/b.height,width:r.width/b.width,height:r.height/b.height};})()`,context2),'reopen native toolbar field');assert.equal(nativeReopened.page,2);for(const key of ['x','y','width','height'] as const)assert.ok(Math.abs(nativeReopened[key]-nativeSaved[key])<.001,`saved native field ${key} retained: ${JSON.stringify({nativeReopened,nativeSaved})}`);

  await wait(()=>evaluate("!document.querySelector('#continue').disabled"),'reopened host ready');await evaluate("document.querySelector('#continue').click()");const second=await wait(async()=>{const v=await evaluate("document.querySelector('#status').textContent.match(/Saved template: ([a-f0-9-]+)/)?.[1]");return v&&v!==status?v:null;},'second version');assert.notEqual(status,second);
  const original=await db.prepare('SELECT fields_json,roles_json,object_key FROM templates WHERE id=?').bind(status).first() as any;assert.equal(JSON.parse(original.fields_json).length,2);assert.equal(JSON.parse(original.fields_json)[0].page,2);assert.equal(JSON.parse(original.fields_json)[0].role,'Seller');assert.equal(JSON.parse(original.fields_json)[0].required,true);assert.deepEqual(JSON.parse(original.roles_json),['Partner','Seller']);const savedPdf=await env.ARTIFACTS.get(original.object_key);const savedBytes=new Uint8Array(await savedPdf!.arrayBuffer());assert.deepEqual(savedBytes,new Uint8Array(Buffer.from(base64,'base64')));assert.equal((await PDFDocument.load(savedBytes)).getPageCount(),2);
  const legacyForm=new FormData();legacyForm.set('file',new File([await pdf.save()],'legacy.pdf',{type:'application/pdf'}));legacyForm.set('roles','["Signer","signer"]');
  const legacyResponse=await app.fetch(new Request('http://127.0.0.1:8787/api/templates',{method:'POST',headers:{authorization:`Bearer ${key}`},body:legacyForm}),env);assert.equal(legacyResponse.status,201);const legacy=(await legacyResponse.json() as any).id;
  const legacyFields=[
   {id:'legacy-upper',type:'Signature',role:'Signer',page:1,required:true,rect:{x:.4,y:.2,width:.25,height:.05}},
   {id:'legacy-lower',type:'Signature',role:'signer',page:1,required:false,rect:{x:.4,y:.5,width:.25,height:.05}},
  ];
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(legacyFields),legacy).run();
  await evaluate(`document.querySelector('#roles').value='Unrelated';document.querySelector('#source').value=${JSON.stringify(legacy)};document.querySelector('#open').click()`);
  const legacyContext=await wait(async()=>{const c=await frameContext();return c&&c!==context2?c:0;},'legacy frame');
  await wait(()=>evaluate("document.querySelectorAll('[data-page]').length===2",legacyContext),'legacy PDF rendered');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('input[type=radio]')].map(o=>o.value)",legacyContext),['Signer','signer']);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('input[type=radio]')].map(o=>o.checked)",legacyContext),[true,false]);
  await evaluate("document.querySelector('input[type=radio]').focus()",legacyContext);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await wait(()=>evaluate("document.querySelectorAll('input[type=radio]')[1].checked",legacyContext),'keyboard role selection');
  await evaluate("document.querySelector('[aria-label=\"Add Signature field\"]').click()",legacyContext);
  await wait(()=>evaluate("document.querySelectorAll('[data-page=\"1\"] [data-editor-field]').length===3",legacyContext),'keyboard-added legacy field');
  await wait(()=>evaluate("!document.querySelector('#continue').disabled"),'legacy host ready');await evaluate("document.querySelector('#continue').click()");await wait(()=>evaluate("document.querySelector('#status').textContent.includes('duplicate')"),'duplicate validation');await evaluate("[...document.querySelectorAll('[data-page] button')].filter(b=>b.getAttribute('aria-label')==='Delete Signature field').at(-1).click()",legacyContext);
  await evaluate("document.querySelectorAll('[data-page=\"1\"] button')[0].click()",legacyContext);
  await evaluate(`document.querySelectorAll('[data-page="1"] button')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}))`,legacyContext);
  await wait(()=>evaluate("document.querySelectorAll('[data-page=\"2\"] [data-editor-field]').length===1",legacyContext),'existing legacy field moved');
  await evaluate("document.querySelector('#continue').click()");
  const legacyVersion=await wait(async()=>{const v=await evaluate("document.querySelector('#status').textContent.match(/Saved template: ([a-f0-9-]+)/)?.[1]");return v&&v!==second?v:null;},'legacy version');
  for(const id of [legacy,legacyVersion]){const row=await db.prepare('SELECT roles_json,fields_json FROM templates WHERE id=?').bind(id).first() as any;assert.deepEqual(JSON.parse(row.roles_json),['Signer','signer']);const fields=JSON.parse(row.fields_json);if(id===legacy){assert.deepEqual(fields,legacyFields);}else{assert.equal(fields.length,2);assert.deepEqual(fields[0],{...legacyFields[0],page:2,rect:{...legacyFields[0].rect,width:.375,height:.05*800/600}});assert.deepEqual(fields[1],legacyFields[1]);}}
  // Exercise real cross-page drags with differently sized PDF pages. Keep both
  // pages visible so CDP moves a genuine pointer through the iframe, not a
  // synthesized DragEvent. The temporary viewport belongs only to this browser.
  const varied=await PDFDocument.create();const variedFirst=varied.addPage([600.37,800.63]);variedFirst.drawText('Synthetic left original',{x:40,y:520,size:18});variedFirst.drawText('Synthetic right original',{x:330,y:520,size:18});const variedSecond=varied.addPage([900.29,600.71]);variedSecond.drawText('Synthetic left original',{x:40,y:390,size:18});variedSecond.drawText('Synthetic right original',{x:500,y:390,size:18});const varied64=Buffer.from(await varied.save()).toString('base64');
  await call('Emulation.setDeviceMetricsOverride',{width:1600,height:2400,deviceScaleFactor:1,mobile:false});
  await evaluate(`(()=>{document.querySelector('#source').value='';document.querySelector('#roles').value='Partner, Seller';const input=document.querySelector('#file'),bytes=Uint8Array.from(atob(${JSON.stringify(varied64)}),c=>c.charCodeAt(0)),d=new DataTransfer();d.items.add(new File([bytes],'varied.pdf',{type:'application/pdf'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('iframe').style.height='2200px';document.querySelector('#open').click();})()`);
  const variedContext=await wait(async()=>{const c=await frameContext();return c&&c!==legacyContext?c:0;},'varied-page frame');
  await wait(()=>evaluate("document.querySelectorAll('[data-page]').length===2",variedContext),'varied PDF');
  await evaluate(`(()=>{document.querySelector('.esign-editor-workspace').style.cssText='height:2000px;width:850px;display:grid;grid-template-columns:minmax(0,1fr) 300px';document.querySelector('[aria-label="Add Signature field"]').click();window.dragTrace=[];for(const name of ['dragstart','drop'])document.addEventListener(name,e=>{const page=e.target.closest('[data-page]'),field=e.target.closest('[data-editor-field]');if(page){const p=page.getBoundingClientRect(),f=field?.getBoundingClientRect(),c=page.querySelector('canvas');window.dragTrace.push({name,x:e.clientX,y:e.clientY,page:Number(page.dataset.page),pageLeft:p.left,pageTop:p.top,pageWidth:p.width,pageHeight:p.height,pdfWidth:Number(c.dataset.pdfWidth),pdfHeight:Number(c.dataset.pdfHeight),fieldLeft:f?.left,fieldTop:f?.top});}},true);})()`,variedContext);
  let lastAnchor:{x:number;y:number}|undefined;
  for(const [zoom,from,to] of [[0.75,1,2],[1.25,2,1]] as const){
   await evaluate(`document.documentElement.style.zoom='${zoom}'`,variedContext);
   const geometry=await evaluate(`(()=>{const f=document.querySelector('[data-page="${from}"] [data-editor-field]'),r=f.getBoundingClientRect(),p=document.querySelector('[data-page="${to}"]').getBoundingClientRect();return {x:r.left+r.width*.3,y:r.top+r.height*.5,targetX:p.left+p.width*.55,targetY:p.top+p.height*.5}})()`,variedContext);
   const outer=await evaluate("(()=>{const f=document.querySelector('iframe'),r=f.getBoundingClientRect();return {x:r.left+f.clientLeft,y:r.top+f.clientTop}})()");
   const sx=outer.x+geometry.x,sy=outer.y+geometry.y,dx=outer.x+geometry.targetX,dy=outer.y+geometry.targetY;
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:sx,y:sy});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:sx,y:sy,button:'left',buttons:1,clickCount:1});
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:sx+10,y:sy+2,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dx,y:dy,button:'left',buttons:1});await sleep(100);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:dx+1,y:dy+1,button:'left',buttons:1});await sleep(100);await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:dx+1,y:dy,button:'left',buttons:0,clickCount:1});
   await wait(()=>evaluate(`Boolean(document.querySelector('[data-page="${to}"] [data-editor-field]'))`,variedContext),`real drag to page ${to} at zoom ${zoom}`);
   const actual=await evaluate(`(()=>{const f=document.querySelector('[data-page="${to}"] [data-editor-field]'),r=f.getBoundingClientRect(),p=f.closest('[data-page]').getBoundingClientRect(),c=f.closest('[data-page]').querySelector('canvas'),events=window.dragTrace.splice(0);return {events,x:(r.left-p.left)/p.width*Number(c.dataset.pdfWidth),y:(r.top-p.top)/p.height*Number(c.dataset.pdfHeight),width:r.width/p.width*Number(c.dataset.pdfWidth),height:r.height/p.height*Number(c.dataset.pdfHeight)};})()`,variedContext);
   const pageAlignment=await evaluate(`(()=>{const p=document.querySelector('[data-page="${to}"]'),c=p.querySelector('canvas'),a=p.getBoundingClientRect(),b=c.getBoundingClientRect();return {page:[a.left,a.top,a.width,a.height],canvas:[b.left,b.top,b.width,b.height]};})()`,variedContext);assert.ok(pageAlignment.page.every((v:number,i:number)=>Math.abs(v-pageAlignment.canvas[i])<0.1),`canvas and editor page mismatch: ${JSON.stringify(pageAlignment)}`);
   const start=actual.events.find((e:any)=>e.name==='dragstart'),drop=actual.events.find((e:any)=>e.name==='drop');assert.ok(start&&drop,`native dragstart and drop must fire: ${JSON.stringify(actual.events)}`);assert.equal(start.page,from);assert.equal(drop.page,to);assert.notEqual(start.pdfWidth,drop.pdfWidth);
   const grabX=(start.x-start.fieldLeft)/start.pageWidth*start.pdfWidth,grabY=(start.y-start.fieldTop)/start.pageHeight*start.pdfHeight;
   const expectedX=(drop.x-drop.pageLeft)/drop.pageWidth*drop.pdfWidth-grabX,expectedY=(drop.y-drop.pageTop)/drop.pageHeight*drop.pdfHeight-grabY;
   assert.ok(Math.abs(actual.width-150)<.2&&Math.abs(actual.height-34)<.2,`physical box at ${zoom}: ${JSON.stringify(actual)}`);
   assert.ok(Math.abs(actual.x-expectedX)<1&&Math.abs(actual.y-expectedY)<1,`grab and PDF anchor at ${zoom}: ${JSON.stringify({actual,expectedX,expectedY,grabX,grabY})}`);lastAnchor={x:actual.x,y:actual.y};
  }
  await evaluate("document.documentElement.style.zoom=''",variedContext);
  // Place the remaining role and date fields with actual pointer drags.
  for(const [role,type,x,y] of [['Partner','Date signed',.48,.63],['Seller','Signature',.16,.50],['Seller','Date signed',.16,.63]] as const){
   await evaluate(`(()=>{[...document.querySelectorAll('input[type=radio]')].find(x=>x.value==='${role}').click();document.querySelector('[aria-label="Add ${type} field"]').click();})()`,variedContext);
   const g=await evaluate(`(()=>{const field=[...document.querySelectorAll('[data-editor-field]')].at(-1),f=field.getBoundingClientRect(),p=document.querySelector('[data-page="1"]').getBoundingClientRect();return {id:field.dataset.editorField,sx:f.left+f.width*.3,sy:f.top+f.height*.5,dx:p.left+p.width*${x},dy:p.top+p.height*${y}};})()`,variedContext);
   const o=await evaluate("(()=>{const f=document.querySelector('iframe'),r=f.getBoundingClientRect();return {x:r.left+f.clientLeft,y:r.top+f.clientTop}})()");
   await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:o.x+g.sx,y:o.y+g.sy});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:o.x+g.sx,y:o.y+g.sy,button:'left',buttons:1,clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:o.x+g.sx+10,y:o.y+g.sy+2,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:o.x+g.dx,y:o.y+g.dy,button:'left',buttons:1});await sleep(100);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:o.x+g.dx+1,y:o.y+g.dy+1,button:'left',buttons:1});await sleep(100);await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:o.x+g.dx,y:o.y+g.dy,button:'left',buttons:0,clickCount:1});
   const moved=await wait(()=>evaluate(`(()=>{const f=document.querySelector('[data-editor-field="${g.id}"]'),r=f.getBoundingClientRect(),p=f.closest('[data-page]').getBoundingClientRect();return (r.top-p.top)/p.height>.4?{x:(r.left-p.left)/p.width,y:(r.top-p.top)/p.height}:null;})()`,variedContext),`native ${role} ${type} drop`);assert.ok(Math.abs(moved.y-(y-.5*34/800.63))<.01,`drop retained grab offset: ${JSON.stringify(moved)}`);
  }
  const boxes=await evaluate("[...document.querySelectorAll('[data-editor-field]')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})",variedContext);assert.equal(boxes.length,4);for(let a=0;a<boxes.length;a++)for(let b=a+1;b<boxes.length;b++)assert.ok(!(boxes[a].left<boxes[b].right&&boxes[b].left<boxes[a].right&&boxes[a].top<boxes[b].bottom&&boxes[b].top<boxes[a].bottom),`fields must not overlap: ${JSON.stringify(boxes)}`);
  await wait(()=>evaluate("!document.querySelector('#continue').disabled"),'varied host ready');await evaluate("document.querySelector('#continue').click()");
  const variedId=await wait(async()=>{const v=await evaluate("document.querySelector('#status').textContent.match(/Saved template: ([a-f0-9-]+)/)?.[1]");return v&&v!==legacyVersion?v:null;},'varied template saved');
  const savedVaried=await db.prepare('SELECT fields_json FROM templates WHERE id=?').bind(variedId).first<{fields_json:string}>();assert.ok(savedVaried);const placed=JSON.parse(savedVaried.fields_json)[0];assert.equal(placed.page,1);
  const pdfGeometry=signatureGeometry(varied.getPage(placed.page-1),placed,await renderTypedSignature('H'));assert.ok(lastAnchor);assert.ok(Math.abs(pdfGeometry.x-lastAnchor.x)<.2&&Math.abs(pdfGeometry.y-lastAnchor.y)<.2,'persisted PDF drawing anchor matches real dropped field');assert.ok(Math.abs(placed.rect.width*600.37-150)<.01&&Math.abs(placed.rect.height*800.63-34)<.01,'persisted PDF box retains physical point dimensions');
  await evaluate(`document.querySelector('#file').value='';document.querySelector('#source').value=${JSON.stringify(variedId)};document.querySelector('#open').click()`);
  const reopenedVaried=await wait(async()=>{const c=await frameContext();return c&&c!==variedContext?c:0;},'reopen varied template');
  await wait(()=>evaluate("Boolean(document.querySelector('[data-page=\"1\"] [data-editor-field]'))",reopenedVaried),'reopened varied field');
  const visualEvidence=await evaluate(`(()=>{const page=document.querySelector('[data-page="1"]'),c=page.querySelector('canvas'),box=page.querySelector('[data-editor-field]').getBoundingClientRect(),r=c.getBoundingClientRect(),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let bottom=-1,left=0,right=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const k=(y*c.width+x)*4;if(data[k]<100&&data[k+1]<100&&data[k+2]<100){bottom=Math.max(bottom,y);if(x<c.width/2)left++;else right++;}}return {bottom:bottom/c.height*Number(c.dataset.pdfHeight),fieldTop:(box.top-r.top)/r.height*Number(c.dataset.pdfHeight),left,right,fieldX:(box.left-r.left)/r.width*Number(c.dataset.pdfWidth)};})()`,reopenedVaried);
  console.log('synthetic reopened placement evidence',JSON.stringify(visualEvidence));
  assert.ok(visualEvidence.left>20&&visualEvidence.right>20,`both original text columns have visible ink: ${JSON.stringify(visualEvidence)}`);
  assert.ok(visualEvidence.bottom<visualEvidence.fieldTop,`reopened box stays below original ink: ${JSON.stringify(visualEvidence)}`);
  assert.ok(Math.abs(visualEvidence.fieldX-placed.rect.x*600.37)<.2&&Math.abs(visualEvidence.fieldTop-placed.rect.y*800.63)<.2,`reopened field matches saved points: ${JSON.stringify(visualEvidence)}`);
  // The very same saved template is used to create the envelope; do not seed
  // fields directly in D1, which would bypass the editor save path.
  const req=(path:string,init:RequestInit={})=>signingApp.fetch(new Request('http://127.0.0.1:8787'+path,init),env);
  const auth={authorization:`Bearer ${key}`},post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const create=await req('/api/envelopes',post({templateId:variedId,recipients:[{role:'Partner',name:'Ana',email:'ana@example.com'},{role:'Seller',name:'Marcus',email:'marcus@example.com'}]},{...auth,'idempotency-key':'editor-pixel-chain'}));assert.equal(create.status,201,await create.clone().text());const envelope=await create.json();
  assert.equal((await req(`/api/envelopes/${envelope.id}/prepare`,{method:'POST',headers:auth})).status,204);
  const info=await (await req(`/api/envelopes/${envelope.id}`,{headers:auth})).json();assert.equal(info.templateId,variedId,'envelope must use the exact saved template');
  const savedFields=JSON.parse(savedVaried.fields_json) as {id:string;role:string;type:string;rect:{x:number;y:number;width:number;height:number}}[];assert.equal(savedFields.length,4);
  // Editing and saving a second version must not retarget an existing envelope.
  await evaluate(`document.querySelector('[data-editor-field="${placed.id}"] button').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`,reopenedVaried);
  const oldBeforeSave=await db.prepare('SELECT fields_json FROM templates WHERE id=?').bind(variedId).first<{fields_json:string}>();assert.equal(oldBeforeSave?.fields_json,savedVaried.fields_json,'unsaved edits do not change the template');
  await wait(()=>evaluate("!document.querySelector('#continue').disabled"),'reopened varied host ready');await evaluate("document.querySelector('#continue').click()");
  const nextVersion=await wait(async()=>{const v=await evaluate("document.querySelector('#status').textContent.match(/Saved template: ([a-f0-9-]+)/)?.[1]");return v&&v!==variedId?v:null;},'new template version');
  const newer=await db.prepare('SELECT fields_json FROM templates WHERE id=?').bind(nextVersion).first<{fields_json:string}>();assert.ok(newer);assert.notEqual(newer.fields_json,savedVaried.fields_json);assert.equal((await (await req(`/api/envelopes/${envelope.id}`,{headers:auth})).json()).templateId,variedId,'existing envelope remains on original template after a new save');
  const created=await app.fetch(new Request('http://127.0.0.1:8787/api/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'http://127.0.0.1:5173'})}),env);const link=(await created.json() as any).url;
  const attack=await(await fetch(`http://127.0.0.1:${debug}/json/new?http://127.0.0.1:5174/`,{method:'PUT'})).json() as any;
  const attackWs=new WebSocket(attack.webSocketDebuggerUrl);await new Promise<void>(r=>attackWs.onopen=()=>r());let answer=0;const before=records.filter(r=>r.path==='/api/public/editor/exchange').length;
  attackWs.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`document.body.innerHTML='<iframe src="${link}"></iframe>'`}}));attackWs.onmessage=()=>{answer++;};await sleep(2000);attackWs.close();assert.ok(answer);assert.equal(records.filter(r=>r.path==='/api/public/editor/exchange').length,before,'CSP blocks hostile parent before exchange');

  const observed:Record<string,{zoom:number;left:number;top:number;right:number;bottom:number;count:number}[]>={};
  // A separate recipient tab mirrors the host opening a signer link.
  const recipientTarget=await(await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`,{method:'PUT'})).json() as {webSocketDebuggerUrl:string};ws.close();ws=new WebSocket(recipientTarget.webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws!.onopen=()=>r();ws!.onerror=()=>j(new Error('recipient CDP'));});ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1600,deviceScaleFactor:1,mobile:false});

  for(const [i,role] of ['Partner','Seller'].entries()){
   // Sign on the Worker's own signing page, as a host embeds it: <Worker origin>/sign#code=<code>.
   const view=await (await req(`/api/envelopes/${envelope.id}/tasks/${info.tasks[i].id}/recipient-view`,post({origin:'http://127.0.0.1:8787'},auth))).json();
   // A new code differs only in the fragment, which would not reload the page: start from a blank page.
   await call('Page.navigate',{url:'about:blank'});await call('Page.navigate',{url:`http://127.0.0.1:8787/sign#code=${view.code}`});await wait(()=>evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue')"),'signing session');
   await wait(()=>evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue'&&!b.disabled)"),'document reviewed');await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Continue').click()");
   const otp=await wait(()=>evaluate("document.body.innerText.match(/Local test verification code: (\\d{6})/)?.[1]"),'synthetic OTP');
   await evaluate(`(()=>{const x=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,${JSON.stringify(otp)});x.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('button')].find(b=>b.textContent==='Verify code').click();})()`);
   await wait(()=>evaluate(`Boolean(document.querySelector('input[aria-label="Full name"]'))`),'signing fields');
   await evaluate(`(()=>{const x=document.querySelector('input[aria-label="Full name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,${JSON.stringify(i?'Marcus':'Ana')});x.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   // Sign hides the document (it was read on Review); show it again, full width above the step, to check the previews on it.
   await evaluate("(()=>{if(document.querySelector('#show-document'))return;const s=document.createElement('style');s.id='show-document';s.textContent='.esign-at-step-3 .esign-document{display:flex!important;grid-column:1/-1;grid-row:1}';document.head.appendChild(s);})()");
   await wait(()=>evaluate("document.querySelectorAll('[data-signature-field] img').length===2"),'signature and date previews');
   for(const zoom of [.8,1.25]){
    await evaluate(`document.documentElement.style.zoom='${zoom}'`);
    for(const field of savedFields.filter(f=>f.role===role)){
     await evaluate(`document.querySelector('[data-signature-field="${field.id}"]').scrollIntoView({block:'center',inline:'center'})`);await sleep(80);
     const shot=(await call('Page.captureScreenshot',{format:'png'})).data;
     const ink=await evaluate(`(async()=>{const f=document.querySelector('[data-signature-field="${field.id}"]'),p=f.closest('[data-signature-page]'),canvas=p.querySelector('canvas'),r=canvas.getBoundingClientRect(),b=f.getBoundingClientRect(),image=new Image();image.src='data:image/png;base64,'+${JSON.stringify(shot)};await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let left=Infinity,top=Infinity,right=-1,bottom=-1,count=0;for(let y=Math.ceil(b.top+3);y<Math.floor(b.bottom-3);y++)for(let x=Math.ceil(b.left+3);x<Math.floor(b.right-3);x++){const k=(y*c.width+x)*4;if(d[k]<100&&d[k+1]<100&&d[k+2]<100){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}}return {zoom:${zoom},count,left:(left-r.left)/r.width*600.37,right:(right-r.left)/r.width*600.37,top:(top-r.top)/r.height*800.63,bottom:(bottom-r.top)/r.height*800.63};})()`);
     assert.ok(ink.count>8,`${role} ${field.type} must show real screenshot ink: ${JSON.stringify(ink)}`);assert.ok(ink.top>visualEvidence.bottom,`${role} ${field.type} must not cover original ink: ${JSON.stringify(ink)}`);(observed[field.id]??=[]).push(ink);
    }
   }
   await evaluate("document.documentElement.style.zoom='';document.querySelector('input[type=checkbox]').click()");await wait(()=>evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Sign document'&&!b.disabled)"),'sign ready');await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Sign document').click()");await wait(()=>evaluate("document.body.innerText.includes('Signature recorded.')"),'signature recorded');assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'tenant',envelope.id,true),'processed');
  }
  assert.equal(await finalizeEnvelopeStep(env,'tenant',envelope.id),'finalized');const finalBytes=new Uint8Array(await signedPdf(env.DB,env.ARTIFACTS,envelope.id));
  // Render both PDFs with the page's own renderer, loaded from the UI source on the Vite origin, from a blank page of
  // the proxy's (Vite's own 404 page has a CSP of default-src 'none', which would refuse the import).
  await call('Page.navigate',{url:'http://127.0.0.1:5175/'});await wait(()=>evaluate("document.readyState==='complete'"),'renderer origin');
  const renderAsset='pdf.ts';
  const metrics=await evaluate(`(async()=>{const {renderPdf}=await import('/${renderAsset}'),decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)),make=async b=>{const d=document.createElement('div');await renderPdf(new Blob([decode(b)],{type:'application/pdf'}),d,new AbortController().signal);return d.querySelector('canvas');},a=await make(${JSON.stringify(varied64)}),b=await make(${JSON.stringify(Buffer.from(finalBytes).toString('base64'))}),base=a.getContext('2d',{willReadFrequently:true}).getImageData(0,0,a.width,a.height).data,out=b.getContext('2d',{willReadFrequently:true}).getImageData(0,0,b.width,b.height).data,fields=${JSON.stringify(savedFields)};let originalChanged=0;for(let y=0;y<${visualEvidence.bottom}/800.63*a.height+2;y++)for(let x=0;x<a.width;x++){const k=(y*a.width+x)*4;if(base[k]<150&&base[k+1]<150&&base[k+2]<150&&Math.max(Math.abs(base[k]-out[k]),Math.abs(base[k+1]-out[k+1]),Math.abs(base[k+2]-out[k+2]))>40)originalChanged++;}const metrics=fields.map(f=>{const r=f.rect;let left=Infinity,top=Infinity,right=-1,bottom=-1,count=0;for(let y=Math.floor(r.y*a.height);y<Math.ceil((r.y+r.height)*a.height);y++)for(let x=Math.floor(r.x*a.width);x<Math.ceil((r.x+r.width)*a.width);x++){const k=(y*a.width+x)*4;if(Math.max(Math.abs(base[k]-out[k]),Math.abs(base[k+1]-out[k+1]),Math.abs(base[k+2]-out[k+2]))>40&&out[k]<120&&out[k+1]<120&&out[k+2]<120){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}}return {id:f.id,count,left:left/a.width*600.37,right:right/a.width*600.37,top:top/a.height*800.63,bottom:bottom/a.height*800.63};});return {metrics,originalChanged};})()`);
  assert.equal(metrics.originalChanged,0,'final PDF must not alter visible original text ink');for(const m of metrics.metrics){assert.ok(m.count>8&&m.top>visualEvidence.bottom,`final PDF ink below original: ${JSON.stringify(m)}`);for(const p of observed[m.id])for(const side of ['left','top','right','bottom'] as const)assert.ok(Math.abs(m[side]-p[side])<4,`preview and final PDF visible ${side}: ${JSON.stringify({m,p})}`);}
  console.log('synthetic end-to-end ink evidence',JSON.stringify(metrics.metrics));
 }finally{releaseBefore();releaseSave();ws?.close();if(browser){browser.kill('SIGTERM');await Promise.race([once(browser,'exit'),sleep(3000)]).catch(()=>{});}if(proxy)await new Promise<void>(r=>proxy!.close(()=>r()));await vite.close();await mf.dispose();// Chrome can still be writing its profile as it exits; retry removing it.
  await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
