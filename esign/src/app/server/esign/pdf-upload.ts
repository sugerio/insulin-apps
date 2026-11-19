/**
 * An uploaded PDF, made ready for placed fields (fields.ts `validateFieldsPdf`): the envelope upload, the template
 * upload and the editor's own uploads all go through `preparePdfUpload`.
 *
 * Placed fields are drawn into the page content, with coordinates measured from the displayed page's top-left. So a
 * stored PDF has no form and no annotations (they would sit above a signature, and a form's values can change after
 * signing), and its pages are unrotated with the media box at the origin and no crop. Most PDFs that break these rules
 * can be rewritten into ones that keep them and look the same, the way other e-signature services flatten what they are
 * given:
 *
 * - every annotation that has an appearance (form fields, comments, highlights, stamps, links with one) is drawn into
 *   the page content where the viewer draws it (ISO 32000-1, 12.5.5), and the form and the annotations are removed.
 *   Links and pop-ups without an appearance are removed (the link's text stays, it no longer opens anything);
 * - a rotated, cropped or offset page gets its content wrapped in a transform that draws it as the viewer shows it, on
 *   a page of the visible size at the origin.
 *
 * A PDF this can't make ready is refused with the reason (`PdfUploadRefused`): encrypted, unreadable, too many pages,
 * a dynamic (XFA) form, an annotation or form whose look the viewer would make up itself, or pages in other units or of
 * an unsupported size. A PDF that keeps the rules already is stored as it came, byte for byte.
 *
 * Every refusal and every rewrite is logged with what it found, never the document's content or name, so a format
 * problem can be diagnosed from the logs (`logPdfUpload`).
 */
import {
  clip, concatTransformationMatrix, degrees, drawObject, endPath, PDFArray, PDFBool, PDFContentStream,
  PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFOperator, PDFOperatorNames, type PDFPage, PDFRef, PDFWriter, PDFStream, PDFString,
  popGraphicsState, pushGraphicsState, rectangle, setGraphicsState,
} from 'pdf-lib';
import type { UploadChanges } from '../../lib/upload-changes.ts';
import { validateFieldsPdf } from './fields.ts';

export const MAX_UPLOAD_PAGES = 100;
/** The largest side a page may have, in points (fields.ts `validateFieldsPdf`). */
export const MAX_PAGE_SIDE = 14400;
/** The most annotations (counted where they are named: a repeat or a shared list counts again) Esign flattens. */
const MAX_ANNOTATIONS = 10_000;
/** The most content-stream entries copied when pages that share a content list get their own (`ownContents`). */
const MAX_COPIED_CONTENTS = 100_000;

/** The largest PDF Esign stores and reads back (envelope-documents.ts, editor-routes.ts, app.ts): a rewrite must fit too. */
export const MAX_STORED_PDF_BYTES = 5 * 1024 * 1024;
/**
 * Refusals that matter only to placed fields: a template uploaded through the API, signed on a page Esign adds, keeps
 * such a PDF as it came (`keepUnprepared`), as it did before uploads were prepared.
 */
const ONLY_FOR_PLACED_FIELDS: ReadonlySet<PdfRefusal> = new Set<PdfRefusal>(['pdf_dynamic_form', 'pdf_form_without_appearance', 'pdf_annotation_without_appearance', 'pdf_page_units', 'pdf_page_size', 'pdf_page_rotation', 'pdf_too_large', 'pdf_unsupported']);

/** Why an uploaded PDF was refused: each is an API error code. */
export const PDF_REFUSALS = [
  'pdf_encrypted', 'pdf_unreadable', 'pdf_page_count', 'pdf_dynamic_form', 'pdf_form_without_appearance',
  'pdf_annotation_without_appearance', 'pdf_page_units', 'pdf_page_size', 'pdf_page_rotation', 'pdf_too_large', 'pdf_unsupported',
] as const;
export type PdfRefusal = typeof PDF_REFUSALS[number];
export const isPdfRefusal = (code: unknown): code is PdfRefusal => PDF_REFUSALS.includes(code as PdfRefusal);

/** What was found, for the log and the refusal: numbers, booleans and short ASCII names, never document text. */
export type PdfFacts = Record<string, string | number | boolean>;

export class PdfUploadRefused extends Error {
  readonly code: PdfRefusal;
  readonly facts: PdfFacts;
  constructor(code: PdfRefusal, facts: PdfFacts = {}) { super(code); this.name = 'PdfUploadRefused'; this.code = code; this.facts = facts; }
}

