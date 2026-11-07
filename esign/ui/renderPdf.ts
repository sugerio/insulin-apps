import {getDocument, GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {renderPdfDocument} from './renderPdfDocument';
import {strictPdfOptions} from './pdfOptions';

GlobalWorkerOptions.workerSrc=workerUrl;

export async function renderPdf(blob:Blob, container:HTMLElement, signal:AbortSignal) {
  return renderPdfDocument(blob,container,signal,data=>getDocument(strictPdfOptions(data)));
}
