import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderPdfDocument,followColumn,MAX_PAGE_PIXELS,MAX_TOTAL_PIXELS} from '../src/app/ui/pdf.ts';

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

/** Pages of these point sizes whose viewports scale like PDF.js's; returns the canvases drawn. */
async function drawScaled(sizes:[number,number][],display:Parameters<typeof renderPdfDocument>[4]){
 const canvases:any[]=[];const doc:any={createElement(){const canvas:any={width:0,height:0,style:{},dataset:{},getContext:()=>({})};canvases.push(canvas);return canvas;}};
 const target:any={ownerDocument:doc,children:[],appendChild(node:any){this.children.push(node);},replaceChildren(){this.children=[];}};
 const pdf:any={numPages:sizes.length,async getPage(index:number){const [w,h]=sizes[index-1];const page:any={_renderPageChunk(){},getViewport:({scale}:{scale:number})=>({width:w*scale,height:h*scale}),render(){page._renderPageChunk({lastChunk:true});return {promise:Promise.resolve(),cancel(){}};},cleanup(){}};return page;}};
 await renderPdfDocument(new Blob(['synthetic']),target,new AbortController().signal,()=>({promise:Promise.resolve(pdf),async destroy(){}}) as any,display);
 return canvases;
}

test('without a display, pages are laid out and drawn at 1.5 pixels per point, as before',async()=>{
 const [c]=await drawScaled([[400,500]],{});
 assert.deepEqual([c.width,c.height,c.style.width,c.dataset.pdfWidth,c.dataset.pdfHeight],[600,750,'600px','400','500']);
});

test('a page is drawn for the width it is shown at times the pixel ratio, and fitted across that width',async()=>{
 // Not fitted (the editor): laid out at 1.5, drawn sharp for a 2x screen.
 const [editor]=await drawScaled([[400,500]],{width:500,pixelRatio:2});
 assert.equal(editor.style.width,'600px');assert.deepEqual([editor.width,editor.height],[1000,1250]);
 // Fitted (the signing page): laid out across 700 pixels, drawn at 3.5 pixels a point.
 const [signing]=await drawScaled([[400,500]],{width:700,pixelRatio:2,fit:true});
 assert.equal(signing.style.width,'700px');assert.deepEqual([signing.width,signing.height],[1400,1750]);assert.equal(signing.dataset.pdfWidth,'400');
 // Fitted at most 2.25 pixels a point, and never drawn at more than 4 bitmap pixels a point.
 const [wide]=await drawScaled([[400,500]],{width:2000,pixelRatio:3,fit:true});
 assert.equal(wide.style.width,'900px');assert.deepEqual([wide.width,wide.height],[1600,2000]);
 // A narrow 1x screen still draws at least 1.5 pixels a point.
 const [narrow]=await drawScaled([[400,500]],{width:300,pixelRatio:1,fit:true});
 assert.equal(narrow.style.width,'300px');assert.deepEqual([narrow.width,narrow.height],[600,750]);
});

test('sharper pages stay within the pixel budgets, never below the layout scale',async()=>{
 // 40 Letter pages at 4 bitmap pixels a point would be 40 × 7.7M pixels: each gets its share instead.
 const canvases=await drawScaled(Array.from({length:40},()=>[612,792] as [number,number]),{width:1400,pixelRatio:2,fit:true});
 const total=canvases.reduce((sum,c)=>sum+c.width*c.height,0);
 assert.ok(total<=MAX_TOTAL_PIXELS,String(total));assert.ok(canvases.every(c=>c.width>=612*1.5&&c.width*c.height<=MAX_PAGE_PIXELS));
});

test('fitted pages follow the column they are shown in as it narrows or widens, up to 2.25 pixels a point, until the render ends',()=>{
  let notify!:()=>void, observed:any=null, disconnected=false;
  class ResizeObserver {constructor(callback:()=>void){notify=callback;} observe(element:any){observed=element;} disconnect(){disconnected=true;}}
  const view:any={ResizeObserver,getComputedStyle:()=>({paddingLeft:'8px',paddingRight:'8px'}),devicePixelRatio:1};
  const shownIn:any={clientWidth:1016,ownerDocument:{defaultView:view}};
  const pages=[{dataset:{pdfWidth:'612'},style:{width:'1000px'}},{dataset:{pdfWidth:'200'},style:{width:'450px'}}];
  const container:any={querySelectorAll:(selector:string)=>selector==='canvas'?pages:[]};
  const controller=new AbortController();
  followColumn(container,shownIn,controller.signal);
  assert.equal(observed,shownIn);
  shownIn.clientWidth=416;notify();
  assert.deepEqual(pages.map(p=>p.style.width),['400px','400px'],'narrower: the column\'s width');
  shownIn.clientWidth=2016;notify();
  assert.deepEqual(pages.map(p=>p.style.width),[`${612*2.25}px`,'450px'],'wider: up to 2.25 pixels a point');
  controller.abort();
  assert.equal(disconnected,true,'a render that ends stops following');
});
