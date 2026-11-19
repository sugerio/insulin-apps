import { test } from 'node:test';
import assert from 'node:assert/strict';
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { strictPdfOptions } from '../src/app/ui/pdf.ts';
import { validateFieldsPdf } from '../src/app/server/esign/fields.ts';
import { preparePdfUpload, PdfUploadRefused, type PdfUploadSource } from '../src/app/server/esign/pdf-upload.ts';
import { describePdfRefusal, describeUploadChanges } from '../src/app/lib/upload-changes.ts';

const source: PdfUploadSource = { route: 'envelope-document', tenantId: 'org-test', subjectId: 'env-test' };

/** Runs `fn` with console.info and console.warn captured. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logs: { level: string; args: unknown[] }[] }> {
  const logs: { level: string; args: unknown[] }[] = [], info = console.info, warn = console.warn;
  console.info = (...args: unknown[]) => { logs.push({ level: 'info', args }); };
  console.warn = (...args: unknown[]) => { logs.push({ level: 'warn', args }); };
  try { return { result: await fn(), logs }; } catch (error) { return { error, logs }; } finally { console.info = info; console.warn = warn; }
}

async function prepare(bytes: Uint8Array) {
  const run = await quietly(() => preparePdfUpload(Uint8Array.from(bytes), source));
  if (run.error) throw run.error;
  return { ...run.result!, logs: run.logs };
}

async function refusal(bytes: Uint8Array) {
  const run = await quietly(() => preparePdfUpload(Uint8Array.from(bytes), source));
  assert.ok(run.error instanceof PdfUploadRefused, `expected a refusal, got ${String(run.error ?? 'success')}`);
  return { code: run.error.code, facts: run.error.facts, logs: run.logs };
}

/** Each text run's origin on the page as PDF.js shows it (viewport coordinates, top-left origin), rounded. */
async function shownText(bytes: Uint8Array): Promise<{ text: string; x: number; y: number }[][]> {
  const doc = await getDocument(strictPdfOptions(Uint8Array.from(bytes))).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push(content.items.flatMap((item) => {
        if (!('str' in item) || !item.str.trim()) return [];
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        return [{ text: item.str, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }];
      }));
    }
    return pages;
  } finally { await doc.destroy(); }
}

async function viewportSizes(bytes: Uint8Array) {
  const doc = await getDocument(strictPdfOptions(Uint8Array.from(bytes))).promise;
  try {
    const sizes = [];
    for (let n = 1; n <= doc.numPages; n++) { const v = (await doc.getPage(n)).getViewport({ scale: 1 }); sizes.push([Math.round(v.width), Math.round(v.height)]); }
    return sizes;
  } finally { await doc.destroy(); }
}

/** A page with a word at each corner and one in the middle, so any turn or shift shows. */
async function markedPage(pdf: PDFDocument, size: [number, number] = [612, 792]) {
  const font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage(size);
  const [w, h] = size;
  for (const [text, x, y] of [['BottomLeft', 20, 20], ['TopLeft', 20, h - 40], ['TopRight', w - 140, h - 40], ['BottomRight', w - 140, 20], ['Middle', w / 2, h / 2]] as const) {
    page.drawText(text, { x, y, size: 12, font });
  }
  return page;
}

test('a PDF that keeps the rules is stored as it came, byte for byte, and nothing is logged', async () => {
  const pdf = await PDFDocument.create();
  await markedPage(pdf);
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.equal(prepared.changes, null);
  assert.deepEqual(prepared.bytes, Uint8Array.from(bytes));
  assert.equal(prepared.sha256, prepared.uploadedSha256);
  assert.equal(prepared.pages, 1);
  assert.deepEqual(prepared.logs, []);
});

for (const rotation of [90, 180, 270, -90, 450]) {
  test(`a page rotated ${rotation} degrees is redrawn upright and looks the same`, async () => {
    const pdf = await PDFDocument.create();
    (await markedPage(pdf)).setRotation(degrees(rotation));
    await markedPage(pdf);
    const bytes = await pdf.save();
    const prepared = await prepare(bytes);
    assert.deepEqual(prepared.changes, { formFields: 0, annotations: 0, links: 0, pages: 1 });
    assert.notEqual(prepared.sha256, prepared.uploadedSha256);
    validateFieldsPdf(await PDFDocument.load(prepared.bytes));
    assert.deepEqual(await viewportSizes(prepared.bytes), await viewportSizes(bytes));
    assert.deepEqual(await shownText(prepared.bytes), await shownText(bytes));
  });
}

