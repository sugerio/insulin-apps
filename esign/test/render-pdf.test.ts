import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderPdfDocument,MAX_PAGE_PIXELS,MAX_TOTAL_PIXELS} from '../ui/pdf.ts';

function fixture(sizes:[number,number][], pending=false) {
  const canvases:any[]=[];let cancelled=0,destroyed=0,renders=0, resolveRender!:()=>void;
  const doc:any={createElement(){const canvas:any={width:0,height:0,style:{},dataset:{},getContext:()=>({})};canvases.push(canvas);return canvas;}};
  const target:any={ownerDocument:doc,children:[],appendChild(node:any){this.children.push(node);},replaceChildren(){this.children=[];}};
  const pdf:any={numPages:sizes.length,async getPage(index:number){const [width,height]=sizes[index-1];const page:any={_renderPageChunk(){},getViewport:()=>({width,height}),render(){renders++;if(!pending) page._renderPageChunk({lastChunk:true});return {promise:pending?new Promise<void>(resolve=>resolveRender=resolve):Promise.resolve(),cancel(){cancelled++;resolveRender();}};},cleanup(){}};return page;}};
  const open:any=()=>({promise:Promise.resolve(pdf),async destroy(){destroyed++;}});
  return {target,open,canvases,get cancelled(){return cancelled;},get destroyed(){return destroyed;},get renders(){return renders;}};
}

test('rejects excessive single-page and cumulative pixel budgets before canvas allocation',async()=>{
  for (const sizes of [[[4097,4096]],Array.from({length:Math.floor(MAX_TOTAL_PIXELS/MAX_PAGE_PIXELS)+1},()=>[4096,4096])] as [number,number][][]) {
    const f=fixture(sizes);
    await assert.rejects(renderPdfDocument(new Blob(['synthetic']),f.target,new AbortController().signal,f.open),/pixel budget/i);
    assert.equal(f.renders,sizes.length-1);assert.equal(f.canvases.length,sizes.length-1);assert.equal(f.destroyed,1);
    assert.ok(f.canvases.every(c=>c.width===0 && c.height===0));
  }
});

test('abort cancels an active PDF render, destroys the loading task, and releases canvases',async()=>{
  const f=fixture([[100,100]],true), controller=new AbortController();
  const result=renderPdfDocument(new Blob(['synthetic']),f.target,controller.signal,f.open);
  while (!f.renders) await new Promise(resolve=>setTimeout(resolve,0));
  controller.abort();await assert.rejects(result,/abort/i);
  assert.equal(f.cancelled,1);assert.equal(f.destroyed,1);assert.equal(f.target.children.length,0);
  assert.equal(f.canvases[0].width,0);assert.equal(f.canvases[0].height,0);
});

test('abort while loading destroys the task before any page or canvas is created',async()=>{
  const f=fixture([[100,100]]),controller=new AbortController();let destroyed=0, rejectLoading!:(error:Error)=>void;
  const open:any=()=>({promise:new Promise((_resolve,reject)=>rejectLoading=reject),async destroy(){destroyed++;rejectLoading(new DOMException('Aborted','AbortError'));}});
  const result=renderPdfDocument(new Blob(['synthetic']),f.target,controller.signal,open);
  while (!rejectLoading) await new Promise(resolve=>setTimeout(resolve,0));
  controller.abort();await assert.rejects(result,/abort/i);
  assert.equal(destroyed,1);assert.equal(f.canvases.length,0);assert.equal(f.renders,0);
});

test('an already aborted render never opens the PDF',async()=>{
  const f=fixture([[100,100]]),controller=new AbortController();controller.abort();
  let opened=false;await assert.rejects(renderPdfDocument(new Blob(['synthetic']),f.target,controller.signal,()=>{opened=true;return f.open();}),/abort/i);
  assert.equal(opened,false);
});

test('fails closed if the PDF.js completion hook is unavailable',async()=>{
  const f=fixture([[100,100]]);
  const open:any=()=>({promise:Promise.resolve({numPages:1,async getPage(){return {getViewport:()=>({width:100,height:100}),render(){throw new Error('must not render');}};}}),async destroy(){}});
  await assert.rejects(renderPdfDocument(new Blob(['synthetic']),f.target,new AbortController().signal,open),/completion check unavailable/i);
  assert.ok(f.canvases.every(c=>c.width===0 && c.height===0));
});

test('fractional PDF viewport fills rounded bitmap while preserving exact responsive CSS aspect ratio',async()=>{
 const f=fixture([[30.15,15.15],[1000.2,500.7]]);const calls:any[]=[];
 const source=f.open;
 const open:any=(data:any)=>{const task=source(data);return {...task,promise:task.promise.then((pdf:any)=>({...pdf,async getPage(i:number){const page=await pdf.getPage(i);const render=page.render;page.render=(options:any)=>{calls.push(options);return render.call(page,options);};return page;}}))};};
 await renderPdfDocument(new Blob(['synthetic']),f.target,new AbortController().signal,open);
 for(const [i,[width,height]] of [[30.15,15.15],[1000.2,500.7]].entries()){
  const canvas=f.canvases[i];assert.equal(canvas.width,Math.ceil(width));assert.equal(canvas.height,Math.ceil(height));
  assert.equal(canvas.style.width,`${width}px`);assert.equal(canvas.style.height,'auto');assert.equal(canvas.style.aspectRatio,`${width} / ${height}`);assert.equal(canvas.style.maxWidth,'100%');
  assert.deepEqual(calls[i].transform,[Math.ceil(width)/width,0,0,Math.ceil(height)/height,0,0]);
 }
});

test('unrepresentably small viewport fails closed rather than using an infinite render transform',async()=>{
 const f=fixture([[Number.MIN_VALUE,1]]);
 await assert.rejects(renderPdfDocument(new Blob(['synthetic']),f.target,new AbortController().signal,f.open),/pixel budget/i);
 assert.equal(f.canvases.length,0);
});