/** What preparing an upload changed: how many of each were flattened or removed, and how many pages were reoriented. */
export type PdfUploadChanges = UploadChanges;

export type PreparedPdf = {
  /** The bytes to store: the upload itself when nothing had to change. */
  bytes: Uint8Array<ArrayBuffer>;
  pages: number;
  sha256: string;
  /** The SHA-256 of the file as uploaded; the same as `sha256` when nothing changed. */
  uploadedSha256: string;
  /** What was changed, or null when the upload was stored as it came. */
  changes: PdfUploadChanges | null;
};

/** Where an upload came from, for the log. */
export type PdfUploadSource = { route: 'envelope-document' | 'template' | 'editor-source' | 'editor-save'; tenantId: string; subjectId?: string };

const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), (n) => n.toString(16).padStart(2, '0')).join('');

/** Printable ASCII, at most `max` characters: for names the log may keep (a producer, an annotation subtype). */
const ascii = (value: string | undefined, max = 80) => (value ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/**
 * The software that made a PDF, for the log: one of a fixed list of names, else 'other' ('' when none is given). The
 * file's own /Producer and /Creator are the author's to write, and can carry names, addresses or paths: never logged.
 */
const SOFTWARE: [RegExp, string][] = [
  [/microsoft.*word|word for/i, 'Microsoft Word'], [/microsoft.*excel/i, 'Microsoft Excel'], [/microsoft.*powerpoint/i, 'Microsoft PowerPoint'],
  [/microsoft.*print to pdf/i, 'Microsoft Print to PDF'], [/libreoffice/i, 'LibreOffice'], [/openoffice/i, 'OpenOffice'],
  [/acrobat distiller/i, 'Adobe Acrobat Distiller'], [/acrobat/i, 'Adobe Acrobat'], [/adobe pdf library/i, 'Adobe PDF Library'],
  [/indesign/i, 'Adobe InDesign'], [/illustrator/i, 'Adobe Illustrator'], [/photoshop/i, 'Adobe Photoshop'],
  [/google docs/i, 'Google Docs'], [/skia/i, 'Skia (Chrome)'], [/quartz|mac os x|macos/i, 'Apple Quartz'], [/pages/i, 'Apple Pages'],
  [/pdf-lib/i, 'pdf-lib'], [/itext/i, 'iText'], [/pdfkit/i, 'PDFKit'], [/wkhtmltopdf/i, 'wkhtmltopdf'], [/ghostscript/i, 'Ghostscript'],
  [/pdfsharp/i, 'PDFsharp'], [/reportlab/i, 'ReportLab'], [/tcpdf/i, 'TCPDF'], [/foxit/i, 'Foxit'], [/nitro/i, 'Nitro'],
  [/docusign/i, 'DocuSign'], [/prince/i, 'Prince'], [/pdfium/i, 'PDFium'], [/cairo/i, 'cairo'], [/apache fop/i, 'Apache FOP'],
  [/pscript/i, 'PScript'], [/canva/i, 'Canva'], [/latex|pdftex|xetex|luatex/i, 'TeX'], [/qt\b/i, 'Qt'],
];
// Matched on the first 200 characters: a name is short, and the patterns' backtracking grows with the length.
const softwareName = (value: string | undefined) => !value ? '' : (SOFTWARE.find(([pattern]) => pattern.test(value.slice(0, 200)))?.[1] ?? 'other');

/** The header's version (`1.7`), or '' when the file doesn't start with one. */
const headerVersion = (bytes: Uint8Array) => /^%PDF-(\d\.\d)/.exec(new TextDecoder('latin1').decode(bytes.slice(0, 16)))?.[1] ?? '';

/** Logs what an upload was: refused (warn) or rewritten (info). Uploads stored as they came are not logged. */
export function logPdfUpload(source: PdfUploadSource, outcome: { refused: PdfRefusal; facts: PdfFacts } | { kept: PdfRefusal; facts: PdfFacts } | { changes: PdfUploadChanges; facts: PdfFacts }): void {
  if ('refused' in outcome) console.warn('Esign: an uploaded PDF was refused', { ...source, code: outcome.refused, ...outcome.facts });
  else if ('kept' in outcome) console.info('Esign: an uploaded PDF could not be prepared for placed fields and was kept as uploaded', { ...source, code: outcome.kept, ...outcome.facts });
  else console.info('Esign: an uploaded PDF was flattened or reoriented before it was stored', { ...source, ...outcome.changes, ...outcome.facts });
}

/**
 * The upload, ready to store; or `PdfUploadRefused`. Logs a refusal or a rewrite, with `source`. The caller has checked
 * the size and the `%PDF-` header. With `keepUnprepared`, a PDF refused only for placed fields is returned as it came,
 * unchanged (`changes` null), for a template signed on an added page.
 */
export async function preparePdfUpload(bytes: Uint8Array<ArrayBuffer>, source: PdfUploadSource, { keepUnprepared = false }: { keepUnprepared?: boolean } = {}): Promise<PreparedPdf> {
  const uploadedSha256 = await sha256(bytes);
  const base: PdfFacts = { bytes: bytes.length, sha256: uploadedSha256, version: headerVersion(bytes) };
  try {
    const prepared = await prepare(bytes, base);
    if (prepared.changes) logPdfUpload(source, { changes: prepared.changes, facts: base });
    return { ...prepared, uploadedSha256, sha256: prepared.changes ? await sha256(prepared.bytes) : uploadedSha256 };
  } catch (error) {
    const refused = error instanceof PdfUploadRefused ? error : new PdfUploadRefused('pdf_unsupported', { error: ascii(error instanceof Error ? `${error.name}: ${error.message}` : typeof error, 200) });
    if (keepUnprepared && ONLY_FOR_PLACED_FIELDS.has(refused.code) && typeof base.pages === 'number') {
      logPdfUpload(source, { kept: refused.code, facts: { ...base, ...refused.facts } });
      return { bytes, pages: base.pages, sha256: uploadedSha256, uploadedSha256, changes: null };
    }
    logPdfUpload(source, { refused: refused.code, facts: { ...base, ...refused.facts } });
    throw refused;
  }
}

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false });

