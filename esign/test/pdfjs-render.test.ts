import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {strictPdfOptions} from '../ui/pdfOptions.ts';
import {renderPdfDocument} from '../ui/renderPdfDocument.ts';
import {fakePreviewNode,syntheticInlineImagePdf} from './helpers/pdf-fixture.ts';

test('actual PDF.js rejects a damaged inline image while rendering',async()=>{
  const target=fakePreviewNode();
  await assert.rejects(renderPdfDocument(await syntheticInlineImagePdf(true),target,new AbortController().signal,data=>getDocument(strictPdfOptions(data))),/incomplete PDF/i);
  assert.equal(target.children.length,0);
});

test('actual PDF.js renders a valid inline image',async()=>{
  const target=fakePreviewNode();
  await renderPdfDocument(await syntheticInlineImagePdf(false),target,new AbortController().signal,data=>getDocument(strictPdfOptions(data)));
  assert.equal(target.children.length,1);
});

test('recipient page does not offer signing when actual PDF.js rejects a damaged inline image',async()=>{
  const React=(await import('react')).default;
  const {default:Renderer,act}=await import('react-test-renderer');
  const {RecipientPage}=await import('../ui/RecipientPage.ts');
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const oldFetch=globalThis.fetch,oldWindow=(globalThis as any).window;
  try {
    const broken=await syntheticInlineImagePdf(true);let signRequests=0;
    (globalThis as any).window={location:{origin:'http://127.0.0.1:5173',hash:'#code=test',pathname:'/'},history:{replaceState(){}}};
    globalThis.fetch=async (input:any)=>{const path=new URL(String(input)).pathname;
      if(path==='/v1/page-sessions/exchange') return Response.json({token:'token'});
      if(path==='/v1/signing/otp') return Response.json({messageId:'test'});
      if(path==='/v1/signing/otp/verify') return new Response(null,{status:204});
      if(path==='/v1/signing/current') return Response.json({id:'d0',sha256:'hash'});
      if(path==='/v1/signing/pdf') return new Response(broken);
      if(path==='/v1/signing/sign') {signRequests++;return new Response(null,{status:202});}
      throw new Error(path);};
    const visible=fakePreviewNode();let renderer:any;
    let complete!:()=>void;const rendered=new Promise<void>(resolve=>complete=resolve);
    const realRender=async (blob:Blob,target:HTMLElement,signal:AbortSignal)=>{try {await renderPdfDocument(blob,target,signal,data=>getDocument(strictPdfOptions(data)));} finally {complete();}};
    await act(async()=>{renderer=Renderer.create(React.createElement(RecipientPage,{renderDocument:realRender}),{createNodeMock:()=>visible});});
    const button=(text:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(text));
    // The document opens before the code; a damaged one never offers Continue or signing.
    await act(async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));});
    await act(async()=>{await rendered;});
    assert.ok(button('Retry document'));assert.equal(button('Continue'),undefined);assert.equal(button('Sign document'),undefined);
    assert.match(JSON.stringify(renderer.toJSON()),/Document unavailable/);assert.equal(visible.children.length,0);assert.equal(signRequests,0);
    await act(async()=>{renderer.unmount();});
  } finally {globalThis.fetch=oldFetch;(globalThis as any).window=oldWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});

test('strict PDF.js options disable evaluation and require error reporting',()=>{
  const options=strictPdfOptions(new Uint8Array());
  assert.equal(options.stopAtErrors,true);assert.equal(options.isEvalSupported,false);
});