test('a rotation inherited from the page tree is redrawn too', async () => {
  const pdf = await PDFDocument.create();
  await markedPage(pdf);
  pdf.catalog.lookup(PDFName.of('Pages'), PDFDict).set(PDFName.of('Rotate'), pdf.context.obj(90));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.equal(prepared.changes?.pages, 1);
  assert.deepEqual(await shownText(prepared.bytes), await shownText(bytes));
});

test('a cropped page, and one with its media box away from the origin, keep only what was shown, where it was shown', async () => {
  const pdf = await PDFDocument.create();
  const cropped = await markedPage(pdf);
  cropped.setCropBox(10, 10, 500, 700);
  const offset = await markedPage(pdf);
  offset.setMediaBox(-50, -30, 612, 792);
  const both = await markedPage(pdf);
  both.setMediaBox(5, 5, 600, 780);
  both.setCropBox(0, 0, 400, 600);
  both.setRotation(degrees(90));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.equal(prepared.changes?.pages, 3);
  validateFieldsPdf(await PDFDocument.load(prepared.bytes));
  assert.deepEqual(await viewportSizes(prepared.bytes), await viewportSizes(bytes));
  assert.deepEqual(await shownText(prepared.bytes), await shownText(bytes));
  // The text outside the crop box was not shown, and still isn't drawn where it could be seen.
  const page = (await PDFDocument.load(prepared.bytes)).getPage(0);
  assert.deepEqual(page.getMediaBox(), { x: 0, y: 0, width: 500, height: 700 });
});

test('a form is flattened: each field shows its value as before, in the page itself, and the form is gone', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const form = pdf.getForm();
  const name = form.createTextField('applicant.name');
  name.setText('Jane Example');
  name.addToPage(page, { x: 100, y: 500, width: 200, height: 24 });
  const agree = form.createCheckBox('applicant.agree');
  agree.addToPage(page, { x: 100, y: 450, width: 16, height: 16 });
  agree.check();
  const bytes = await pdf.save();
  const before = (await shownText(bytes))[0]!;
  assert.ok(!before.some((item) => item.text.includes('Jane Example')), 'PDF.js text content leaves out form values');

  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 2, annotations: 0, links: 0, pages: 0 });
  const stored = await PDFDocument.load(prepared.bytes);
  validateFieldsPdf(stored);
  assert.equal(stored.catalog.get(PDFName.of('AcroForm')), undefined);
  const value = (await shownText(prepared.bytes))[0]!.find((item) => item.text.includes('Jane Example'));
  assert.ok(value, 'the value is drawn into the page');
  // Inside the field's box, as the viewer showed it (viewport y runs down from the top: 792 - 524 .. 792 - 500).
  assert.ok(value.x >= 100 && value.x <= 300 && value.y >= 268 && value.y <= 292, JSON.stringify(value));
  assert.deepEqual(prepared.logs.map((log) => log.level), ['info']);
});

test('a rewrite is logged with the file\'s page count and, apart, how many pages were redrawn', async () => {
  const pdf = await PDFDocument.create();
  await markedPage(pdf);
  (await markedPage(pdf)).setRotation(degrees(90));
  const prepared = await prepare(await pdf.save());
  assert.equal(prepared.changes?.pages, 1);
  const record = prepared.logs[0]!.args[1] as Record<string, unknown>;
  assert.equal(record.pages, 2, 'the file has two pages');
  assert.equal(record.pagesRedrawn, 1, 'one of them was redrawn upright');
});

test('links without a look of their own are removed, the text they were on stays, and pop-ups go with them', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 120, 34], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/terms') } }));
  const popup = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 300, 400, 400] }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([link, popup]));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 0, annotations: 0, links: 1, pages: 0 });
  const stored = await PDFDocument.load(prepared.bytes);
  assert.equal(stored.getPage(0).node.get(PDFName.of('Annots')), undefined);
  assert.deepEqual(await shownText(prepared.bytes), await shownText(bytes));
});

