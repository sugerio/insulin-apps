import type {PDFDocumentLoadingTask, RenderTask} from 'pdfjs-dist';

/**
 * PDF display for the recipient page and the editor: every page drawn to a canvas with PDF.js,
 * within fixed pixel budgets. The pages import this module lazily, and renderPdf loads PDF.js and
 * its worker only on first use, so neither is in a page's initial bundle. renderPdfDocument and
 * strictPdfOptions take no bundler-only imports, so tests run them with PDF.js in Node.
 */

/** Renders every page of `blob` into `container` with the bundled PDF.js and its worker. */
export async function renderPdf(blob:Blob, container:HTMLElement, signal:AbortSignal) {
  const [{getDocument, GlobalWorkerOptions}, {default:workerUrl}]=await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  GlobalWorkerOptions.workerSrc=workerUrl;
  return renderPdfDocument(blob,container,signal,data=>getDocument(strictPdfOptions(data)));
}

export function strictPdfOptions(data:Uint8Array) {
  return {data,isEvalSupported:false,stopAtErrors:true} as const;
}

export const MAX_PAGE_PIXELS=16_777_216;
export const MAX_TOTAL_PIXELS=50_331_648;
const MAX_DIMENSION=8192;

type OpenDocument = (data:Uint8Array)=>PDFDocumentLoadingTask;

export async function renderPdfDocument(blob:Blob, container:HTMLElement, signal:AbortSignal, open:OpenDocument) {
  signal.throwIfAborted();
  const data=new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  const task=open(data);
  let render:RenderTask|undefined, destruction:Promise<void>|undefined, success=false;
  const canvases:HTMLCanvasElement[]=[];
  const destroy=()=>destruction ??= task.destroy();
  const abort=()=>{render?.cancel();void destroy().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    const pdf=await task.promise;
    signal.throwIfAborted();
    if (!pdf.numPages) throw new Error('Empty PDF');
    let total=0;
    for(let number=1;number<=pdf.numPages;number++) {
      signal.throwIfAborted();
      const page=await pdf.getPage(number);
      signal.throwIfAborted();
      const viewport=page.getViewport({scale:1.5});
      const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height),pixels=width*height;
      if (!Number.isFinite(width/viewport.width) || !Number.isFinite(height/viewport.height) || !Number.isSafeInteger(pixels) || width<=0 || height<=0 || width>MAX_DIMENSION || height>MAX_DIMENSION || pixels>MAX_PAGE_PIXELS || total+pixels>MAX_TOTAL_PIXELS) throw new Error('PDF pixel budget exceeded');
      total+=pixels;
      const canvas=container.ownerDocument.createElement('canvas');canvases.push(canvas);
      canvas.width=width;canvas.height=height;canvas.dataset.pdfWidth=String(viewport.width/1.5);canvas.dataset.pdfHeight=String(viewport.height/1.5);
      // CSS uses the exact viewport ratio; the transform fills the rounded bitmap.
      canvas.style.width=`${viewport.width}px`;canvas.style.maxWidth='100%';canvas.style.height='auto';canvas.style.aspectRatio=`${viewport.width} / ${viewport.height}`;
      const context=canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      // PDF.js 5.4.624 can resolve render.promise after an operator-stream error by
      // marking the list complete itself. Only a real final chunk proves completion.
      const internal=page as unknown as {_renderPageChunk?: (chunk:{lastChunk?:boolean}, ...args:unknown[])=>void};
      const original=internal._renderPageChunk;
      if (typeof original!=='function') throw new Error('PDF renderer completion check unavailable');
      let finalChunk=false;
      internal._renderPageChunk=function(chunk,...args) {if(chunk?.lastChunk===true) finalChunk=true;return original.call(this,chunk,...args);};
      try {
        render=page.render({canvas,canvasContext:context,viewport,transform:[width/viewport.width,0,0,height/viewport.height,0,0]});
        await render.promise;render=undefined;
        signal.throwIfAborted();
        if (!finalChunk) throw new Error('Incomplete PDF page rendering');
      } finally {internal._renderPageChunk=original;}
      signal.throwIfAborted();
      container.appendChild(canvas);
      page.cleanup();
    }
    success=true;
  } finally {
    signal.removeEventListener('abort',abort);
    try {await destroy();} finally {
      if (!success) {container.replaceChildren();for(const canvas of canvases) {canvas.width=0;canvas.height=0;}}
    }
  }
}