async function prepare(bytes: Uint8Array<ArrayBuffer>, facts: PdfFacts): Promise<{ bytes: Uint8Array<ArrayBuffer>; pages: number; changes: PdfUploadChanges | null }> {
  let pdf: PDFDocument, pages: PDFPage[];
  try {
    // Read even when encrypted, only to tell that it is (pdf-lib can't decrypt; its own error isn't an instanceof).
    pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false, ignoreEncryption: true });
    if (pdf.isEncrypted) throw new PdfUploadRefused('pdf_encrypted');
    pages = pdf.getPages();
  } catch (error) {
    if (error instanceof PdfUploadRefused) throw error;
    throw new PdfUploadRefused('pdf_unreadable', { error: ascii(error instanceof Error ? `${error.name}: ${error.message}` : typeof error, 200) });
  }
  facts.pages = pages.length;
  try { facts.producer = softwareName(pdf.getProducer()); facts.creator = softwareName(pdf.getCreator()); } catch { /* an odd info dictionary is no reason to refuse */ }
  if (!pages.length || pages.length > MAX_UPLOAD_PAGES) throw new PdfUploadRefused('pdf_page_count');

  const changes: PdfUploadChanges = { formFields: 0, annotations: 0, links: 0, pages: 0 };
  const form = entry(pdf, pdf.catalog, 'AcroForm', PDFDict);
  if (form) {
    if (form.get(PDFName.of('XFA'))) throw new PdfUploadRefused('pdf_dynamic_form');
    // The viewer is asked to draw the fields' values itself: the appearances the file has may not show them. A blank
    // form has no value to draw, so its appearances are what the viewer shows.
    const fields = entry(pdf, form, 'Fields', PDFArray);
    if (fields && entry(pdf, form, 'NeedAppearances', PDFBool)?.asBoolean() && anyFieldHasValue(pdf, fields)) throw new PdfUploadRefused('pdf_form_without_appearance');
  }
  // Each annotation costs work and memory to flatten, and a few bytes can name one many times over.
  const annotations = pages.reduce((sum, page) => sum + (entry(pdf, page.node, 'Annots', PDFArray)?.size() ?? 0), 0);
  if (annotations > MAX_ANNOTATIONS) throw new PdfUploadRefused('pdf_unsupported', { annotations });
  // Pages may share one content list: a page gets its own just before anything is added to it or wrapped around it.
  const copied = { entries: 0 };
  // Any annotation removed is a change, even one not counted (a pop-up, an entry that isn't an annotation).
  let removed = false;
  pages.forEach((page, index) => { if (flattenAnnotations(pdf, page, index + 1, changes, copied)) removed = true; });
  if (form) pdf.catalog.delete(PDFName.of('AcroForm'));
  pages.forEach((page, index) => { if (reorient(pdf, page, index + 1, copied)) changes.pages++; });
  // Pages still sharing one content list get one each: signing draws on a page by adding to its list, which would
  // draw on every page sharing it too.
  const lists = new Map<PDFRef, number>();
  for (const page of pages) {
    const raw = page.node.get(PDFName.of('Contents'));
    if (raw instanceof PDFRef && pdf.context.lookup(raw) instanceof PDFArray) lists.set(raw, (lists.get(raw) ?? 0) + 1);
  }
  for (const page of pages) {
    const raw = page.node.get(PDFName.of('Contents'));
    if (raw instanceof PDFRef && (lists.get(raw) ?? 0) > 1) { ownContents(pdf, page, copied); removed = true; }
  }

  const changed = Boolean(form) || removed || changes.formFields + changes.annotations + changes.links + changes.pages > 0;
  if (!changed) {
    // Nothing to rewrite: the upload is stored as it came, once it keeps the rules.
    try { validateFieldsPdf(pdf); } catch (error) { throw new PdfUploadRefused('pdf_unsupported', { error: ascii(error instanceof Error ? error.message : typeof error) }); }
    return { bytes, pages: pages.length, changes: null };
  }
  // Written out in full, a PDF can grow past what Esign reads back (its compressed object streams are expanded), and
  // far past what a Worker can hold: the size pdf-lib's writer will need is known before it builds the output.
  await pdf.flush();
  const writer = PDFWriter.forContext(pdf.context, 50) as unknown as { computeBufferSize(): Promise<{ size: number }> };
  const { size } = await writer.computeBufferSize();
  if (size > MAX_STORED_PDF_BYTES) throw new PdfUploadRefused('pdf_too_large', { rewrittenBytes: size });
  const output = await pdf.save({ useObjectStreams: false });
  if (output.length > MAX_STORED_PDF_BYTES) throw new PdfUploadRefused('pdf_too_large', { rewrittenBytes: output.length });
  // What is stored is read back the way signing reads it, and must keep the rules.
  try {
    const stored = await load(output);
    if (stored.getPageCount() !== pages.length) throw new Error('Page count changed');
    validateFieldsPdf(stored);
  } catch (error) { throw new PdfUploadRefused('pdf_unsupported', { stage: 'rewritten', error: ascii(error instanceof Error ? error.message : typeof error) }); }
  return { bytes: output as Uint8Array<ArrayBuffer>, pages: pages.length, changes };
}