test('an annotation with an appearance is drawn where the viewer draws it, fitted to its rectangle, with its opacity', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // A stamp whose appearance is drawn at twice the size of its rectangle, away from the origin: it must be fitted.
  const look = pdf.context.register(pdf.context.stream('BT /F1 24 Tf 20 20 Td (APPROVED) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [10, 10, 410, 90], Resources: { Font: { F1: font.ref } },
  }));
  const stamp = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 600, 500, 640], CA: 0.5, AP: { N: look } }));
  const hidden = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', F: 2, Rect: [300, 100, 500, 140], AP: { N: look } }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([stamp, hidden]));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 0, annotations: 2, links: 0, pages: 0 });
  const shown = (await shownText(prepared.bytes))[0]!.filter((item) => item.text === 'APPROVED');
  assert.equal(shown.length, 1, 'the hidden stamp is not drawn');
  // The text starts at (20, 20) in a box from (10, 10), scaled by 0.5 into the rectangle: x = 300 + (20 - 10) * 0.5,
  // y = 600 + (20 - 10) * 0.5 = 605, which is 792 - 605 from the top.
  assert.deepEqual({ x: shown[0]!.x, y: shown[0]!.y }, { x: 305, y: 187 });
  const content = (await PDFDocument.load(prepared.bytes)).getPage(0).node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict);
  assert.ok(content.keys().some((key) => key.decodeText().startsWith('FlatAnnotGS')), 'the stamp keeps its opacity');
});

test('a flattened annotation on a rotated page lands where the viewer showed it', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const form = pdf.getForm(), field = form.createTextField('reviewer');
  field.setText('Sam Sample');
  field.addToPage(page, { x: 200, y: 300, width: 160, height: 24 });
  page.setRotation(degrees(90));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 1, annotations: 0, links: 0, pages: 1 });
  const shown = (await shownText(prepared.bytes))[0]!;
  assert.deepEqual(shown.filter((item) => item.text !== 'Sam Sample'), (await shownText(bytes))[0]);
  // The widget's box, turned with the page: x from 300 to 324 (its y), y from 200 to 360 (its x) from the top.
  const value = shown.find((item) => item.text === 'Sam Sample')!;
  assert.ok(value.x >= 300 && value.x <= 324 && value.y >= 200 && value.y <= 360, JSON.stringify(value));
});

test('refusals name the reason, and are logged with what was found but never the document text', async () => {
  const cases: [string, () => Promise<Uint8Array>][] = [
    ['pdf_unreadable', async () => new TextEncoder().encode('%PDF-1.7\nnot really a PDF')],
    ['pdf_encrypted', async () => {
      const pdf = await PDFDocument.create();
      await markedPage(pdf);
      pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128 }));
      return pdf.save({ useObjectStreams: false });
    }],
    ['pdf_page_count', async () => {
      const pdf = await PDFDocument.create();
      for (let i = 0; i < 101; i++) pdf.addPage([200, 200]);
      return pdf.save();
    }],
    ['pdf_dynamic_form', async () => {
      const pdf = await PDFDocument.create();
      await markedPage(pdf);
      pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [], XFA: pdf.context.register(pdf.context.stream('<xdp:xdp/>')) }));
      return pdf.save();
    }],
    ['pdf_form_without_appearance', async () => {
      const pdf = await PDFDocument.create();
      const page = await markedPage(pdf);
      const field = pdf.getForm().createTextField('secret');
      field.setText('Confidential value');
      field.addToPage(page, { x: 50, y: 50, width: 100, height: 20 });
      pdf.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), pdf.context.obj(true));
      return pdf.save();
    }],
    ['pdf_annotation_without_appearance', async () => {
      const pdf = await PDFDocument.create();
      const page = await markedPage(pdf);
      page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [50, 50, 70, 70], Contents: PDFString.of('Confidential note text') })]));
      return pdf.save();
    }],
    ['pdf_page_units', async () => {
      const pdf = await PDFDocument.create();
      (await markedPage(pdf)).node.set(PDFName.of('UserUnit'), pdf.context.obj(2));
      return pdf.save();
    }],
    ['pdf_page_size', async () => {
      const pdf = await PDFDocument.create();
      await markedPage(pdf, [14401, 200]);
      return pdf.save();
    }],
    ['pdf_page_rotation', async () => {
      const pdf = await PDFDocument.create();
      (await markedPage(pdf)).node.set(PDFName.of('Rotate'), pdf.context.obj(45));
      return pdf.save();
    }],
  ];
  for (const [code, make] of cases) {
    const refused = await refusal(await make());
    assert.equal(refused.code, code);
    assert.equal(refused.logs.length, 1, code);
    const [message, facts] = refused.logs[0]!.args as [string, Record<string, unknown>];
    assert.equal(refused.logs[0]!.level, 'warn');
    assert.match(message, /refused/);
    assert.equal(facts.code, code);
    assert.equal(facts.route, 'envelope-document');
    assert.equal(facts.tenantId, 'org-test');
    assert.match(String(facts.sha256), /^[0-9a-f]{64}$/);
    assert.equal(typeof facts.bytes, 'number');
    assert.ok(!JSON.stringify(facts).includes('Confidential'), `${code}: no document text in the log`);
  }
});

