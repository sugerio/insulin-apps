import { formatBytes } from './limits.ts'

/**
 * Files, before anything is learned (design section 11, "Import path"). Preflight checks each file's type and size
 * against the organization's limits and names the ones that can't be learned, with the reason, before anything
 * starts; the person confirms the rest. Each accepted file then streams to the engine's inbox (which buffers it, up to
 * 64 MB, and computes its SHA-256), and on the way the app looks for a PDF that is only a scanned image (no fonts at
 * all), so it is named before learning too.
 */
export const LEARNABLE: { extensions: string[]; type: string; label: string }[] = [
  { extensions: ['pdf'], type: 'application/pdf', label: 'PDF' },
  { extensions: ['docx'], type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  { extensions: ['pptx'], type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint' },
  { extensions: ['xlsx'], type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  { extensions: ['md', 'markdown'], type: 'text/markdown', label: 'Markdown' },
  { extensions: ['txt'], type: 'text/plain', label: 'plain text' },
  { extensions: ['html', 'htm'], type: 'text/html', label: 'web page' },
]

/** What to save a file as instead, for the types people often have. */
const INSTEAD: Record<string, string> = {
  xlsm: 'Save it as an Excel workbook (.xlsx) without macros',
  xls: 'Save it as an Excel workbook (.xlsx)',
  doc: 'Save it as a Word document (.docx)',
  ppt: 'Save it as a PowerPoint presentation (.pptx)',
  rtf: 'Save it as a Word document (.docx)',
  png: 'Upload a PDF with text instead of an image',
  jpg: 'Upload a PDF with text instead of an image',
  jpeg: 'Upload a PDF with text instead of an image',
}

export function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
}

export type Verdict = { ok: true; type: string } | { ok: false; reason: string }

/** Whether a file can be learned, from its name, its size and the largest file the organization may add. */
export function verdictOf(name: string, bytes: number, fileLimit: number | null): Verdict {
  const extension = extensionOf(name)
  const kind = LEARNABLE.find((entry) => entry.extensions.includes(extension))
  if (!kind) {
    const instead = INSTEAD[extension]
    return { ok: false, reason: `“${name}” is a type Insulin can't read.${instead ? ` ${instead} and add it again.` : ' Add PDFs with text, Word, PowerPoint, Excel, Markdown, plain text or web pages.'}` }
  }
  if (bytes <= 0) return { ok: false, reason: `“${name}” is empty.` }
  if (fileLimit !== null && bytes > fileLimit) {
    return { ok: false, reason: `“${name}” is ${formatBytes(bytes)}; the largest file your organization can add is ${formatBytes(fileLimit)}. Split it, or save it in a smaller format.` }
  }
  return { ok: true, type: kind.type }
}

export class TooLargeError extends Error {
  override name = 'TooLargeError'
}

/**
 * Passes a file through on its way to the engine, counting its bytes (and stopping past `maxBytes`) and, for a PDF,
 * noting whether it has any fonts or compressed objects: a PDF with neither has no text to learn.
 */
export function inspect(body: ReadableStream<Uint8Array>, maxBytes: number, pdf: boolean, keep = false): { stream: ReadableStream<Uint8Array>; result: () => { bytes: number; scannedPdf: boolean; kept: Uint8Array | null } } {
  let bytes = 0
  // A Knowledge export is read here too (its zip's directory), so its bytes are kept as they pass (it is a few MB).
  const chunks: Uint8Array[] = []
  let tail = ''
  let fonts = false
  let objectStreams = false
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        controller.error(new TooLargeError())
        return
      }
      if (pdf && !(fonts && objectStreams)) {
        let text = tail
        for (let index = 0; index < chunk.length; index += 1) text += String.fromCharCode(chunk[index]!)
        if (text.includes('/Font')) fonts = true
        if (text.includes('/ObjStm')) objectStreams = true
        tail = text.slice(-16)
      }
      if (keep) chunks.push(chunk.slice())
      controller.enqueue(chunk)
    },
  }))
  const kept = () => {
    if (!keep) return null
    const all = new Uint8Array(bytes)
    let at = 0
    for (const chunk of chunks) {
      all.set(chunk, at)
      at += chunk.byteLength
    }
    return all
  }
  return { stream, result: () => ({ bytes, scannedPdf: pdf && !fonts && !objectStreams, kept: kept() }) }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A file id: from preflight, 8 to 64 of [A-Za-z0-9_-]. */
export const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/