/** A dictionary entry of the given type, or undefined when it is missing or of another type (never a throw). */
function entry<T extends PDFObject>(pdf: PDFDocument, dict: PDFDict, key: string, type: Function & { prototype: T }): T | undefined {
  const value = pdf.context.lookup(dict.get(PDFName.of(key)));
  return value instanceof type ? value as T : undefined;
}

type Box = { x: number; y: number; width: number; height: number };

/** A rectangle array ([x1 y1 x2 y2], corners in any order) as a box, or null when it isn't four finite numbers. */
function boxOf(pdf: PDFDocument, value: unknown): Box | null {
  if (!(value instanceof PDFArray) || value.size() !== 4) return null;
  const n = value.asArray().map((item) => { const v = pdf.context.lookup(item); return v instanceof PDFNumber ? v.asNumber() : NaN; });
  if (!n.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = n as [number, number, number, number];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

const ANNOTATION_HIDDEN = 1 << 1, ANNOTATION_NO_VIEW = 1 << 5;
/** The annotation subtypes ISO 32000 names: the log says one of these, else 'other' (the file's own name is never logged). */
const ANNOTATION_SUBTYPES = new Set(['Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Movie', 'Widget', 'Screen', 'PrinterMark', 'TrapNet', 'Watermark', '3D', 'Redact', 'Projection', 'RichMedia']);
const subtypeName = (subtype: string) => (ANNOTATION_SUBTYPES.has(subtype) ? subtype : subtype ? 'other' : '');
/**
 * An annotation's subtype, one of ANNOTATION_SUBTYPES, 'other' or ''. pdf-lib keeps one PDFName per name, so a standard
 * subtype is found by the object itself, never by decoding a name the file may make arbitrarily long.
 */
const SUBTYPES_BY_NAME = new Map([...ANNOTATION_SUBTYPES].map((subtype) => [PDFName.of(subtype), subtype]));
const subtypeOf = (pdf: PDFDocument, annot: PDFDict) => { const name = entry(pdf, annot, 'Subtype', PDFName); return name ? SUBTYPES_BY_NAME.get(name) ?? 'other' : ''; };

/**
 * Draws each annotation's normal appearance into the page content where a viewer draws it, then removes the page's
 * annotations; true when it removed any. Refuses an annotation the viewer shows but that has no appearance of its own:
 * the viewer would make up its look, and the flattened page couldn't match it.
 */
function flattenAnnotations(pdf: PDFDocument, page: PDFPage, number: number, changes: PdfUploadChanges, copied: { entries: number }): boolean {
  const annots = entry(pdf, page.node, 'Annots', PDFArray);
  // Not a list (or none): nothing a viewer shows, and validateFieldsPdf reads none either.
  if (!annots) return false;
  const operators: PDFOperator[] = [];
  // What this page's drawings are named, once each: an appearance, an opacity, an optional-content condition.
  let names: { xobjects: PDFDict; states: PDFDict; properties: PDFDict; byAppearance: Map<PDFRef, PDFName>; byOpacity: Map<number, PDFName>; byCondition: Map<PDFRef, PDFName> } | null = null;
  for (let i = 0; i < annots.size(); i++) {
    const annot = pdf.context.lookup(annots.get(i));
    if (!(annot instanceof PDFDict)) continue;
    const subtype = subtypeOf(pdf, annot);
    const count = () => { if (subtype === 'Widget') changes.formFields++; else if (subtype === 'Link') changes.links++; else changes.annotations++; };
    const flags = entry(pdf, annot, 'F', PDFNumber)?.asNumber() ?? 0;
    // Not shown: removed, nothing to draw. A pop-up is the window a comment opens; its comment is drawn.
    if (flags & (ANNOTATION_HIDDEN | ANNOTATION_NO_VIEW) || subtype === 'Popup') { if (subtype !== 'Popup') count(); continue; }
    const appearance = normalAppearance(pdf, annot);
    if (appearance === 'none') {
      if (subtype === 'Link') { changes.links++; continue; }
      // An empty form field with no look of its own shows nothing (a blank form often has them).
      if (subtype === 'Widget' && !hasValue(pdf, annot)) { changes.formFields++; continue; }
      throw new PdfUploadRefused(subtype === 'Widget' ? 'pdf_form_without_appearance' : 'pdf_annotation_without_appearance', { page: number, subtype: subtypeName(subtype) });
    }
    count();
    // A state with no appearance (an unchecked box with no "Off" look) shows nothing.
    if (appearance === 'empty') continue;
    const rect = boxOf(pdf, pdf.context.lookup(annot.get(PDFName.of('Rect'))));
    const stream = pdf.context.lookup(appearance, PDFStream);
    const bbox = boxOf(pdf, pdf.context.lookup(stream.dict.get(PDFName.of('BBox'))));
    if (!rect || !bbox) throw new PdfUploadRefused('pdf_annotation_without_appearance', { page: number, subtype: subtypeName(subtype), reason: 'geometry' });
    const placed = placement(bbox, matrixOf(pdf, pdf.context.lookup(stream.dict.get(PDFName.of('Matrix')))), rect);
    if (!placed) continue;
    stream.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    stream.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    if (!names) {
      // The page is normalized to name its resources, which wraps its content list: its own list first.
      ownContents(pdf, page, copied);
      const { Resources, XObject, ExtGState } = normalizePage(pdf, page);
      let properties = entry(pdf, Resources, 'Properties', PDFDict);
      if (!properties) { properties = pdf.context.obj({}); Resources.set(PDFName.of('Properties'), properties); }
      names = { xobjects: XObject, states: ExtGState, properties, byAppearance: new Map(), byOpacity: new Map(), byCondition: new Map() };
    }
    const named = names;
    const name = remember(named.byAppearance, appearance, () => freshName(named.xobjects, 'FlatAnnot', appearance));
    // Shown only where its optional content (a layer) is: the condition goes with the drawing, as marked content.
    const raw = annot.get(PDFName.of('OC')), resolved = pdf.context.lookup(raw);
    const condition = resolved instanceof PDFDict ? (raw instanceof PDFRef ? raw : remember(registered, resolved, () => pdf.context.register(resolved))) : null;
    if (condition) operators.push(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), remember(named.byCondition, condition, () => freshName(named.properties, 'FlatAnnotOC', condition))]));
    operators.push(pushGraphicsState());
    // A comment's constant opacity is the annotation's, not its appearance's: the viewer applies it on top.
    const opacity = entry(pdf, annot, 'CA', PDFNumber)?.asNumber();
    if (opacity !== undefined && Number.isFinite(opacity) && opacity >= 0 && opacity < 1) {
      operators.push(setGraphicsState(remember(named.byOpacity, opacity, () => freshName(named.states, 'FlatAnnotGS', pdf.context.register(pdf.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity }))))));
    }
    operators.push(concatTransformationMatrix(...placed), drawObject(name), popGraphicsState());
    if (condition) operators.push(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  }
  // One at a time: spreading tens of thousands of operators into one call overflows the stack.
  for (const operator of operators) page.pushOperators(operator);
  page.node.delete(PDFName.of('Annots'));
  return annots.size() > 0;
}