test('a refusal from a page names the page', async () => {
  const pdf = await PDFDocument.create();
  await markedPage(pdf);
  const page = await markedPage(pdf);
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [50, 50, 70, 70] })]));
  const refused = await refusal(await pdf.save());
  assert.equal(refused.code, 'pdf_annotation_without_appearance');
  assert.deepEqual(refused.facts, { page: 2, subtype: 'Highlight' });
});

test('an empty annotation list and a form with no fields are cleaned up without a refusal', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  page.node.set(PDFName.of('Annots'), pdf.context.obj([]));
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [] }));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 0, annotations: 0, links: 0, pages: 0 });
  const stored = await PDFDocument.load(prepared.bytes);
  assert.equal(stored.catalog.get(PDFName.of('AcroForm')), undefined);
  assert.ok(!(stored.getPage(0).node.get(PDFName.of('Annots')) instanceof PDFArray));
  validateFieldsPdf(stored);
});

test('a page whose only annotation is a pop-up is still rewritten: what is stored has no annotations left', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 300, 400, 400] })]));
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 0, annotations: 0, links: 0, pages: 0 });
  assert.notEqual(prepared.sha256, prepared.uploadedSha256);
  const stored = await PDFDocument.load(prepared.bytes);
  assert.equal(stored.getPage(0).node.get(PDFName.of('Annots')), undefined);
  validateFieldsPdf(stored);
  assert.deepEqual(describeUploadChanges(prepared.changes), ['nothing that shows changed, only how the file is put together (such as an empty form, a comment\'s pop-up window, or pages that shared their content)']);
  assert.deepEqual(describeUploadChanges(null), []);
});

test('a blank form field with no look of its own is removed; one holding a value the viewer would draw itself is refused', async () => {
  const make = async (value?: string) => {
    const pdf = await PDFDocument.create();
    const page = await markedPage(pdf);
    const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('name'), Rect: [50, 50, 250, 70], ...(value === undefined ? {} : { V: PDFString.of(value) }) }));
    page.node.set(PDFName.of('Annots'), pdf.context.obj([widget]));
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [widget] }));
    return pdf.save();
  };
  for (const blank of [undefined, '']) {
    const prepared = await prepare(await make(blank));
    assert.deepEqual(prepared.changes, { formFields: 1, annotations: 0, links: 0, pages: 0 });
    validateFieldsPdf(await PDFDocument.load(prepared.bytes));
  }
  const refused = await refusal(await make('Jordan Example'));
  assert.deepEqual([refused.code, refused.facts], ['pdf_form_without_appearance', { page: 1, subtype: 'Widget' }]);
});

test('pages that share one content array are each rewritten on their own: turning or flattening one never moves another', async () => {
  for (const rotated of [[90, 0], [90, 90]]) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    const first = pdf.addPage([612, 792]), second = pdf.addPage([612, 792]);
    first.drawText('Shared', { x: 100, y: 600, size: 12, font });
    // One indirect array of content streams, which both pages name.
    const shared = pdf.context.register(pdf.context.obj(first.node.normalizedEntries().Contents.asArray()));
    first.node.set(PDFName.of('Contents'), shared);
    second.node.set(PDFName.of('Contents'), shared);
    second.node.set(PDFName.of('Resources'), first.node.get(PDFName.of('Resources'))!);
    first.setRotation(degrees(rotated[0]!));
    second.setRotation(degrees(rotated[1]!));
    // A stamp on the first page only.
    const look = pdf.context.register(pdf.context.stream('BT /F1 10 Tf 2 2 Td (STAMP) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 60, 20], Resources: { Font: { F1: font.ref } } }));
    first.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 300, 360, 320], AP: { N: look } })]));
    const bytes = await pdf.save();
    const prepared = await prepare(bytes);
    const before = await shownText(bytes), after = await shownText(prepared.bytes);
    assert.deepEqual(after[1], before[1], `${rotated}: the second page is as it was`);
    assert.deepEqual(after[0]!.filter((item) => item.text === 'Shared'), before[0], `${rotated}: the first page's own text where it was shown`);
    assert.equal(after[0]!.filter((item) => item.text === 'STAMP').length, 1, 'the stamp is drawn on its own page');
  }
});

