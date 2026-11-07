import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SIGNATURE_NAME_FONT_SIZE, SIGNATURE_PAGE_MARGIN, SIGNATURE_PAGE_SIZE, signatureNameLine } from './signature-page-layout.ts';

/** The signing renderer uses this font; validate every recipient before creating an envelope. */
export async function assertRenderableRecipientNames(names: string[]): Promise<void> {
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const availableWidth = SIGNATURE_PAGE_SIZE[0] - 2 * SIGNATURE_PAGE_MARGIN;
    for (const name of names) {
      const line = signatureNameLine(name);
      font.encodeText(line);
      // drawText emits one Tj without kerning adjustments, unlike widthOfTextAtSize(line).
      const width = Array.from(line, char => font.widthOfTextAtSize(char, SIGNATURE_NAME_FONT_SIZE)).reduce((total, advance) => total + advance, 0);
      if (width + 1e-7 > availableWidth) throw new Error('Recipient name does not fit');
    }
  } catch {
    throw new Error('Unsupported recipient name for local PDF renderer');
  }
}
