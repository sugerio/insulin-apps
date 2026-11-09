import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
const mod=await import('./helpers/editor-demo-source.ts').catch(()=>null);

test('local demo source is opt-in, short-lived, one-use and bound to its generated URL',async()=>{
 assert.ok(mod);assert.throws(()=>mod.createEditorDemoSources(false));
 let now=1000;const sources=mod.createEditorDemoSources(true,()=>now);const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 assert.throws(()=>sources.issue(new Uint8Array(5*1024*1024+1)));const url=sources.issue(bytes);assert.match(url,/^https:\/\/editor-source\.invalid\/[a-f0-9]{64}$/);
 await assert.rejects(sources.download(url.replace('editor-source.invalid','evil.example.com'),new AbortController().signal));
 assert.deepEqual(await sources.download(url,new AbortController().signal),bytes);await assert.rejects(sources.download(url,new AbortController().signal));
 const expired=sources.issue(bytes);now+=30001;await assert.rejects(sources.download(expired,new AbortController().signal));
 const aborted=sources.issue(bytes),c=new AbortController();c.abort();await assert.rejects(sources.download(aborted,c.signal));
});