test('an annotation in optional content keeps its condition: drawn only where the layer is shown', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const layer = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Draft marks') }));
  pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.obj({ OCGs: [layer], D: { OFF: [layer] } }));
  const look = pdf.context.register(pdf.context.stream('1 0 0 rg 0 0 40 20 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 20] }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 140, 120], OC: layer, AP: { N: look } })]));
  const prepared = await prepare(await pdf.save());
  assert.equal(prepared.changes?.annotations, 1);
  // PDF.js marks the appearance as optional content of that layer, which its default configuration hides.
  const doc = await getDocument(strictPdfOptions(Uint8Array.from(prepared.bytes))).promise;
  try {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const ops = await (await doc.getPage(1)).getOperatorList();
    const begin = ops.fnArray.findIndex((fn: number, i: number) => fn === OPS.beginMarkedContentProps && ops.argsArray[i]?.[0] === 'OC');
    const paint = ops.fnArray.indexOf(OPS.paintFormXObjectBegin);
    const end = ops.fnArray.indexOf(OPS.endMarkedContent, begin);
    assert.ok(begin >= 0 && begin < paint && paint < end, `the appearance is inside the layer's marked content (${begin}, ${paint}, ${end})`);
    const config = await doc.getOptionalContentConfig();
    assert.equal(config.isVisible(ops.argsArray[begin][1]), false, 'and that layer is hidden');
  } finally { await doc.destroy(); }
});

test('a PDF that would be over 5 MiB once rewritten is refused, not stored for every reader to reject', async () => {
  const pdf = await PDFDocument.create();
  (await markedPage(pdf)).setRotation(degrees(90));
  // About 6 MiB of numbers that compress to almost nothing in an object stream, and are written out in full when rewritten.
  pdf.context.register(pdf.context.obj(Array.from({ length: 3_000_000 }, () => 0)));
  const bytes = await pdf.save({ useObjectStreams: true });
  assert.ok(bytes.length < 5 * 1024 * 1024, `the upload itself is small (${bytes.length} bytes)`);
  const refused = await refusal(bytes);
  assert.equal(refused.code, 'pdf_too_large');
  assert.match(describePdfRefusal('pdf_too_large') ?? '', /larger than 5 MiB/, 'the pages say what to do');
});

test('a blank form that asks the viewer to draw its values is flattened; one holding a value is refused', async () => {
  const make = async (value: string) => {
    const pdf = await PDFDocument.create();
    const page = await markedPage(pdf);
    const field = pdf.getForm().createTextField('applicant');
    if (value) field.setText(value);
    field.addToPage(page, { x: 50, y: 50, width: 200, height: 20 });
    pdf.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), pdf.context.obj(true));
    return pdf.save();
  };
  const blank = await prepare(await make(''));
  assert.deepEqual(blank.changes, { formFields: 1, annotations: 0, links: 0, pages: 0 });
  assert.equal((await refusal(await make('Jordan Example'))).code, 'pdf_form_without_appearance');
});