const remember = <K extends object | number, V>(map: { get(key: K): V | undefined; set(key: K, value: V): unknown }, key: K, make: () => V): V => { let value = map.get(key); if (value === undefined) { value = make(); map.set(key, value); } return value; };

/**
 * Adds `value` to a resource dictionary under a new name: `prefix` and the next number not taken. Each dictionary's
 * count goes on from where it stopped, so the names it already has are passed over once in all, however many there are
 * (pdf-lib's own newXObject copies and searches every name each time).
 */
const nextNumber = new WeakMap<PDFDict, number>();
function freshName(dict: PDFDict, prefix: string, value: PDFRef): PDFName {
  for (let n = nextNumber.get(dict) ?? 1; ; n++) {
    const name = PDFName.of(`${prefix}${n}`);
    if (dict.get(name) === undefined) { dict.set(name, value); nextNumber.set(dict, n + 1); return name; }
  }
}

/**
 * Normalizes the page (its content list wrapped, its resource dictionaries made), keeping its resources where they are:
 * pdf-lib's normalize() puts the resolved /Resources dictionary on the page itself, so every page that shared one would
 * be saved with a full copy. A shared dictionary stays one object, named by reference.
 */
/**
 * An object written inside another (a direct resources dictionary, appearance stream or layer condition) gets one
 * reference per document, however many times it is met: registered anew each time, it would be saved each time.
 */
