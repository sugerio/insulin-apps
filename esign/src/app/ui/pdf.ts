import type {PDFDocumentLoadingTask, RenderTask} from 'pdfjs-dist';

/**
 * PDF display for the recipient page and the editor: every page drawn to a canvas with PDF.js,
 * within fixed pixel budgets. The pages import this module lazily, and renderPdf loads PDF.js and
 * its worker only on first use, so neither is in a page's initial bundle. renderPdfDocument and
 * strictPdfOptions take no bundler-only imports, so tests run them with PDF.js in Node.
 */

/**
 * Renders every page of `blob` into `container` with the bundled PDF.js and its worker. `shownIn`,
 * the element the pages will be shown in (when `container` is not yet on the page), sets how sharp
 * they are drawn: for its width and the screen's pixel ratio. With `fit`, pages are laid out across
 * that width (up to FIT_MAX_SCALE) rather than at the fixed layout scale.
 */
export async function renderPdf(blob:Blob, container:HTMLElement, signal:AbortSignal, shownIn:HTMLElement=container, fit=false) {
  const [{getDocument, GlobalWorkerOptions}, {default:workerUrl}]=await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  GlobalWorkerOptions.workerSrc=workerUrl;
  return renderPdfDocument(blob,container,signal,data=>getDocument(strictPdfOptions(data)),{...displayOf(shownIn),fit});
}

/** How pages will be shown: the CSS width of `element`'s content and the screen's device pixels per CSS pixel. */
export function displayOf(element:HTMLElement):Display {
  const view=element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle!=='function') return {};
  const style=view.getComputedStyle(element),width=element.clientWidth-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0);
  return {width:width>0?width:undefined,pixelRatio:view.devicePixelRatio||1};
}

/**
 * Where pages are shown, when known: content width in CSS pixels, device pixels per CSS pixel, and
 * whether pages fill that width.
 */
export type Display = {width?:number;pixelRatio?:number;fit?:boolean};
/** Pages are laid out at 1.5 CSS pixels per point (at most the width they are shown in)... */
const CSS_SCALE=1.5;
/** ...or, fitted, across the width they are shown in, up to 2.25 (a Letter page about 1,380 pixels wide). */
const FIT_MAX_SCALE=2.25;
/** At most four bitmap pixels per point, whatever the screen. */
const MAX_BITMAP_SCALE=4;

export function strictPdfOptions(data:Uint8Array) {
  return {data,isEvalSupported:false,stopAtErrors:true} as const;
}

export const MAX_PAGE_PIXELS=16_777_216;
export const MAX_TOTAL_PIXELS=50_331_648;
const MAX_DIMENSION=8192;

type OpenDocument = (data:Uint8Array)=>PDFDocumentLoadingTask;

/**
 * Each page's bitmap is drawn for the width it is shown at times the pixel ratio (`display`), so it
 * is sharp on a high-density screen, and never at less than the layout scale. The pixel budgets
 * hold: a page gets at most its share of what is left, and a document that does not fit them at
 * the layout scale is refused as before.
 */
export async function renderPdfDocument(blob:Blob, container:HTMLElement, signal:AbortSignal, open:OpenDocument, display:Display={}) {
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
      const points=page.getViewport({scale:1}),fitted=display.fit&&display.width?Math.min(FIT_MAX_SCALE,display.width/points.width):0;
      const layoutScale=fitted>0&&Number.isFinite(fitted)?fitted:CSS_SCALE,layout=page.getViewport({scale:layoutScale});
      let scale=CSS_SCALE;
      if (display.width && display.pixelRatio) {
        const shown=Math.min(layout.width,display.width);
        const wanted=Math.min(MAX_BITMAP_SCALE,shown/points.width*display.pixelRatio);
        const share=Math.min(MAX_PAGE_PIXELS,(MAX_TOTAL_PIXELS-total)/(pdf.numPages-number+1)),affordable=Math.sqrt(share/(points.width*points.height))*0.99;
        if (Number.isFinite(wanted) && Number.isFinite(affordable)) scale=Math.max(CSS_SCALE,Math.min(wanted,affordable));
      }
      const viewport=scale===layoutScale?layout:page.getViewport({scale});
      const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height),pixels=width*height;
      if (!Number.isFinite(width/viewport.width) || !Number.isFinite(height/viewport.height) || !Number.isSafeInteger(pixels) || width<=0 || height<=0 || width>MAX_DIMENSION || height>MAX_DIMENSION || pixels>MAX_PAGE_PIXELS || total+pixels>MAX_TOTAL_PIXELS) throw new Error('PDF pixel budget exceeded');
      total+=pixels;
      const canvas=container.ownerDocument.createElement('canvas');canvases.push(canvas);
      canvas.width=width;canvas.height=height;canvas.dataset.pdfWidth=String(points.width);canvas.dataset.pdfHeight=String(points.height);
      // CSS uses the exact layout ratio; the transform fills the rounded bitmap.
      canvas.style.width=`${layout.width}px`;canvas.style.maxWidth='100%';canvas.style.height='auto';canvas.style.aspectRatio=`${layout.width} / ${layout.height}`;
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