test('a form whose fields name the same kids over and over is read in linear time, not once per path', async () => {
  const pdf = await PDFDocument.create();
  await markedPage(pdf);
  // 24 levels, each naming the next twice: about 16 million paths, 25 objects.
  let next = pdf.context.register(pdf.context.obj({ T: PDFString.of('leaf') }));
  for (let level = 0; level < 24; level++) next = pdf.context.register(pdf.context.obj({ T: PDFString.of(`level${level}`), Kids: [next, next] }));
  // And a field that is its own kid.
  const loop = pdf.context.register(pdf.context.obj({ T: PDFString.of('loop') }));
  (pdf.context.lookup(loop) as PDFDict).set(PDFName.of('Kids'), pdf.context.obj([loop]));
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [next, loop], NeedAppearances: true }));
  const started = performance.now();
  const prepared = await prepare(await pdf.save());
  assert.ok(performance.now() - started < 1000, `prepared in ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(prepared.changes, { formFields: 0, annotations: 0, links: 0, pages: 0 }, 'a blank form: kept as its pages show it');
});

test('the log names the software that made the PDF from a fixed list, never the strings the file carries', async () => {
  const make = async (producer: string, creator: string) => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    (await markedPage(pdf)).setRotation(degrees(90));
    pdf.setProducer(producer);
    pdf.setCreator(creator);
    return pdf.save();
  };
  const leaky = await prepare(await make('user=alex@example.test', 'Drafts/alex/Private Agreement.pdf'));
  const logged = JSON.stringify(leaky.logs);
  assert.ok(!/alex|Private|Agreement|example\.test|Drafts/.test(logged), logged);
  assert.deepEqual([(leaky.logs[0]!.args[1] as Record<string, unknown>).producer, (leaky.logs[0]!.args[1] as Record<string, unknown>).creator], ['other', 'other']);
  const known = await prepare(await make('Microsoft® Word for Microsoft 365', 'LibreOffice 7.6 Writer'));
  assert.deepEqual([(known.logs[0]!.args[1] as Record<string, unknown>).producer, (known.logs[0]!.args[1] as Record<string, unknown>).creator], ['Microsoft Word', 'LibreOffice']);
});

test('many fields naming one long list of kids are read once, not once per field', async () => {
  const pdf = await PDFDocument.create();
  await markedPage(pdf);
  // 2,000 fields, each naming the same list of 80,000 kids (the fields themselves, over and over).
  const fields = Array.from({ length: 2_000 }, () => pdf.context.register(pdf.context.obj({})));
  const kids = pdf.context.register(pdf.context.obj(Array.from({ length: 80_000 }, (_, i) => fields[i % fields.length]!)));
  for (const field of fields) (pdf.context.lookup(field) as PDFDict).set(PDFName.of('Kids'), kids);
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [fields[0]!], NeedAppearances: true }));
  const bytes = await pdf.save();
  const started = performance.now();
  await prepare(bytes);
  assert.ok(performance.now() - started < 1000, `prepared in ${Math.round(performance.now() - started)} ms`);
});

test('an annotation\'s subtype is logged as one of the standard names, never the name the file gives it', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Private Agreement.pdf', Rect: [50, 50, 70, 70] })]));
  const refused = await refusal(await pdf.save());
  assert.equal(refused.code, 'pdf_annotation_without_appearance');
  assert.deepEqual(refused.facts, { page: 1, subtype: 'other' });
  assert.ok(!JSON.stringify(refused.logs).includes('Private'), JSON.stringify(refused.logs));
});

test('a PDF naming more annotations than Esign flattens is refused at once, however few bytes it takes', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const look = pdf.context.register(pdf.context.stream('0 0 1 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  const stamp = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 20, 20], AP: { N: look } }));
  // One stamp, named 40,000 times.
  page.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({ length: 40_000 }, () => stamp)));
  const started = performance.now();
  const refused = await refusal(await pdf.save());
  assert.ok(performance.now() - started < 1000, `refused in ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual([refused.code, refused.facts], ['pdf_unsupported', { annotations: 40_000 }]);
});

test('pages sharing one long content list are copied only so much: past it the upload is refused at once', async () => {
  for (const rotate of [false, true]) {
    const pdf = await PDFDocument.create();
    const empty = pdf.context.register(pdf.context.stream(''));
    const shared = pdf.context.register(pdf.context.obj(Array.from({ length: 200_000 }, () => empty)));
    for (let i = 0; i < 100; i++) {
      const page = pdf.addPage([612, 792]);
      page.node.set(PDFName.of('Contents'), shared);
      if (rotate) page.setRotation(degrees(90));
    }
    const bytes = await pdf.save();
    const started = performance.now();
    const refused = await refusal(bytes);
    assert.ok(performance.now() - started < 1500, `refused in ${Math.round(performance.now() - started)} ms`);
    assert.equal(refused.code, 'pdf_unsupported');
    assert.ok((refused.facts.contents as number) <= 2 * 200_000, 'it stops copying at the limit');
  }
});

test('reading which software made a PDF takes the same time however long its metadata is', async () => {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  await markedPage(pdf);
  pdf.setProducer('microsoft '.repeat(12_000));
  pdf.setCreator('microsoft '.repeat(12_000));
  const bytes = await pdf.save();
  const started = performance.now();
  await prepare(bytes);
  assert.ok(performance.now() - started < 500, `prepared in ${Math.round(performance.now() - started)} ms`);
});

