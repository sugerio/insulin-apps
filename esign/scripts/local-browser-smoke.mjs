import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Miniflare} from 'miniflare';
import {MockAgent} from 'undici';
import {stagedAssetPaths,validateStagedManifest,validateStagedPaths} from '../test/staged-artifact-manifest.ts';

export function allowedRequest(origin, paths, method, url) {
 return method === 'GET' && [...paths, '/favicon.ico'].some(path => url === origin + path);
}
export function createBridge(paths, dispatch) {
 return createServer(async (req,res) => {
  if (req.method !== 'GET' || !req.url || ![...paths,'/favicon.ico'].includes(req.url)) {res.writeHead(403).end();return;}
  if(req.url === '/favicon.ico') {res.writeHead(404).end();return;}
  try {const response=await dispatch(req.url);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
  catch {res.writeHead(500).end();}
 });
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function terminateBrowser(browser) {
 const running=()=>browser.pid && browser.exitCode===null && browser.signalCode===null;
 const stop=signal=>new Promise(resolve=>{
  if(!running()) {resolve();return;}
  const done=()=>{clearTimeout(timer);browser.removeListener('exit',done);resolve();};
  const timer=setTimeout(done,3000);
  browser.once('exit',done);
  browser.kill(signal);
 });
 if(running()) await stop('SIGTERM');
 if(running()) await stop('SIGKILL');
}
export async function checkBrowser(origin, paths, chrome, probe=false) {
 const dir=await mkdtemp(join(tmpdir(),'esign-smoke-'));
 let browser, ws;
 try {
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{stdio:'ignore',env:{PATH:process.env.PATH ?? '/usr/bin:/bin',HOME:dir,TMPDIR:dir,LANG:'en_US.UTF-8'}});
  let spawnFailure;browser.on('error',()=>{spawnFailure=Error('browser could not start');});
  let port;
  for(let i=0;i<200;i++) {try {port=(await readFile(join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0];break;} catch {if(spawnFailure)throw spawnFailure;if(browser.exitCode!==null || browser.signalCode!==null) throw Error('browser exited');await sleep(50);}}
  if(!port) throw Error('browser debugging unavailable');
  const target=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([once(ws,'open'),sleep(5000).then(()=>{throw Error('CDP connection timeout');})]);
  let seq=0, unexpected=false, failure;const pending=new Map();
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  ws.addEventListener('close',()=>{failure=Error('CDP disconnected');for(const p of pending.values()){clearTimeout(p.timer);p.reject(failure);}pending.clear();});
  ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('CDP command failed')):p.resolve(m.result);}
   if(m.method==='Fetch.requestPaused'){const r=m.params.request,ok=allowedRequest(origin,paths,r.method,r.url);if(!ok)unexpected=true;call(ok?'Fetch.continueRequest':'Fetch.failRequest',ok?{requestId:m.params.requestId}:{requestId:m.params.requestId,errorReason:'BlockedByClient'}).catch(e=>{failure=e;});}
  });
  await call('Page.enable');await call('Runtime.enable');await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('browser evaluation failed');return r.result.value;};
  for(const [page,marker] of [['/candidate.html','No valid recipient code provided. Request a new view.'],['/candidate-editor.html','Editor session unavailable. Ask the host to open a new session.']]) {
   const nav=await call('Page.navigate',{url:origin+page});if(nav.errorText)throw Error('navigation failed');
   let found=false;for(let i=0;i<200;i++){if(failure)throw failure;if(unexpected)throw Error('unexpected observed request');if(await evaluate(`document.querySelector('#root')?.innerText.includes(${JSON.stringify(marker)}) === true`)){found=true;break;}await sleep(50);}
   if(!found)throw Error(`missing expected marker: ${page}`);
   if(probe) await evaluate("fetch('/v1/refused').catch(()=>{})");
   await sleep(300);if(failure)throw failure;if(unexpected)throw Error('unexpected observed request');
  }
 } finally {
  ws?.close();
  if(browser) await terminateBrowser(browser);
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}
export async function runSmoke(stagedDir,chrome) {
 const root=resolve(stagedDir);await validateStagedPaths(root);
 const assets=await stagedAssetPaths(join(root,'build/client'));
 const pins=validateStagedManifest(await readFile(join(root,'SHA256.txt'),'utf8'),assets);
 for(const [path,hash] of pins) if(createHash('sha256').update(await readFile(join(root,path))).digest('hex')!==hash)throw Error('staged manifest mismatch');
 const config=JSON.parse(await readFile(join(root,'wrangler.json'),'utf8'));
 const workerOrigin=config.vars.RECIPIENT_GATEWAY_ORIGIN;
 if(!workerOrigin || config.vars.EDITOR_GATEWAY_ORIGIN!==workerOrigin)throw Error('staged host origins mismatch');
 const mockAgent=new MockAgent();mockAgent.disableNetConnect();
 const mf=new Miniflare({fetchMock:mockAgent,modules:true,script:await readFile(join(root,'build/consolidated-worker.mjs'),'utf8'),compatibilityDate:config.compatibility_date,assets:{directory:join(root,'build/client'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},bindings:{RECIPIENT_GATEWAY_ORIGIN:workerOrigin,EDITOR_GATEWAY_ORIGIN:workerOrigin,HOST_ENABLED:'true'}});
 const paths=new Set(assets.filter(p=>p==='candidate.html'||p==='candidate-editor.html'||p.startsWith('assets/')).map(p=>'/'+p));
 const server=createBridge(paths,path=>mf.dispatchFetch(workerOrigin+path));
 try {server.listen(0,'127.0.0.1');await once(server,'listening');await checkBrowser(`http://127.0.0.1:${server.address().port}`,paths,chrome);}
 finally {if(server.listening)await new Promise(r=>server.close(r));await mf.dispose();await mockAgent.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const chrome=process.env.ESIGN_TEST_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
 if(process.argv.length!==3||!chrome){console.error('Usage: node scripts/local-browser-smoke.mjs STAGED_DIR (Chrome required)');process.exitCode=1;}
 else runSmoke(process.argv[2],chrome).then(()=>console.log('Both local page markers rendered; page-target CDP is not browser-wide egress proof.')).catch(e=>{console.error('Local smoke failed:',e.message);process.exitCode=1;});
}
