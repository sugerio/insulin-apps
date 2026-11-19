import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formAmount, type FilledForm } from "../../shared/engine/forms.ts";

// Builds one return's PDF: each CRA form with its amounts written in, then a worksheet that says how every number was
// worked out. The CRA's forms are its print versions (no form fields), so each amount is drawn at its place: dollars
// ending just left of the line between dollars and cents, cents just right of it.

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
  for (const { filled, template } of forms) {
    const source = await PDFDocument.load(template);
    const pages = await out.copyPages(source, source.getPageIndices());
    for (const page of pages) out.addPage(page);
    for (const amount of filled.amounts) {
      const page = pages[amount.page - 1];
      if (!page) continue;
      const { dollars, cents } = formAmount(amount.value);
      page.drawText(dollars, { x: amount.x - 2.5 - font.widthOfTextAtSize(dollars, SIZE), y: amount.y, size: SIZE, font, color: INK });
      page.drawText(cents, { x: amount.x + 2.5, y: amount.y, size: SIZE, font, color: INK });
    }
  }
  writeWorksheet(out, font, bold, worksheet);
  out.setTitle(worksheet.title);
  out.setProducer("Taxi");
  out.setCreator("Taxi");
  return out.save();
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