const registered = new WeakMap<PDFDict, PDFRef>(), registeredStreams = new WeakMap<PDFStream, PDFRef>();
const RESOURCE_LISTS = ['Font', 'XObject', 'ExtGState'].map((key) => PDFName.of(key));
function normalizePage(pdf: PDFDocument, page: PDFPage) {
  const own = page.node.get(PDFName.of('Resources')), raw = own ?? page.node.getInheritableAttribute(PDFName.of('Resources'));
  // normalize() also puts the font, image and graphics-state lists themselves into the resources: they keep their
  // references too, so pages with resources of their own that share one list still save it once.
  const resources = pdf.context.lookup(raw);
  const lists = resources instanceof PDFDict ? RESOURCE_LISTS.map((key) => [key, resources.get(key)] as const).filter(([, ref]) => ref instanceof PDFRef && pdf.context.lookup(ref) instanceof PDFDict) : [];
  page.node.normalize();
  for (const [key, ref] of lists) (resources as PDFDict).set(key, ref!);
  if (raw instanceof PDFRef) page.node.set(PDFName.of('Resources'), raw);
  else if (raw instanceof PDFDict && own === undefined) page.node.set(PDFName.of('Resources'), remember(registered, raw, () => pdf.context.register(raw)));
  return page.node.normalizedEntries();
}

/**
 * Gives the page a content array of its own when it names one other pages may name too (an indirect array), before it
 * is changed. At most MAX_COPIED_CONTENTS entries are copied in all: a short file can name a long list on every page.
 */
function ownContents(pdf: PDFDocument, page: PDFPage, copied: { entries: number }): void {
  const raw = page.node.get(PDFName.of('Contents'));
  const contents = pdf.context.lookup(raw);
  if (!(raw instanceof PDFRef && contents instanceof PDFArray)) return;
  if ((copied.entries += contents.size()) > MAX_COPIED_CONTENTS) throw new PdfUploadRefused('pdf_unsupported', { contents: copied.entries });
  page.node.set(PDFName.of('Contents'), pdf.context.obj(contents.asArray()));
}

/** The most entries of field lists `anyFieldHasValue` reads; a form past it is taken to hold a value (refused). */
const MAX_FORM_ENTRIES = 100_000;

/**
 * Whether any field of the form, down its kids, holds a value a viewer would show. Each field and each list of kids is
 * read once, however many times it is named (a form can name the same kids at every level, from many fields, or itself),
 * and at most MAX_FORM_ENTRIES list entries in all.
 */