test('naming what is flattened takes the same time however many names the page already has', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const look = pdf.context.register(pdf.context.stream('0 0 1 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  const layer = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Notes') }));
  pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.obj({ OCGs: [layer], D: {} }));
  // Names already in the page's resources, the ones Esign would pick first among them.
  const resources = page.node.normalizedEntries();
  for (let i = 0; i < 100_000; i++) resources.XObject.set(PDFName.of(`FlatAnnot-${i}`), look);
  const properties = pdf.context.obj({});
  for (let i = 1; i <= 5_000; i++) properties.set(PDFName.of(`FlatAnnotOC${i}`), pdf.context.obj({}));
  resources.Resources.set(PDFName.of('Properties'), properties);
  const stamp = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 20, 20], CA: 0.5, OC: layer, AP: { N: look } }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({ length: 10_000 }, () => stamp)));
  const bytes = await pdf.save();
  const started = performance.now();
  const prepared = await prepare(bytes);
  assert.ok(performance.now() - started < 1500, `prepared in ${Math.round(performance.now() - started)} ms`);
  assert.equal(prepared.changes?.annotations, 10_000);
  // The stamp is still drawn inside its layer: a new name for it, after the ones the page had.
  const stored = await PDFDocument.load(prepared.bytes);
  const named = stored.getPage(0).node.Resources()!.lookup(PDFName.of('Properties'), PDFDict).get(PDFName.of('FlatAnnotOC5001'));
  assert.ok(named && stored.context.lookup(named) instanceof PDFDict && (stored.context.lookup(named) as PDFDict).get(PDFName.of('Type'))?.toString() === '/OCG');
});

test('an annotation named over and over with a long made-up subtype is read once', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const hidden = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'X'.repeat(20_000), F: 2, Rect: [10, 10, 20, 20] }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({ length: 10_000 }, () => hidden)));
  const bytes = await pdf.save();
  const started = performance.now();
  const prepared = await prepare(bytes);
  assert.ok(performance.now() - started < 1000, `prepared in ${Math.round(performance.now() - started)} ms`);
  assert.equal(prepared.changes?.annotations, 10_000);
});

test('pages sharing one resource dictionary still share it once rewritten: it is written once, not once per page', async () => {
  const pdf = await PDFDocument.create();
  const look = pdf.context.register(pdf.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
  const xobjects = pdf.context.obj({});
  for (let i = 0; i < 20_000; i++) xobjects.set(PDFName.of(`Im${i}`), look);
  const resources = pdf.context.register(pdf.context.obj({ XObject: xobjects }));
  for (let i = 0; i < 100; i++) {
    const page = pdf.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), resources);
    page.setRotation(degrees(90));
  }
  // Written as Esign writes it (no object streams), so the sizes compare.
  const bytes = await pdf.save({ useObjectStreams: false });
  const prepared = await prepare(bytes);
  assert.equal(prepared.changes?.pages, 100);
  assert.ok(prepared.bytes.length < 1.2 * bytes.length, `${bytes.length} bytes uploaded, ${prepared.bytes.length} stored`);
});

test('an appearance or layer condition written inside an annotation named many times is stored once', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  const layer = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Notes') }));
  pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.obj({ OCGs: [layer], D: {} }));
  // Both written inside the annotation, not as objects of their own.
  const look = pdf.context.stream(`0 0 1 rg 0 0 5 5 re f\n${'%'.repeat(100 * 1024)}\n`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 5, 5] });
  const membership = pdf.context.obj({ Type: 'OCMD', VE: [PDFName.of('Or'), ...Array.from({ length: 20_000 }, () => layer)] });
  const stamp = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 15, 15], OC: membership, AP: pdf.context.obj({ N: look }) }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({ length: 1_000 }, () => stamp)));
  const bytes = await pdf.save({ useObjectStreams: false });
  const prepared = await prepare(bytes);
  assert.equal(prepared.changes?.annotations, 1_000);
  assert.ok(prepared.bytes.length < 2 * bytes.length, `${bytes.length} bytes uploaded, ${prepared.bytes.length} stored`);
});

test('a blank form field named many times has its value read once', async () => {
  const pdf = await PDFDocument.create();
  const page = await markedPage(pdf);
  // A value that is empty once read, but slow to read: escaped line breaks only.
  const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('blank'), Rect: [50, 50, 250, 70], V: PDFString.of('\\\n'.repeat(50_000)) }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({ length: 10_000 }, () => widget)));
  const bytes = await pdf.save();
  const started = performance.now();
  const prepared = await prepare(bytes);
  assert.ok(performance.now() - started < 1000, `prepared in ${Math.round(performance.now() - started)} ms`);
  assert.equal(prepared.changes?.formFields, 10_000);
});

