import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formAmount, type FilledForm, type PlacedMark } from "../../shared/engine/forms.ts";
import { decryptPdf } from "./pdf-decrypt.ts";

// Builds one return's PDF: each form (the CRA's, then for a resident of Quebec Revenu Québec's; or the IRS's) with its
// amounts written in, then a worksheet that says how every number was worked out. Each amount is drawn at its place on
// the form's own page (the IRS's fill-in forms lose their empty fields first, so a reader shows only what is drawn): dollars ending just left of the line between dollars and
// cents, cents just right of it (in a box with no such line, the amount with its decimal point ends at the box's end).
// A whole number ends where its dollars would; text starts at its box (smaller when it doesn't fit), a date has one
// digit per cell, and a tick is an X.

const SIZE = 9;
const INK = rgb(0, 0, 0.55);
const PAGE: [number, number] = [612, 792];
const MARGIN = 54;

export interface Worksheet {
  title: string;
  /** Short paragraphs at the top: what this is and how to file it. */
  intro: string[];
  sections: { heading: string; rows: WorksheetRow[] }[];
}
/** A line of the worksheet: a name and its amount, with notes under it (a formula, a source). */
export interface WorksheetRow {
  text: string;
  amount?: string;
  notes?: string[];
}

export async function buildReturnPdf(forms: { filled: FilledForm; template: Uint8Array }[], worksheet: Worksheet): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const clean = textCleaner(font);
  for (const { filled, template } of forms) {
    // Revenu Québec's forms are encrypted (with an empty password), which pdf-lib can't read.
    const source = await PDFDocument.load(await decryptPdf(template));
    dropFields(source);
    const pages = await out.copyPages(source, source.getPageIndices());
    for (const page of pages) out.addPage(page);
    for (const amount of filled.amounts) {
      const page = pages[amount.page - 1];
      if (!page) continue;
      const { dollars, cents } = formAmount(amount.value, filled.form.url.includes("revenuquebec.ca") ? "minus" : "brackets", filled.language);
      // A whole-dollar form (California's) prints its own cents: a whole amount is written as dollars only, and a
      // decimal (FTB 3506's line 7, FTB 3514's line 26) with its decimal point.
      if (filled.form.wholeDollars && amount.value.isInteger()) {
        page.drawText(dollars, { x: amount.x - 2.5 - font.widthOfTextAtSize(dollars, SIZE), y: amount.y, size: SIZE, font, color: INK });
        continue;
      }
      if (amount.plain) {
        const text = `${dollars}${filled.language === "fr" ? "," : "."}${cents}`;
        page.drawText(text, { x: amount.x - 2.5 - font.widthOfTextAtSize(text, SIZE), y: amount.y, size: SIZE, font, color: INK });
        continue;
      }
      page.drawText(dollars, { x: amount.x - 2.5 - font.widthOfTextAtSize(dollars, SIZE), y: amount.y, size: SIZE, font, color: INK });
      page.drawText(cents, { x: amount.x + 2.5, y: amount.y, size: SIZE, font, color: INK });
    }
    for (const mark of filled.marks) {
      const page = pages[mark.page - 1];
      if (page) drawMark(page, font, clean, mark);
    }
  }
  writeWorksheet(out, font, bold, worksheet);
  out.setTitle(worksheet.title);
  out.setProducer("Taxi");
  out.setCreator("Taxi");
  return out.save();
}

/**
 * Takes a fill-in form's fields off its pages, and its form (with the XFA part, which a reader would show instead of
 * the pages): what Taxi writes is drawn on the page, and an empty field left over it would be shaded, or typed into
 * over Taxi's text.
 */
function dropFields(doc: PDFDocument): void {
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    const kept = annots.asArray().filter((ref) => doc.context.lookupMaybe(ref, PDFDict)?.get(PDFName.of("Subtype"))?.toString() !== "/Widget");
    if (kept.length === annots.size()) continue;
    if (kept.length === 0) page.node.delete(PDFName.of("Annots"));
    else page.node.set(PDFName.of("Annots"), doc.context.obj(kept));
  }
  doc.catalog.delete(PDFName.of("AcroForm"));
}

