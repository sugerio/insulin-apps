import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {PDFDocument} from 'pdf-lib';
import {createServer as createViteServer} from 'vite';
import {startLocalHost} from '../scripts/local-host.ts';

const chrome=process.env.ESIGN_TEST_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('Chrome uploads and signs through same-origin GETs without injecting Origin; no seal is sent', {skip:!chrome,timeout:120000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'esign-upload-browser-'));let instanceDir='';
 const log=console.log;console.log=(...args:unknown[])=>{const line=args.join(' ');if(line.startsWith('Uploaded instance (retain for restart): '))instanceDir=line.slice(line.indexOf(': ')+2);};
 process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_UPLOAD_SEAL='YES';delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;
 const backend=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(backend,'listening');
 const backendPort=(backend.address() as import('node:net').AddressInfo).port;
 const vite=await createViteServer({configFile:false,root:resolve('ui'),appType:'spa',server:{middlewareMode:true,hmr:false}});
 const observed:{method:string;path:string;origin:string|undefined;site:string|undefined;status?:number}[]=[];
 // A browser HTTP proxy routes the normal 5173 origin to test-owned servers, without occupying 5173 or changing browser headers.
 const proxy=createServer((req,res)=>{
  const url=new URL(req.url!,'http://127.0.0.1:5173');
  if(url.origin!=='http://127.0.0.1:5173'){res.writeHead(403).end();return;}
  req.url=url.pathname+url.search;
  if(!url.pathname.startsWith('/host/')){vite.middlewares(req,res);return;}
  const record={method:req.method!,path:url.pathname,origin:req.headers.origin,site:req.headers['sec-fetch-site'] as string|undefined,status:undefined as number|undefined};observed.push(record);
  const upstream=httpRequest({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${backendPort}`}},response=>{record.status=response.statusCode;res.writeHead(response.statusCode!,response.headers);response.pipe(res);});
  upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const proxyPort=(proxy.address() as import('node:net').AddressInfo).port;
 const browser=spawn(chrome!,['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${temp}/chrome`,`--proxy-server=http://127.0.0.1:${proxyPort}`,'--proxy-bypass-list=<-loopback>','about:blank'],{stdio:'ignore'});
 let ws:WebSocket|undefined;
 try {
  let debugPort='';for(let i=0;i<200;i++){try{debugPort=(await readFile(join(temp,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{if(browser.exitCode!==null)throw new Error('Chrome exited');await sleep(100);}}
  assert.ok(debugPort,'Chrome debugging port');
  const target=await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:5173/upload.html`,{method:'PUT'})).json() as {webSocketDebuggerUrl:string};
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('CDP connection failed'));});
  let seq=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  ws.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.id && pending.has(message.id)){const p=pending.get(message.id)!;pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);}};
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression:string)=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;};
  const wait=async(expression:string,label:string,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await evaluate(expression);if(value)return value;await sleep(100);}throw new Error(`Timed out: ${label}; ${await evaluate('document.body.innerText')}`);};
  const click=async(text:string,frame=false)=>evaluate(`(()=>{const d=${frame?'document.querySelector(\'iframe[title="Uploaded test recipient signing page"]\')?.contentDocument':'document'};const b=[...(d?.querySelectorAll('button')||[])].find(x=>x.textContent.trim()===${JSON.stringify(text)}&&!x.disabled);if(!b)return false;b.click();return true})()`);
  await wait("Boolean(document.querySelector('input[type=file]'))",'upload page');
  const pdf=await PDFDocument.create();pdf.addPage();const file=join(temp,'synthetic.pdf');await writeFile(file,await pdf.save());
  const document=await call('DOM.getDocument');const node=await call('DOM.querySelector',{nodeId:document.root.nodeId,selector:'input[type=file]'});await call('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Upload and create test envelope'&&!b.disabled)",'file selected');await click('Upload and create test envelope');
  await wait("document.querySelector('h2')?.innerText.startsWith('Envelope ')",'envelope after GET');
  for(let i=0;i<2;i++){
   await wait(`Boolean(document.querySelectorAll('li')[${i}]?.querySelector('button:not(:disabled)'))`,'recipient button');await evaluate(`document.querySelectorAll('li')[${i}].querySelector('button').click()`);
   const d="document.querySelector('iframe[title=\"Uploaded test recipient signing page\"]')?.contentDocument";
   await wait(`${d}?.body?.innerText.includes('Review every page, then continue.')`,'recipient session and document');await click('Continue',true);
   const otp=await wait(`${d}?.body?.innerText.match(/Local test verification code: (\\d{6})/)?.[1]`,'test OTP');
   await evaluate(`(()=>{const d=${d};const input=d.querySelector('input');Object.getOwnPropertyDescriptor(d.defaultView.HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(otp)});input.dispatchEvent(new d.defaultView.Event('input',{bubbles:true}));})()`);
   await click('Verify code',true);await wait(`[...(${d}?.querySelectorAll('button')||[])].some(b=>b.textContent==='Sign document')`,'PDF GET and render',60000);
   await evaluate(`${d}.querySelector('input[type=checkbox]').click()`);await click('Sign document',true);await wait(`${d}?.body?.innerText.includes('Signature recorded.')`,'signature');
   await click('Process signature');await wait("!document.querySelector('iframe[title=\"Uploaded test recipient signing page\"]')",'processing');
  }
  await wait("document.body.innerText.includes('Signing status: FINALIZING')",'signatures processed');
  await wait("document.body.innerText.includes('Real KMS/TSA local test status: NOT_SEALED')",'unsealed status');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Complete local KMS/TSA test')?.disabled"),true);
  assert.equal(observed.some(item=>item.path.endsWith('/complete') || item.path.endsWith('/seal')),false);
  const posts=observed.filter(item=>item.method==='POST');assert.ok(posts.length>0);
  assert.ok(posts.every(item=>item.origin==='http://127.0.0.1:5173' && item.site==='same-origin'),JSON.stringify(posts));
  for(const suffix of ['/v1/signing/current','/v1/signing/pdf']){
   const gets=observed.filter(item=>item.method==='GET' && item.path.endsWith(suffix));assert.equal(gets.length,2,`${suffix} GETs`);assert.ok(gets.every(item=>item.origin===undefined && item.site==='same-origin' && item.status===200),JSON.stringify(gets));
  }
  const management=observed.filter(item=>item.method==='GET' && /^\/host\/upload\/envelopes\/[a-f0-9-]+$/.test(item.path));
  assert.ok(management.length>0);assert.ok(management.every(item=>item.origin===undefined && item.site==='same-origin' && item.status===200),JSON.stringify(management));
 } finally {
  ws?.close();browser.kill('SIGTERM');await Promise.race([once(browser,'exit'),sleep(3000)]).catch(()=>{});
  await new Promise<void>(resolve=>proxy.close(()=>resolve()));await vite.close();await new Promise<void>(resolve=>backend.close(()=>resolve()));await sleep(300);
  console.log=log;if(instanceDir)await rm(instanceDir,{recursive:true,force:true});await rm(temp,{recursive:true,force:true});delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_UPLOAD_SEAL;
 }
});
