import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createBridge, allowedRequest} from '../scripts/local-browser-smoke.mjs';

test('bridge forwards only exact permitted GET paths and returns favicon locally',async()=>{
 const received:string[]=[];
 const bridge=createBridge(new Set(['/candidate.html','/assets/app.js']),async (path:string)=>{received.push(path);return new Response('synthetic');});
 bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
 const origin=`http://127.0.0.1:${(bridge.address() as any).port}`;
 try {
  assert.equal((await fetch(origin+'/candidate.html')).status,200);
  assert.equal((await fetch(origin+'/favicon.ico')).status,404);
  for(const [path,method] of [['/v1/test','GET'],['/assets/app.js?secret=x','GET'],['/candidate.html','POST'],['/assets/other.js','GET']]) assert.equal((await fetch(origin+path,{method})).status,403);
  assert.deepEqual(received,['/candidate.html']);
  assert.equal(allowedRequest(origin, new Set(['/candidate.html']), 'GET',origin+'/candidate.html'),true);
  for(const url of [origin+'/candidate.html?x=1',origin+'/v1/test','http://example.test/candidate.html']) assert.equal(allowedRequest(origin,new Set(['/candidate.html']),'GET',url),false);
  assert.equal(allowedRequest(origin,new Set(['/candidate.html']),'POST',origin+'/candidate.html'),false);
 } finally {await new Promise<void>(r=>bridge.close(()=>r()));}
});

test('page-target interception blocks an unexpected API fetch before the bridge receives it',{timeout:30000},async()=>{
 const {checkBrowser}=await import('../scripts/local-browser-smoke.mjs');
 const {existsSync}=await import('node:fs');
 const chrome=process.env.ESIGN_TEST_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
 assert.ok(chrome,'Chrome required for interception test');
 const received:string[]=[];
 const paths=new Set(['/candidate.html','/candidate-editor.html']);
 const server=createServer((req,res)=>{received.push(req.url!);res.setHeader('content-type','text/html');res.end('<div id="root">No valid recipient code provided. Request a new view.</div>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try {await assert.rejects(checkBrowser(`http://127.0.0.1:${(server.address() as any).port}`,paths,chrome,true),/unexpected observed request/);assert.ok(received.includes('/candidate.html'));assert.ok(!received.includes('/v1/refused'));}
 finally {await new Promise<void>(r=>server.close(()=>r()));}
});

test('synthetic staged manifest renders both pages and cleans up Chrome',{timeout:30000},async()=>{
 const {runSmoke}=await import('../scripts/local-browser-smoke.mjs');
 const {existsSync}=await import('node:fs');
 const {mkdtemp,mkdir,writeFile,readFile,realpath,rm}=await import('node:fs/promises');
 const {join}=await import('node:path');
 const {tmpdir}=await import('node:os');
 const {createHash}=await import('node:crypto');
 const chrome=process.env.ESIGN_TEST_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
 assert.ok(chrome,'Chrome required for smoke test');
 const dir=await mkdtemp(join(await realpath(tmpdir()),'esign-smoke-fixture-'));
 try {
  await mkdir(join(dir,'build/client/assets'),{recursive:true});
  const files:Record<string,string>={
   'wrangler.json':JSON.stringify({compatibility_date:'2026-01-01',vars:{RECIPIENT_GATEWAY_ORIGIN:'https://page.example.test',EDITOR_GATEWAY_ORIGIN:'https://page.example.test'}}),
   'build/worker.mjs':'export default {};',
   'build/consolidated-worker.mjs':'export default {fetch(request,env){return env.ASSETS.fetch(request)}};',
   'build/client/candidate.html':'<div id="root"></div><script src="/assets/recipient.js"></script>',
   'build/client/candidate-editor.html':'<div id="root"></div><script src="/assets/editor.js"></script>',
   'build/client/assets/recipient.js':"document.querySelector('#root').innerText='No valid recipient code provided. Request a new view.';",
   'build/client/assets/editor.js':"document.querySelector('#root').innerText='Editor session unavailable. Ask the host to open a new session.';",
  };
  for(const [path,content] of Object.entries(files)) await writeFile(join(dir,path),content);
  await writeFile(join(dir,'SHA256.txt'),Object.entries(files).map(([path,content])=>`${createHash('sha256').update(content).digest('hex')}  ${path}`).join('\n')+'\n');
  const wrapper=join(dir,'chrome-wrapper');
  const quote=(s:string)=>`'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper,`#!/bin/sh\necho $$ > ${quote(join(dir,'pid'))}\nfor arg in "$@"; do case "$arg" in --user-data-dir=*) echo "${'$'}{arg#--user-data-dir=}" > ${quote(join(dir,'profile'))};; esac; done\nexec ${quote(chrome)} "$@"\n`,{mode:0o700});
  await runSmoke(dir,wrapper);
  const pid=Number(await readFile(join(dir,'pid'),'utf8'));
  const profile=(await readFile(join(dir,'profile'),'utf8')).trim();
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(existsSync(profile),false);
  await writeFile(join(dir,'build/client/assets/editor.js'),'tampered');
  await assert.rejects(runSmoke(dir,wrapper),/staged manifest mismatch/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('browser termination handles synchronous signal exit without a second kill or missed exit',async()=>{
 const {terminateBrowser}=await import('../scripts/local-browser-smoke.mjs');
 const {EventEmitter}=await import('node:events');
 class Browser extends EventEmitter {
  pid=123;exitCode:number|null=null;signalCode:string|null=null; signals:string[]=[];
  kill(signal:string){this.signals.push(signal);this.signalCode=signal;this.emit('exit',null,signal);return true;}
 }
 const browser=new Browser();
 await Promise.race([terminateBrowser(browser),new Promise((_,reject)=>setTimeout(()=>reject(Error('missed exit')),500))]);
 assert.deepEqual(browser.signals,['SIGTERM']);
 await terminateBrowser(browser);
 assert.deepEqual(browser.signals,['SIGTERM']);
});