/** Writes a name, a date, a whole number or a tick at its place. */
function drawMark(page: PDFPage, font: PDFFont, clean: (text: string) => string, mark: PlacedMark): void {
  if (mark.kind === "tick") {
    // An X centred in the box: Helvetica's capitals are about 0.72 of the size high.
    page.drawText("X", { x: mark.x - font.widthOfTextAtSize("X", SIZE) / 2, y: mark.y - SIZE * 0.36, size: SIZE, font, color: INK });
    return;
  }
  const text = clean(mark.text);
  if (mark.kind === "count") {
    page.drawText(text, { x: mark.x - 2.5 - font.widthOfTextAtSize(text, SIZE), y: mark.y, size: SIZE, font, color: INK });
  } else if (mark.cell !== undefined) {
    [...text].forEach((char, index) => {
      page.drawText(char, { x: mark.x + mark.cell! * (index + 0.5) - font.widthOfTextAtSize(char, SIZE) / 2, y: mark.y, size: SIZE, font, color: INK });
    });
  } else {
    // A long name gets smaller to stay in its box, down to a size that can still be read.
    const width = font.widthOfTextAtSize(text, SIZE);
    const size = mark.width !== undefined && width > mark.width ? Math.max(6, (SIZE * mark.width) / width) : SIZE;
    page.drawText(text, { x: mark.x, y: mark.y, size, font, color: INK });
  }
}

/** The worksheet's pages: text wrapped to the page, amounts in a column on the right. */
function writeWorksheet(out: PDFDocument, font: PDFFont, bold: PDFFont, worksheet: Worksheet): void {
  const clean = textCleaner(font);
  const width = PAGE[0] - 2 * MARGIN;
  const amountColumn = 110;
  let page: PDFPage = out.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  const room = (height: number) => {
    if (y - height >= MARGIN) return;
    page = out.addPage(PAGE);
    y = PAGE[1] - MARGIN;
  };
  const paragraph = (text: string, options: { font?: PDFFont; size?: number; indent?: number; maxWidth?: number; gap?: number } = {}) => {
    const size = options.size ?? SIZE;
    const using = options.font ?? font;
    const indent = options.indent ?? 0;
    for (const line of wrap(clean(text), using, size, (options.maxWidth ?? width) - indent)) {
      room(size + 3);
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font: using });
      y -= size + 3;
    }
    y -= options.gap ?? 0;
  };

  paragraph(worksheet.title, { font: bold, size: 14, gap: 6 });
  for (const text of worksheet.intro) paragraph(text, { gap: 4 });
  for (const section of worksheet.sections) {
    y -= 8;
    room(40);
    paragraph(section.heading, { font: bold, size: 11, gap: 3 });
    for (const row of section.rows) {
      room(SIZE + 3);
      const top = y;
      if (row.amount !== undefined) {
        const amount = clean(row.amount);
        page.drawText(amount, { x: MARGIN + width - font.widthOfTextAtSize(amount, SIZE), y: y - SIZE, size: SIZE, font });
      }
      paragraph(row.text, { maxWidth: width - amountColumn });
      if (y === top) y -= SIZE + 3;
      for (const note of row.notes ?? []) paragraph(note, { indent: 12, size: 8, maxWidth: width - amountColumn });
      y -= 2;
    }
  }
}

/** Splits text into lines that fit the width, breaking at spaces (a word longer than a line is cut). */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** The standard fonts write only Windows-1252 text: other characters become their nearest plain form, or "?". */
function textCleaner(font: PDFFont): (text: string) => string {
  const known = new Map<string, string>();
  const plain: Record<string, string> = { "≤": "<=", "≥": ">=", "→": "->", "−": "-", " ": " " };
  return (text) =>
    [...text]
      .map((char) => {
        const cached = known.get(char);
        if (cached !== undefined) return cached;
        let written = plain[char] ?? char;
        try {
          font.encodeText(written);
        } catch {
          written = "?";
        }
        known.set(char, written);
        return written;
      })
      .join("");
}