function anyFieldHasValue(pdf: PDFDocument, fields: PDFArray): boolean {
  const seen = new Set<PDFDict>(), lists = new Set<PDFArray>([fields]), pending: PDFArray[] = [fields];
  let read = 0;
  for (let list = pending.pop(); list; list = pending.pop()) {
    if ((read += list.size()) > MAX_FORM_ENTRIES) return true;
    for (let i = 0; i < list.size(); i++) {
      const field = pdf.context.lookup(list.get(i));
      if (!(field instanceof PDFDict) || seen.has(field)) continue;
      seen.add(field);
      if (field.get(PDFName.of('V')) !== undefined && hasValue(pdf, field)) return true;
      const kids = entry(pdf, field, 'Kids', PDFArray);
      if (kids && !lists.has(kids)) { lists.add(kids); pending.push(kids); }
    }
  }
  return false;
}

/** Whether a form field's widget (or the field it belongs to, up its parents) holds a value a viewer would show. */
const valued = new WeakMap<PDFDict, boolean>(), nonEmpty = new WeakMap<PDFString | PDFHexString, boolean>();
function hasValue(pdf: PDFDocument, widget: PDFDict): boolean {
  // Read once per field, however many times it is named: a value can be slow to read (escapes) yet empty.
  return remember(valued, widget, () => readValue(pdf, widget));
}
const OFF = PDFName.of('Off');
function readValue(pdf: PDFDocument, widget: PDFDict): boolean {
  let node: PDFDict | undefined = widget;
  for (let depth = 0; node && depth < 32; depth++) {
    const value = pdf.context.lookup(node.get(PDFName.of('V')));
    if (value !== undefined) {
      if (value instanceof PDFName) return value !== OFF;
      if (value instanceof PDFArray) return value.size() > 0;
      // Read once per value object: many fields can share one, directly or through their parent.
      if (value instanceof PDFString || value instanceof PDFHexString) return remember(nonEmpty, value, () => value.decodeText() !== '');
      return true;
    }
    node = entry(pdf, node, 'Parent', PDFDict);
  }
  return false;
}

/**
 * The annotation's normal appearance stream: a reference, 'empty' when its state has none (nothing is shown), or
 * 'none' when the annotation has no appearance at all.
 */
function normalAppearance(pdf: PDFDocument, annot: PDFDict): PDFRef | 'empty' | 'none' {
  const ap = entry(pdf, annot, 'AP', PDFDict);
  const raw = ap?.get(PDFName.of('N'));
  if (!ap || !raw) return 'none';
  const ref = (value: unknown): PDFRef | null => {
    if (value instanceof PDFRef) return pdf.context.lookup(value) instanceof PDFStream ? value : null;
    // A direct stream breaks the format, but a viewer still draws it.
    return value instanceof PDFStream ? remember(registeredStreams, value, () => pdf.context.register(value)) : null;
  };
  const direct = ref(raw);
  if (direct) return direct;
  const states = pdf.context.lookup(raw);
  if (!(states instanceof PDFDict)) return 'none';
  const state = entry(pdf, annot, 'AS', PDFName);
  return (state && ref(states.get(state))) ?? 'empty';
}

type Matrix = [number, number, number, number, number, number];

function matrixOf(pdf: PDFDocument, value: unknown): Matrix {
  if (value instanceof PDFArray && value.size() === 6) {
    const n = value.asArray().map((item) => { const v = pdf.context.lookup(item); return v instanceof PDFNumber ? v.asNumber() : NaN; });
    if (n.every(Number.isFinite)) return n as Matrix;
  }
  return [1, 0, 0, 1, 0, 0];
}

/**
 * ISO 32000-1, 12.5.5: the appearance's bounding box, transformed by its matrix, is fitted to the annotation's
 * rectangle. The matrix that does it, or null when the appearance has no area.
 */
