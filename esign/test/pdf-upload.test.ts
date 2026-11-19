import { test } from 'node:test';
import assert from 'node:assert/strict';
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { strictPdfOptions } from '../src/app/ui/pdf.ts';
import { validateFieldsPdf } from '../src/app/server/esign/fields.ts';
import { preparePdfUpload, PdfUploadRefused, type PdfUploadSource } from '../src/app/server/esign/pdf-upload.ts';
import { describeUploadChanges } from '../src/app/lib/upload-changes.ts';

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
      pdf.getForm().createTextField('secret').addToPage(page, { x: 50, y: 50, width: 100, height: 20 });
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
  assert.deepEqual(describeUploadChanges(prepared.changes), ['only parts that don\'t show on any page were removed, such as an empty form or a comment\'s pop-up window']);
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
