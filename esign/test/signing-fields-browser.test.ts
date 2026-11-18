import {blobStore} from './helpers/platform.ts';
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {createServer as createViteServer} from 'vite';
import {Miniflare} from 'miniflare';
import {PDFDocument,rgb} from 'pdf-lib';
import app from './helpers/gateway.ts';
import {renderTypedSignature} from '../src/app/server/esign/field-render.ts';
import {withLocalTestOtp} from './helpers/local-otp-display.ts';
import {processEnvelopeStep,finalizeEnvelopeStep} from '../src/app/server/esign/envelope-completion.ts';
import {signedPdf} from './helpers/signed-pdf.ts';
const chrome=process.env.ESIGN_TEST_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

type PdfImageBounds={x:number;y:number;width:number;height:number;pixelWidth:number;pixelHeight:number};
const sha256=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const close=(actual:number,expected:number,tolerance:number,label:string)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} vs ${expected}`);
/** Resolve PDF graphics-state transforms, not content-stream syntax or browser overlay CSS. */
async function imageBounds(bytes:Uint8Array):Promise<PdfImageBounds[][]>{
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const document=await pdfjs.getDocument({data:Uint8Array.from(bytes)}).promise;
 const result:PdfImageBounds[][]=[];
 try{assert.equal(document.numPages,2,'exactly two PDF pages');for(let pageIndex=1;pageIndex<=document.numPages;pageIndex++){
  const page=await document.getPage(pageIndex),ops=await page.getOperatorList();const expectedView=pageIndex===1?[0,0,400.2,500.1]:[0,0,200.1,100.1];for(let i=0;i<4;i++)close(page.view[i],expectedView[i],1e-7,`PDF page ${pageIndex} boundary`);let matrix=[1,0,0,1,0,0];const stack:number[][]=[],images:PdfImageBounds[]=[];
  for(let index=0;index<ops.fnArray.length;index++){
   const fn=ops.fnArray[index],args=ops.argsArray[index] as number[]|null;
   if(fn===pdfjs.OPS.save)stack.push([...matrix]);
   else if(fn===pdfjs.OPS.restore){const previous=stack.pop();assert.ok(previous,'balanced PDF graphics state');matrix=previous;}
   else if(fn===pdfjs.OPS.transform){assert.ok(args&&args.length===6);const [a,b,c,d,e,f]=matrix,[g,h,i,j,k,l]=args;matrix=[a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f];}
   else if(fn===pdfjs.OPS.clip||fn===pdfjs.OPS.eoClip)assert.fail('Unexpected explicit PDF clipping path');
   else if(fn===pdfjs.OPS.paintImageXObject){assert.ok(args&&args.length>=3);close(matrix[1],0,1e-8,'image rotation');close(matrix[2],0,1e-8,'image rotation');assert.ok(matrix[0]>0&&matrix[3]>0);images.push({x:matrix[4],y:matrix[5],width:matrix[0],height:matrix[3],pixelWidth:Number(args[1]),pixelHeight:Number(args[2])});}
  }
  assert.equal(stack.length,0,'balanced PDF graphics state');result.push(images);
 }}finally{await document.destroy();}return result;
}

test('Chrome completes two typed positioned signatures using server previews',{skip:!chrome,timeout:120000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'esign-positioned-browser-'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
 const secret='test-key-0123456789-abcdefghijklmnopqrstuvwxyz',digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))),n=>n.toString(16).padStart(2,'0')).join('');
 await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(digest).run();
 const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),TEST_MAIL:await blobStore(mf,'test-mail'),SIGNING_PAGE_ORIGINS:'http://127.0.0.1:5173',OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
 const req=(path:string,init:RequestInit={})=>app.fetch(new Request('http://127.0.0.1:8787'+path,init),env);const mgmt={authorization:`Bearer ${secret}`};const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 const pdf=await PDFDocument.create();pdf.addPage([400.2,500.1]);pdf.addPage([200.1,100.1]).drawRectangle({x:199.2,y:0,width:.9,height:100.1,color:rgb(1,0,0),borderWidth:0});const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf'));form.set('roles','["ana","marcus"]');const template=await (await req('/api/templates',{method:'POST',headers:mgmt,body:form})).json();
 const fields=[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:0,y:0,width:.05,height:.1}},{id:'a2',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.9,width:.4,height:.1}},{id:'a3',type:'Signature',role:'ana',page:2,required:true,rect:{x:.001,y:.002,width:.998,height:.995}},{id:'b',type:'Signature',role:'marcus',page:1,required:true,rect:{x:.7,y:.9,width:.3,height:.1}}];await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
 const created=await req('/api/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...mgmt,'idempotency-key':'browser'}));assert.equal(created.status,201);const envelope=await created.json();assert.equal((await req(`/api/envelopes/${envelope.id}/prepare`,{method:'POST',headers:mgmt})).status,204);const tasks=(await (await req(`/api/envelopes/${envelope.id}`,{headers:mgmt})).json()).tasks;
 const vite=await createViteServer({configFile:false,root:resolve('.'),appType:'spa',server:{middlewareMode:true,hmr:false}});
 const proxy=createServer(async(req,res)=>{try{const url=new URL(req.url!);if(url.origin==='http://127.0.0.1:5173'&&!url.pathname.startsWith('/api/')){req.url=url.pathname+url.search;vite.middlewares(req,res);return;}if(url.origin!=='http://127.0.0.1:8787'&&url.origin!=='http://127.0.0.1:5173'){res.writeHead(403).end();return;}const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const body=Buffer.concat(parts);let response=await app.fetch(new Request(url,{method:req.method,headers:req.headers as HeadersInit,...(body.length?{body}: {})}),env);if(req.method==='POST'&&url.pathname==='/api/public/signing/otp')response=await withLocalTestOtp(response,env.TEST_MAIL);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500).end();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const port=(proxy.address() as import('node:net').AddressInfo).port;
 // A fixed window, as the page lays its pages out across the document column: headless Chrome's default window is
 // 756px wide on macOS and 780px on Linux, either side of the 767px breakpoint, and the layout would follow it.
 const browser=spawn(chrome!,['--headless=new','--window-size=1280,1100','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${temp}/chrome`,`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>','about:blank'],{stdio:'ignore'});
 let ws:WebSocket|undefined;
 try{
  let debugPort='';for(let i=0;i<200;i++){try{debugPort=(await readFile(join(temp,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{if(browser.exitCode!==null)throw new Error('Chrome exited');await sleep(100);}}assert.ok(debugPort);
  const target=await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'})).json() as {webSocketDebuggerUrl:string};ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('CDP unavailable'));});let seq=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();ws.onmessage=event=>{const m=JSON.parse(String(event.data));if(m.id&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}));});const evaluate=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  const wait=async(expression:string,label:string)=>{const end=Date.now()+30000;while(Date.now()<end){const value=await evaluate(expression);if(value)return value;await sleep(100);}throw new Error(`Timed out: ${label}: ${await evaluate('document.body.innerText')}`);};const click=(name:string)=>evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(name)}&&!b.disabled)?.click()`);
  const previews:Record<string,(PdfImageBounds&{tolerance:number})[]>=Object.create(null),outputs:Uint8Array[]=[];
  const previewImages:Record<string,string>=Object.create(null);
  const sourceRow=await db.prepare('SELECT object_key FROM artifacts WHERE envelope_id=?').bind(envelope.id).first<{object_key:string}>();assert.ok(sourceRow);const sourceBytes=new Uint8Array(await (await env.ARTIFACTS.get(sourceRow.object_key))!.arrayBuffer());
  // Render actual PDFs with PDF.js in Chrome. The expected image is independently
  // composited onto D0 from the exact PNG preview observed by the signer.
  const setupPixelVerifier=async()=>evaluate(`(async()=>{
   const pdfjs=await import(${JSON.stringify('/@fs'+resolve('node_modules/pdfjs-dist/build/pdf.mjs'))});
   pdfjs.GlobalWorkerOptions.workerSrc=${JSON.stringify('/@fs'+resolve('node_modules/pdfjs-dist/build/pdf.worker.mjs'))};
   window.__checkSignaturePixels=async(sourceBase64,outputBase64,fieldSpecs,pngs)=>{
    const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const source=await pdfjs.getDocument({data:decode(sourceBase64),isEvalSupported:false,stopAtErrors:true}).promise;
    const output=await pdfjs.getDocument({data:decode(outputBase64),isEvalSupported:false,stopAtErrors:true}).promise;
    try{
     if(source.numPages!==2||output.numPages!==2)throw new Error('Expected exactly two PDF pages');
     const metrics=[];
     for(let pageNumber=1;pageNumber<=2;pageNumber++){
      const baselinePage=await source.getPage(pageNumber),outputPage=await output.getPage(pageNumber),viewport=baselinePage.getViewport({scale:4}),actualViewport=outputPage.getViewport({scale:4});
      if(viewport.width!==actualViewport.width||viewport.height!==actualViewport.height)throw new Error('Unexpected PDF page size');
      const render=async(page,view)=>{const canvas=document.createElement('canvas');canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);const context=canvas.getContext('2d',{willReadFrequently:true});await page.render({canvas,canvasContext:context,viewport:view,transform:[canvas.width/view.width,0,0,canvas.height/view.height,0,0]}).promise;return canvas;};
      const base=await render(baselinePage,viewport),actual=await render(outputPage,actualViewport),expected=document.createElement('canvas');expected.width=base.width;expected.height=base.height;const ctx=expected.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);
      const specs=fieldSpecs.filter(f=>f.page===pageNumber);
      for(const field of specs){const image=new Image();image.src='data:image/png;base64,'+pngs[field.id];await image.decode();const r=field.rect,pageWidth=viewport.width/4,pageHeight=viewport.height/4,scale=30/image.naturalHeight;ctx.drawImage(image,r.x*base.width,r.y*base.height,image.naturalWidth*scale*base.width/pageWidth,image.naturalHeight*scale*base.height/pageHeight);}
      const before=base.getContext('2d',{willReadFrequently:true}).getImageData(0,0,base.width,base.height).data,rendered=actual.getContext('2d',{willReadFrequently:true}).getImageData(0,0,base.width,base.height).data,wanted=ctx.getImageData(0,0,base.width,base.height).data;
      for(const field of specs){const artwork=new Image();artwork.src='data:image/png;base64,'+pngs[field.id];await artwork.decode();let expectedInk=0,actualInk=0,intersection=0,union=0,colorError=0;const r=field.rect,x0=Math.max(0,Math.floor(r.x*base.width)),x1=Math.min(base.width,Math.ceil((r.x+Math.max(r.width,30*artwork.naturalWidth/artwork.naturalHeight/(viewport.width/4)))*base.width)),y0=Math.max(0,Math.floor(r.y*base.height)),y1=Math.min(base.height,Math.ceil((r.y+r.height)*base.height));
       for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const k=(y*base.width+x)*4;const differs=data=>Math.max(Math.abs(data[k]-before[k]),Math.abs(data[k+1]-before[k+1]),Math.abs(data[k+2]-before[k+2]))>40;const a=differs(rendered),e=differs(wanted);if(a)actualInk++;if(e)expectedInk++;if(a&&e){intersection++;colorError+=Math.abs(rendered[k]-wanted[k])+Math.abs(rendered[k+1]-wanted[k+1])+Math.abs(rendered[k+2]-wanted[k+2]);}if(a||e)union++;}
       if(expectedInk<8||actualInk<8||intersection/union<.80||colorError/(intersection*3)>24)throw new Error('Visible signature mismatch: '+field.id+' expected='+expectedInk+' actual='+actualInk+' intersection='+intersection+' union='+union+' colorError='+colorError/(intersection*3));
       metrics.push({id:field.id,expectedInk,actualInk,intersection,union,meanChannelError:colorError/(intersection*3)});
      }
     }
     return metrics;
    }finally{await source.destroy();await output.destroy();}
   };
  })()`);
  const source64=Buffer.from(sourceBytes).toString('base64');
  const verifyPixels=async(bytes:Uint8Array,ids:string[])=>evaluate(`window.__checkSignaturePixels(${JSON.stringify(source64)},${JSON.stringify(Buffer.from(bytes).toString('base64'))},${JSON.stringify(fields.filter(f=>ids.includes(f.id)))},${JSON.stringify(previewImages)})`);

  const capturePreviews=async(tolerance:number)=>{
   const actual=await evaluate(`(()=>[...document.querySelectorAll('[data-signature-field]')].map(e=>{const page=e.closest('[data-signature-page]'),p=page.getBoundingClientRect(),img=e.querySelector('img'),r=img.getBoundingClientRect(),scale=Math.min(r.width/img.naturalWidth,r.height/img.naturalHeight),w=img.naturalWidth*scale,h=img.naturalHeight*scale;return {id:e.dataset.signatureField,page:Number(page.dataset.signaturePage),x:(r.left-p.left)/p.width,y:(r.top-p.top)/p.height,width:w/p.width,height:h/p.height,pixelWidth:img.naturalWidth,pixelHeight:img.naturalHeight};}))()`);
   for(const item of actual){const [w,h]=item.page===1?[400.2,500.1]:[200.1,100.1];(previews[item.id]??=[]).push({x:item.x*w,y:(1-item.y-item.height)*h,width:item.width*w,height:item.height*h,pixelWidth:item.pixelWidth,pixelHeight:item.pixelHeight,tolerance});}
  };
  for(let i=0;i<2;i++){
   const view=await (await req(`/api/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,post({signedInEmail:tasks[i].recipientEmail,origin:'http://127.0.0.1:5173'},mgmt))).json();await call('Page.navigate',{url:`http://127.0.0.1:5173/sign?signer=${i}#code=${view.code}`});await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue'&&!b.disabled)",'session');await setupPixelVerifier();await click('Continue');const otp=await wait("document.body.innerText.match(/Local test verification code: (\\d{6})/)?.[1]",'OTP');
   await evaluate(`(()=>{const x=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,${JSON.stringify(otp)});x.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('Verify code');await wait("Boolean(document.querySelector('input[aria-label=\"Full name\"]'))",'name input');
   // One adopted name fills every Signature field the signer signs.
   await evaluate(`(()=>{const x=document.querySelector('input[aria-label="Full name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,${JSON.stringify(i?'Marcus':'Alexander')});x.dispatchEvent(new Event('input',{bubbles:true}));})()`);assert.equal(await evaluate("document.querySelectorAll('[data-signature-field]').length"),i===0?3:1,'signature positions are placed');
   // Show the document full width above the step, to measure where the previews land.
   await evaluate("(()=>{if(document.querySelector('#show-document'))return;const s=document.createElement('style');s.id='show-document';s.textContent='.esign-at-step-3 .esign-document{display:flex!important;grid-column:1/-1;grid-row:1}';document.head.appendChild(s);})()");
   // The signer signs each of their fields by selecting it.
   await evaluate("document.querySelectorAll('[data-apply-field]').forEach(b=>b.click())");
   await wait(`document.querySelectorAll('[data-signature-field] img').length===${i===0?3:1}`,'positioned previews');
   const captured=await evaluate(`Promise.all([...document.querySelectorAll('[data-signature-field]')].map(async e=>{const image=e.querySelector('img'),style=getComputedStyle(image),bytes=new Uint8Array(await (await fetch(image.src)).arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return {id:e.dataset.signatureField,fit:style.objectFit,position:style.objectPosition,png:btoa(raw)};}))`);
   for(const image of captured){assert.equal(image.fit,'contain',`${image.id} image fit`);assert.equal(image.position,'0% 0%',`${image.id} image position`);previewImages[image.id]=image.png;}
   await capturePreviews(.05);
   await evaluate(`document.querySelector('[data-signature-page="2"]').parentElement.style.width='240px'`);await capturePreviews(.12);await evaluate(`document.querySelector('[data-signature-page="2"]').parentElement.style.width=''`);
   const geometry=await evaluate(`(()=>{const page=document.querySelector('[data-signature-page="1"]').getBoundingClientRect();return [...document.querySelectorAll('[data-signature-page="1"] [data-signature-field]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.signatureField,x:(r.left-page.left)/page.width,y:(r.top-page.top)/page.height,w:r.width/page.width,h:r.height/page.height,label:e.getAttribute('aria-label'),image:!!e.querySelector('img'),fit:e.querySelector('img')&&getComputedStyle(e.querySelector('img')).objectFit,position:e.querySelector('img')&&getComputedStyle(e.querySelector('img')).objectPosition,imgWidth:e.querySelector('img')?.getBoundingClientRect().width,imgHeight:e.querySelector('img')?.getBoundingClientRect().height,boxWidth:r.width,boxHeight:r.height};});})()`);
   const fractional=await evaluate(`(()=>{const page=document.querySelector('[data-signature-page="2"]'),canvas=page.querySelector('canvas'),r=canvas.getBoundingClientRect();return {width:r.width,height:r.height,styleWidth:parseFloat(canvas.style.width),pixelRatio:devicePixelRatio,bitmapWidth:canvas.width,bitmapHeight:canvas.height,edge:[...canvas.getContext('2d').getImageData(canvas.width-1,Math.floor(canvas.height/2),1,1).data]};})()`);
   // The signing page lays a page out across its width (at most 2.25 pixels a point) and draws it for the screen's pixel ratio (at least 1.5 bitmap pixels a point).
   const layoutScale=fractional.styleWidth/200.1,bitmapScale=Math.max(1.5,Math.min(4,fractional.width/200.1*fractional.pixelRatio));
   assert.ok(layoutScale>1.5&&layoutScale<=2.25+1e-9,String(fractional.styleWidth));assert.ok(Math.abs(fractional.width/fractional.height-200.1/100.1)<.01);
   // The pages follow the document column when it narrows or widens after they were drawn (a window resized), up to 2.25 pixels a point.
   const frames=`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,pageWidths=`[...document.querySelectorAll('[data-signature-page] canvas')].map(c=>c.style.width)`;
   const narrowed=await evaluate(`(async()=>{document.querySelector('[aria-label="Document to sign"]').style.width='300px';await ${frames};return ${pageWidths};})()`);
   const widened=await evaluate(`(async()=>{document.querySelector('[aria-label="Document to sign"]').style.width='';await ${frames};return ${pageWidths};})()`);
   assert.deepEqual(narrowed,['284px','284px'],'the pages narrow with the column');assert.equal(parseFloat(widened[1]),fractional.styleWidth,'and widen back');
   assert.equal(fractional.bitmapWidth,Math.ceil(200.1*bitmapScale));assert.equal(fractional.bitmapHeight,Math.ceil(100.1*bitmapScale));assert.ok(fractional.edge[0]>200&&fractional.edge[1]<120&&fractional.edge[2]<120,`PDF content reaches the corresponding bitmap edge: ${fractional.edge}`);
   const scaled=await evaluate(`(()=>{const page=document.querySelector('[data-signature-page="2"]');page.parentElement.style.width='15px';const r=page.querySelector('canvas').getBoundingClientRect(),marker=page.querySelector('[data-signature-field]')?.getBoundingClientRect(),image=page.querySelector('[data-signature-field] img')?.getBoundingClientRect();return {width:r.width,height:r.height,marker:marker&&{x:marker.left-r.left,y:marker.top-r.top,width:marker.width,height:marker.height},image:image&&{x:image.left-r.left,y:image.top-r.top,width:image.width,height:image.height}};})()`);assert.ok(Math.abs(scaled.width-15)<.03);assert.ok(Math.abs(scaled.height-15*150.15/300.15)<.03);if(i===0){for(const item of [scaled.marker,scaled.image]){assert.ok(item);assert.ok(Math.abs(item.x-scaled.width*.001)<.03&&Math.abs(item.y-scaled.height*.002)<.03);}assert.ok(Math.abs(scaled.marker.width-scaled.width*.998)<.03);assert.ok(Math.abs(scaled.image.height-scaled.height*30/100.1)<.03);}
   if(i===0){const count=previews.a3.length;await capturePreviews(.6);assert.equal(previews.a3.length,count+1);for(const f of ['a','a2'])previews[f].pop();}
   const narrow=await evaluate(`(()=>{const p=document.querySelector('[data-signature-page="1"]').getBoundingClientRect();return [...document.querySelectorAll('[data-signature-page="1"] [data-signature-field]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.signatureField,x:(r.left-p.left)/p.width,y:(r.top-p.top)/p.height};});})()`);for(const f of (i===0?[fields[0],fields[1]]:[fields[3]])){const m=narrow.find((x:any)=>x.id===f.id);assert.ok(Math.abs(m.x-f.rect.x)<.01&&Math.abs(m.y-f.rect.y)<.01,'marker follows responsive scaling');}await evaluate(`document.querySelector('[data-signature-page="2"]').parentElement.style.width=''`);
   const expected=i===0?[fields[0],fields[1]]:[fields[3]];assert.equal(geometry.length,expected.length);for(const field of expected){const g=geometry.find((v:any)=>v.id===field.id);assert.ok(g&&g.image&&g.label.includes(i===0?'ana signature':'marcus signature'));assert.equal(g.fit,'contain');assert.equal(g.position,'0% 0%');assert.ok(g.imgWidth>0&&g.imgHeight>0&&g.imgHeight<g.boxHeight);for(const k of ['x','y','w','h']){const target=k==='w'?field.rect.width:k==='h'?field.rect.height:field.rect[k as 'x'|'y'];assert.ok(Math.abs(g[k]-target)<.01,`${k} for ${field.id}`);}}
   await evaluate("document.querySelector('input[type=checkbox]').click()");await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Sign document'&&!b.disabled)",'sign enabled');await click('Sign document');await wait("document.body.innerText.includes('Signature recorded.')",'signature accepted');assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelope.id),'processed');const row=await db.prepare(`SELECT 'envelopes/'||envelope_id||'/'||output_artifact_id||'.pdf' AS object_key,output_sha256 AS sha256,input_sha256 FROM signatures WHERE envelope_id=? AND sequence=? AND status='DONE'`).bind(envelope.id,i+1).first<{object_key:string;sha256:string;input_sha256:string}>();assert.ok(row);
   const bytes=new Uint8Array(await (await env.ARTIFACTS.get(row.object_key))!.arrayBuffer());assert.equal(sha256(bytes),row.sha256);
   if(i===0){const source=await db.prepare('SELECT sha256 FROM artifacts WHERE envelope_id=?').bind(envelope.id).first<{sha256:string}>();assert.equal(row.input_sha256,source?.sha256,'first signer consumes D0');}
   else assert.equal(row.input_sha256,sha256(outputs[0]),'second signer consumes D1');outputs.push(bytes);
   const pixelMetrics=await verifyPixels(bytes,i===0?['a','a2','a3']:['a','a2','a3','b']);assert.equal(pixelMetrics.length,i===0?3:4);
   const actual=await imageBounds(bytes),expectedIds=i===0?[['a','a2'],['a3']]:[['a','a2','b'],['a3']];
   for(let page=0;page<2;page++){
    assert.equal(actual[page].length,expectedIds[page].length,`D${i+1} image count page ${page+1}`);
    for(const [index,id] of expectedIds[page].entries()){
     const pdfImage=actual[page][index],field=fields.find(f=>f.id===id)!;const [w,h]=page===0?[400.2,500.1]:[200.1,100.1],rect=field.rect;
     assert.ok(pdfImage.x>=rect.x*w-1e-7&&pdfImage.y>=h*(1-rect.y-rect.height)-1e-7,'PDF image stays inside field');
     assert.ok(pdfImage.x+pdfImage.width<=w+1e-7&&pdfImage.y+pdfImage.height<=h*(1-rect.y)+1e-7,'PDF image stays on page');if(id==='a')assert.ok(pdfImage.width>rect.width*w,'long signature extends beyond field');
     close(pdfImage.x,rect.x*w,1e-7,'PDF left edge');close(pdfImage.y+pdfImage.height,h*(1-rect.y),1e-7,'PDF top edge');
     close(pdfImage.width/pdfImage.height,pdfImage.pixelWidth/pdfImage.pixelHeight,1e-7,'PDF image aspect ratio');
     assert.ok(previews[id]?.length>=2,`preview captures for ${id}`);
     for(const preview of previews[id]){assert.equal(pdfImage.pixelWidth,preview.pixelWidth);assert.equal(pdfImage.pixelHeight,preview.pixelHeight);for(const key of ['x','y','width','height'] as const)close(pdfImage[key],preview[key],preview.tolerance,`D${i+1} ${id} ${key} vs responsive preview`);}
    }
   }
   close(actual[0][0].x,0,1e-7,'first signature touches left edge');close(actual[0][0].y+actual[0][0].height,500.1,1e-7,'first signature touches top edge');for(const image of actual.flat())close(image.height,30,1e-7,'fixed image height');
   if(i===1){const prior=await imageBounds(outputs[0]);assert.deepEqual(actual[0].slice(0,2),prior[0]);assert.deepEqual(actual[1],prior[1]);}
  }
  assert.equal(await finalizeEnvelopeStep(env,'a',envelope.id),'finalized');assert.deepEqual(new Uint8Array(await signedPdf(env.DB,env.ARTIFACTS,envelope.id)),outputs[1]);
  const outputImages=await imageBounds(outputs[1]),firstImage=outputImages[0][0],mutant=async(kind:'occluded'|'replacement'|'wrong-page'|'extra-page')=>{
   const document=await PDFDocument.load(outputs[1],{updateMetadata:false});
   if(kind==='occluded'||kind==='replacement'||kind==='wrong-page'){
    const page=document.getPage(0),field=fields[0].rect;page.drawRectangle({x:field.x*400.2,y:(1-field.y-field.height)*500.1,width:firstImage.width,height:field.height*500.1,color:rgb(1,1,1),borderWidth:0});
    if(kind==='replacement'){const png=await document.embedPng(await renderTypedSignature('BOB'));page.drawImage(png,{x:firstImage.x,y:firstImage.y,width:firstImage.width,height:firstImage.height});}
    if(kind==='wrong-page'){const png=await document.embedPng(await renderTypedSignature('Ana'));document.getPage(1).drawImage(png,{x:0,y:0,width:10,height:10*png.height/png.width});}
   }else if(kind==='extra-page')document.addPage([400.2,500.1]);
   return document.save({useObjectStreams:false});
  };
  for(const kind of ['occluded','replacement','wrong-page','extra-page'] as const){const damaged=await mutant(kind);await assert.rejects(()=>verifyPixels(damaged,['a','a2','a3','b']),kind==='extra-page'?/exactly two PDF pages/:/Visible signature mismatch/,`${kind} must fail the pixel oracle for the expected reason`);}

 }finally{ws?.close();browser.kill('SIGTERM');await Promise.race([once(browser,'exit'),sleep(3000)]).catch(()=>{});await new Promise<void>(resolve=>proxy.close(()=>resolve()));await vite.close();await mf.dispose();}
});
