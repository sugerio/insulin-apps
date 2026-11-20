/**
 * What preparing an uploaded PDF changed (server/esign/pdf-upload.ts), and the words for it: shared by the send page,
 * the completion certificate and the signed copy's certificate page, so they say the same thing.
 */
export type UploadChanges = { formFields: number; annotations: number; links: number; pages: number };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One phrase per kind of change, in plain words; empty when there are no changes (null). */
export function describeUploadChanges(changes: UploadChanges | null | undefined): string[] {
  if (!changes) return [];
  const out: string[] = [];
  if (changes.formFields) out.push(`${count(changes.formFields, 'form field', 'form fields')} flattened into the page: the values stay, they can't be edited`);
  if (changes.annotations) out.push(`${count(changes.annotations, 'comment, highlight or stamp', 'comments, highlights or stamps')} flattened into the page`);
  if (changes.links) out.push(`${count(changes.links, 'link', 'links')} removed: the text stays, it no longer opens anything`);
  if (changes.pages) out.push(`${count(changes.pages, 'page', 'pages')} redrawn upright, at the size shown (it was rotated or cropped)`);
  // Changed all the same, in what no page shows.
  if (!out.length) out.push('nothing that shows changed, only how the file is put together (such as an empty form, a comment\'s pop-up window, or pages that shared their content)');
  return out;
}

const PRINT = 'Open it, print it to PDF (Save as PDF), and upload the new file.';

/**
 * Why an uploaded PDF was refused, and what to do, in plain words: the API's `reason` (server/esign/pdf-upload.ts
 * `PDF_REFUSALS`) and the page it names. Null for a reason this doesn't know.
 */
export function describePdfRefusal(reason: string, page?: number): string | null {
  const onPage = Number.isSafeInteger(page) && page! > 0 ? ` on page ${page}` : '';
  const thePage = Number.isSafeInteger(page) && page! > 0 ? `Page ${page}` : 'A page';
  switch (reason) {
    case 'pdf_encrypted': return 'This PDF is password-protected or encrypted, and Esign can\'t open it. Save a copy without the protection (printing it to PDF does that), and upload the new file.';
    case 'pdf_unreadable': return `Esign couldn't read this PDF: it may be damaged, or not a PDF. ${PRINT}`;
    case 'pdf_page_count': return 'A PDF can have at most 100 pages. Split it or remove pages, and upload it again.';
    case 'pdf_dynamic_form': return `This PDF is a dynamic (XFA) form, which Esign can't flatten into the page. Fill it in, then ${PRINT.charAt(0).toLowerCase()}${PRINT.slice(1)}`;
    case 'pdf_form_without_appearance': return `A filled-in form field${onPage} doesn't say how it looks, so Esign can't flatten it as you see it. ${PRINT}`;
    case 'pdf_annotation_without_appearance': return `A comment or mark${onPage} doesn't say how it looks, so Esign can't flatten it as you see it. Remove it, or ${PRINT.charAt(0).toLowerCase()}${PRINT.slice(1)}`;
    case 'pdf_page_units': return `${thePage} uses its own units of measure, which Esign doesn't support. Print it to PDF at a standard paper size, and upload the new file.`;
    case 'pdf_page_size': return `${thePage} is empty or larger than 200 inches on a side. Print it to PDF at a standard paper size, and upload the new file.`;
    case 'pdf_page_rotation': return `${thePage} is turned at an angle that isn't a quarter turn. ${PRINT}`;
    case 'pdf_too_large': return 'Prepared for signing, this PDF would be larger than 5 MiB. Make it smaller (for example, with smaller images) or split it, and upload it again.';
    case 'pdf_unsupported': return `Esign couldn't prepare this PDF for signing. ${PRINT}`;
    default: return null;
  }
}
