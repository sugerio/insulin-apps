import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
const module=await import('../ui/editor-host-url.ts').catch(()=>null);

test('host downloads an HTTPS PDF with CORS and no credentials or redirects',async()=>{
 assert.ok(module,'browser URL downloader must exist');
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();let init:RequestInit|undefined;
 const blob=await module.downloadEditorPdf('https://files.example.com/doc.pdf?token=secret',{fetch:async(_url,options)=>{init=options;return new Response(bytes);}});
 assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
 assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.equal(init?.mode,'cors');assert.equal(init?.referrerPolicy,'no-referrer');
});

test('URL download rejects invalid URLs, CORS, redirects, oversize and timeouts without leaking URL',async()=>{
 assert.ok(module);const secret='top-secret-token';let called=0;
 const failure=async(url:string,fetcher:typeof fetch,timeoutMs=100)=>{await assert.rejects(module.downloadEditorPdf(url,{fetch:fetcher,timeoutMs}),e=>e instanceof Error&&!e.message.includes(secret));};
 const never:typeof fetch=async()=>{called++;throw new Error(secret);};
 for(const url of ['http://files.example.com/a',`https://user:${secret}@files.example.com/a`,'file:///etc/passwd'])await failure(url,never);
 assert.equal(called,0);
 await failure(`https://files.example.com/a?sig=${secret}`,never);
 await failure(`https://files.example.com/a?sig=${secret}`,async()=>Response.redirect('https://other.example.com/',302));
 await failure(`https://files.example.com/a?sig=${secret}`,async()=>new Response(new Uint8Array(5*1024*1024+1)));
 let cancelled=false,count=0;await failure(`https://files.example.com/a?sig=${secret}`,async()=>new Response(new ReadableStream({pull(c){if(count++<8)c.enqueue(new Uint8Array(1024*1024));else c.close();},cancel(){cancelled=true;}})));assert.equal(cancelled,true);
 await failure(`https://files.example.com/a?sig=${secret}`,async(_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error(secret)),{once:true})),10);
});

test('host offers URL input and forwards it in the session body',async()=>{
 const html=await readFile(new URL('../ui/editor-host.html',import.meta.url),'utf8');const source=await readFile(new URL('../ui/editor-host-main.ts',import.meta.url),'utf8');
 assert.match(html,/id="pdf-url"/);assert.match(html,/id="synthetic-confirmation"/);assert.match(source,/syntheticConfirmation\.checked/);assert.match(source,/x-esign-synthetic-confirmed/);assert.match(source,/sourceUrl:inputUrl/);assert.doesNotMatch(source,/downloadEditorPdf/);
});