function placement(bbox: Box, [a, b, c, d, e, f]: Matrix, rect: Box): Matrix | null {
  const corners = [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x, bbox.y + bbox.height], [bbox.x + bbox.width, bbox.y + bbox.height]]
    .map(([x, y]) => [a * x! + c * y! + e, b * x! + d * y! + f] as const);
  const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y);
  const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
  if (!(width > 0) || !(height > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
  const sx = rect.width / width, sy = rect.height / height;
  return [sx, 0, 0, sy, rect.x - minX * sx, rect.y - minY * sy];
}

/**
 * Makes the page unrotated, with its media box at the origin, the size of what the viewer shows (the crop box within
 * the media box), and no other boxes: its content is clipped to what was visible and drawn turned as the viewer turned
 * it. True when the page changed.
 */
function reorient(pdf: PDFDocument, page: PDFPage, number: number, copied: { entries: number }): boolean {
  const unit = entry(pdf, page.node, 'UserUnit', PDFNumber)?.asNumber();
  if (unit !== undefined && unit !== 1) throw new PdfUploadRefused('pdf_page_units', { page: number, userUnit: unit });
  const media = boxOf(pdf, pdf.context.lookup(page.node.MediaBox())), crop = boxOf(pdf, pdf.context.lookup(page.node.CropBox())) ?? media;
  if (!media || !crop) throw new PdfUploadRefused('pdf_page_size', { page: number, reason: 'box' });
  // What the viewer shows: the crop box, clipped to the media box.
  const x = Math.max(media.x, crop.x), y = Math.max(media.y, crop.y);
  const visible = { x, y, width: Math.min(media.x + media.width, crop.x + crop.width) - x, height: Math.min(media.y + media.height, crop.y + crop.height) - y };
  const angle = page.getRotation().angle, rotation = ((angle % 360) + 360) % 360;
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new PdfUploadRefused('pdf_page_rotation', { page: number, rotate: angle });
  if (!(visible.width > 0) || !(visible.height > 0) || visible.width > MAX_PAGE_SIDE || visible.height > MAX_PAGE_SIDE) {
    throw new PdfUploadRefused('pdf_page_size', { page: number, width: Math.round(visible.width), height: Math.round(visible.height) });
  }
  const canonical = rotation === 0 && visible.x === 0 && visible.y === 0 && media.x === 0 && media.y === 0
    && visible.width === media.width && visible.height === media.height && crop.width === media.width && crop.height === media.height
    && crop.x === media.x && crop.y === media.y && unit === undefined;
  if (canonical) return false;
  const { width: w, height: h } = visible;
  // Turned clockwise by the page's rotation, as the viewer shows it (ISO 32000-1, 7.7.3.3 /Rotate).
  const turn: Record<number, Matrix> = { 0: [1, 0, 0, 1, 0, 0], 90: [0, -1, 1, 0, 0, w], 180: [-1, 0, 0, -1, w, h], 270: [0, 1, -1, 0, h, 0] };
  const [width, height] = rotation === 90 || rotation === 270 ? [h, w] : [w, h];
  ownContents(pdf, page, copied);
  normalizePage(pdf, page);
  const contents = page.node.Contents();
  if (contents) {
    const start = PDFContentStream.of(pdf.context.obj({}), [
      pushGraphicsState(), concatTransformationMatrix(...turn[rotation]!), concatTransformationMatrix(1, 0, 0, 1, -visible.x, -visible.y),
      rectangle(visible.x, visible.y, w, h), clip(), endPath(),
    ]);
    const end = PDFContentStream.of(pdf.context.obj({}), [popGraphicsState()]);
    page.node.wrapContentStreams(pdf.context.register(start), pdf.context.register(end));
  }
  // normalize() gave the page an empty annotation list; its annotations were flattened before.
  page.node.delete(PDFName.of('Annots'));
  page.setMediaBox(0, 0, width, height);
  page.setCropBox(0, 0, width, height);
  page.setRotation(degrees(0));
  for (const name of ['BleedBox', 'TrimBox', 'ArtBox', 'UserUnit']) page.node.delete(PDFName.of(name));
  return true;
}

/**
 * A refused upload's response body: the route's own error code (kept, for clients that read it), the reason, and the
 * page it is on when one page is the reason.
 */
export const pdfRefusalBody = (error: string, refused: PdfUploadRefused) => ({
  error, reason: refused.code, ...(typeof refused.facts.page === 'number' ? { page: refused.facts.page } : {}),
});

/** What is stored about an upload that was changed: `[uploaded_sha256, upload_changes_json]`, both null when it wasn't. */
export const uploadRecord = (prepared: PreparedPdf): [string | null, string | null] =>
  prepared.changes ? [prepared.uploadedSha256, JSON.stringify(prepared.changes)] : [null, null];

/** A stored `upload_changes_json`, or null when there is none or it isn't one. */
export function parseUploadChanges(json: string | null | undefined): PdfUploadChanges | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const keys = ['formFields', 'annotations', 'links', 'pages'] as const;
    return keys.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) ? Object.fromEntries(keys.map((key) => [key, value[key]])) as PdfUploadChanges : null;
  } catch { return null; }
}