test('a slow value shared by many fields, through their parent or as one object, is read once', async () => {
  const slow = () => PDFString.of('\\\n'.repeat(50_000));
  // Many widgets whose parent holds the value.
  const inherited = await PDFDocument.create();
  const page = await markedPage(inherited);
  const parent = inherited.context.register(inherited.context.obj({ FT: 'Tx', T: PDFString.of('parent'), V: slow() }));
  page.node.set(PDFName.of('Annots'), inherited.context.obj(Array.from({ length: 10_000 }, () => inherited.context.register(inherited.context.obj({ Type: 'Annot', Subtype: 'Widget', Parent: parent, Rect: [50, 50, 250, 70] })))));
  // Many fields naming one value object, read through the form.
  const shared = await PDFDocument.create();
  await markedPage(shared);
  const value = shared.context.register(slow());
  const fields = Array.from({ length: 10_000 }, () => shared.context.register(shared.context.obj({ FT: 'Tx', V: value })));
  shared.catalog.set(PDFName.of('AcroForm'), shared.context.obj({ Fields: fields, NeedAppearances: true }));
  for (const pdf of [inherited, shared]) {
    const bytes = await pdf.save();
    const started = performance.now();
    await prepare(bytes);
    assert.ok(performance.now() - started < 10_000, `prepared in ${Math.round(performance.now() - started)} ms`);
  }
});

test('pages with resources of their own that share one font, image or graphics-state list still share it once rewritten', async () => {
  const pdf = await PDFDocument.create();
  const look = pdf.context.register(pdf.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
  const xobjects = pdf.context.obj({});
  for (let i = 0; i < 20_000; i++) xobjects.set(PDFName.of(`Im${i}`), look);
  const shared = pdf.context.register(xobjects);
  for (let i = 0; i < 100; i++) {
    const page = pdf.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: shared }));
    page.setRotation(degrees(90));
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  const prepared = await prepare(bytes);
  assert.equal(prepared.changes?.pages, 100);
  assert.ok(prepared.bytes.length < 1.2 * bytes.length, `${bytes.length} bytes uploaded, ${prepared.bytes.length} stored`);
});

test('a rewrite that would be over 5 MiB is refused before its output is built', async () => {
  const pdf = await PDFDocument.create();
  (await markedPage(pdf)).setRotation(degrees(90));
  for (let i = 0; i < 20_000; i++) pdf.context.register(PDFString.of('x'.repeat(5_000)));
  const bytes = await pdf.save({ useObjectStreams: true });
  const save = PDFDocument.prototype.save;
  let saved = 0;
  PDFDocument.prototype.save = function (...args) { saved++; return save.apply(this, args); };
  try {
    const refused = await refusal(bytes);
    assert.equal(refused.code, 'pdf_too_large');
    assert.equal(saved, 0, 'nothing was written out');
  } finally { PDFDocument.prototype.save = save; }
});

test('pages sharing one content list are stored with one each, so drawing a signature on one leaves the others as they were', async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]), second = pdf.addPage([612, 792]);
  first.drawText('Shared', { x: 100, y: 600, size: 12, font });
  const shared = pdf.context.register(pdf.context.obj(first.node.normalizedEntries().Contents.asArray()));
  first.node.set(PDFName.of('Contents'), shared);
  second.node.set(PDFName.of('Contents'), shared);
  second.node.set(PDFName.of('Resources'), first.node.get(PDFName.of('Resources'))!);
  const bytes = await pdf.save();
  const prepared = await prepare(bytes);
  assert.deepEqual(prepared.changes, { formFields: 0, annotations: 0, links: 0, pages: 0 });
  assert.match(describeUploadChanges(prepared.changes).join(' '), /nothing that shows changed/);
  // Signing draws on the stored PDF with pdf-lib, page by page.
  const stored = await PDFDocument.load(prepared.bytes);
  stored.getPage(0).drawText('Signed', { x: 100, y: 100, size: 12, font: await stored.embedFont(StandardFonts.Helvetica) });
  const after = await shownText(await stored.save());
  assert.deepEqual(after[1], (await shownText(bytes))[1], 'the second page is as it was');
  assert.ok(after[0]!.some((item) => item.text === 'Signed'));
});
