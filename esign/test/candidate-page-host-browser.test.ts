import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
const chrome=process.env.ESIGN_TEST_CHROME??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('candidate page host enforces browser isolation on both standalone pages',{skip:!chrome,timeout:60000},async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'candidate-host-'));let browser:ReturnType<typeof spawn>|undefined;let ws:WebSocket|undefined;
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const tls={key:await readFile(join(dir,'key')),cert:await readFile(join(dir,'cert'))};let worker:any,env:any,origin='',fakeAsset:'oversized'|'mismatched'|undefined;
 const pages=createServer(tls,async(req,res)=>{try{const response=await worker.fetch(new Request(origin+req.url),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500).end();}});
 const gateway=createServer(tls,(req,res)=>{if(req.url?.startsWith('/embed')){const path=new URL(req.url,'https://example.test').searchParams.get('path');res.writeHead(200,{'content-type':'text/html'}).end(`<iframe src="${origin}${path}"></iframe>`);}else res.writeHead(503,{'access-control-allow-origin':origin}).end();});
 try {
  pages.listen(0,'127.0.0.1');gateway.listen(0,'127.0.0.1');await Promise.all([once(pages,'listening'),once(gateway,'listening')]);origin=`https://127.0.0.1:${(pages.address() as any).port}`;const gatewayOrigin=`https://127.0.0.1:${(gateway.address() as any).port}`;
  const build=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',join(dir,'build')],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:gatewayOrigin,VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:gatewayOrigin}});assert.equal(build.status,0,build.stderr);
  worker=(await import(`file://${join(dir,'build/worker.mjs')}`)).default;
  env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:gatewayOrigin,EDITOR_GATEWAY_ORIGIN:gatewayOrigin,ASSETS:{fetch:async(req:Request)=>{try{const bytes=await readFile(join(dir,'build/client',new URL(req.url).pathname));if(fakeAsset==='oversized')return new Response(Buffer.concat([bytes,Buffer.from('extra')]));if(fakeAsset==='mismatched')return new Response(Buffer.alloc(bytes.length));return new Response(bytes);}catch{return new Response(null,{status:404});}}}};
  browser=spawn(chrome!,['--headless=new','--no-sandbox','--disable-gpu','--ignore-certificate-errors','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${dir}/chrome`,'about:blank'],{stdio:'ignore'});
  let port='';for(let i=0;i<200;i++){try{port=(await readFile(join(dir,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await sleep(50);}}assert.ok(port);
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json() as any;ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws!.onopen=()=>r();ws!.onerror=()=>j(Error('CDP'));});let seq=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();const requests:string[]=[];ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);if(m.id&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression:string)=>(await call('Runtime.evaluate',{expression,returnByValue:true})).result.value;
  await call('Network.enable');await call('Page.enable');
  for(const [path,fragment] of [['/candidate.html',`code=${'a'.repeat(64)}`],['/candidate-editor.html',`pageId=${'b'.repeat(64)}&code=${'c'.repeat(64)}`]]){
   requests.length=0;await call('Page.navigate',{url:origin+path+'#'+fragment});let ready=false;for(let i=0;i<100;i++){await sleep(50);if(await evaluate(`location.pathname===${JSON.stringify(path)} && location.hash==='' && document.body.innerText.includes('unavailable')`)){ready=true;break;}}assert.ok(ready,`fragment removal and page execution: ${path}`);
   assert.equal(await evaluate('location.href'),origin+path);
   assert.ok(requests.some(u=>u.startsWith(gatewayOrigin+'/v1/')),`gateway request: ${requests}`);
   for(const u of requests)assert.ok([origin,gatewayOrigin].includes(new URL(u).origin),`unexpected request ${u}`);
   await call('Page.navigate',{url:gatewayOrigin+'/embed?path='+encodeURIComponent(path)});await sleep(500);const tree=await call('Page.getFrameTree');assert.ok(tree.frameTree.childFrames?.length);assert.match(tree.frameTree.childFrames[0].frame.url,/^chrome-error:/,JSON.stringify(tree));
  }
  for(const fake of ['oversized','mismatched'] as const){fakeAsset=fake;await call('Page.navigate',{url:origin+'/candidate.html'});let rejected=false;for(let i=0;i<100;i++){await sleep(50);if(await evaluate("document.body.innerText==='Unavailable'")){rejected=true;break;}}assert.ok(rejected,`browser rejects ${fake} fake asset`);}
  fakeAsset=undefined;
  for(const path of ['/','/index.html','/editor.html','/recipient.html','/demo.html'])assert.equal((await worker.fetch(new Request(origin+path),env)).status,404);
  const preview=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',join(dir,'preview')],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:gatewayOrigin,VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:gatewayOrigin,ESIGN_CANDIDATE_SYNTHETIC_PREVIEW:'YES'}});assert.equal(preview.status,0,preview.stderr);
  worker=(await import(`file://${join(dir,'preview/worker.mjs')}`)).default;
  env.ASSETS.fetch=async(req:Request)=>{try{return new Response(await readFile(join(dir,'preview/client',new URL(req.url).pathname)));}catch{return new Response(null,{status:404});}};
  for(const disabled of [true,false]) {
   await call('Emulation.setScriptExecutionDisabled',{value:disabled});
   for(const path of ['/candidate.html','/candidate-editor.html']) {
    await call('Page.navigate',{url:'about:blank'});requests.length=0;await call('Page.navigate',{url:origin+path+'#code='+ 'a'.repeat(64)});
    let ready=false;for(let i=0;i<100;i++){await sleep(50);if(await evaluate("document.body.innerText.includes('TEST ONLY')")){ready=true;break;}}
    assert.ok(ready,`${path}, scripts disabled: ${disabled}`);
    const text=await evaluate('document.body.innerText');assert.match(text,/services, verification email and signing are unavailable/i);assert.match(text,/do not enter or upload real data/i);assert.doesNotMatch(text,/new session/i);
    assert.ok(!requests.some(u=>u.startsWith(gatewayOrigin+'/v1/')),`unexpected startup request: ${requests}`);
   }
  }
  await call('Emulation.setScriptExecutionDisabled',{value:false});
 }finally{ws?.close();if(browser){browser.kill();await once(browser,'exit').catch(()=>{});}pages.close();gateway.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
