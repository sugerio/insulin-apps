import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assertRenderableRecipientNames, fieldImageKey, fieldRenderer, SIGNATURE_NAME_FONT_SIZE, SIGNATURE_PAGE_MARGIN, SIGNATURE_PAGE_SIZE, signatureNameLine, type Box } from './field-render.ts';
import { validateFieldsPdf } from './fields.ts';
import { canonicalJson } from './canonical-json.ts';
import { artifactObjectKey, digestHex, outputArtifactId, verifySignatureRecord, type AppendedPageRender, type FieldsRender, type SignatureRender, type SignatureRow } from './signatures.ts';

/**
 * Rendering a saved signature's PDF: the input PDF with what render_json says drawn on it, and
 * nothing else (never a later client request). A pending signature is rendered, stored and marked
 * DONE, which hands the envelope to its next signer or, after the last, to sealing. A DONE one is
 * rendered again and must come out byte for byte as stored: that is how a changed PDF, image or
 * record is detected. Safe to repeat and to run concurrently. With `write: false` a pending
 * signature is only checked: everything is verified and rendered, nothing is stored.
 */
export async function processSignature(db: D1Database, bucket: R2Bucket, signatureId: string, { write = true }: { write?: boolean } = {}): Promise<void> {
  const row = await db.prepare('SELECT * FROM signatures WHERE id=?').bind(signatureId).first<SignatureRow>();
  if (!row) throw new Error('Signature missing');
  const { render } = await verifySignatureRecord(row);
  const input = await bucket.get(await inputObjectKey(db, row, render));
  if (!input) throw new Error('Input missing');
  const bytes = new Uint8Array(await input.arrayBuffer());
  if (await digestHex(bytes) !== row.input_sha256) throw new Error('Input mismatch');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  if (pdf.getPageCount() !== render.inputPageCount) throw new Error('Page count mismatch');
  if (render.kind === 'appended-page') await drawSignaturePage(pdf, render);
  else await drawFields(pdf, bucket, row, render);

  const output = await pdf.save({ useObjectStreams: false });
  const outputHash = await digestHex(output), artifactId = outputArtifactId(row.id), key = artifactObjectKey(row.envelope_id, artifactId);
  if (row.status === 'DONE') {
    const stored = await bucket.get(key);
    if (row.output_artifact_id !== artifactId || row.output_sha256 !== outputHash || !stored || await digestHex(await stored.arrayBuffer()) !== outputHash) throw new Error('Output integrity failure');
    return;
  }
  if (!write) return;
  const stored = await bucket.put(key, output, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/pdf' } });
  if (!stored) {
    const existing = await bucket.get(key);
    if (!existing || await digestHex(await existing.arrayBuffer()) !== outputHash) throw new Error('Output conflict');
  }
  // The commit point: a compare-and-set from PENDING to DONE naming the output stored above (an
  // output that never gets named is an unreachable orphan). The envelope then moves on in the same
  // batch, by idempotent conditional updates that depend only on the state, so it does not matter
  // which run marked it DONE; completion and the cron sweep run the same updates again.
  const [done] = await db.batch([
    db.prepare("UPDATE signatures SET status='DONE',output_artifact_id=?,output_sha256=? WHERE id=? AND status='PENDING'").bind(artifactId, outputHash, row.id),
    ...advanceStatements(db, row.envelope_id),
  ]);
  if (done.meta.changes === 1) return;
  // A concurrent run marked it DONE first: it must have stored the same output.
  const current = await db.prepare('SELECT status,output_artifact_id,output_sha256 FROM signatures WHERE id=?').bind(row.id).first<Pick<SignatureRow, 'status' | 'output_artifact_id' | 'output_sha256'>>();
  if (current?.status !== 'DONE' || current.output_artifact_id !== artifactId || current.output_sha256 !== outputHash) throw new Error('Output conflict');
}

/**
 * Moving an envelope on after its signatures, as idempotent conditional updates that read only
 * the current state, so they can run any number of times, from any process, in any order:
 * - a task whose signature exists is SIGNED;
 * - with no task ACTIVE and every SIGNED task's signature rendered (DONE), the next PENDING task
 *   in routing order becomes ACTIVE;
 * - with every task SIGNED and rendered, the envelope becomes FINALIZING (to be sealed).
 * Only an envelope IN_PROGRESS moves on, so a voided or expired one stays as it is.
 */
export function advanceStatements(db: D1Database, envelopeId: string): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE tasks SET status='SIGNED' WHERE envelope_id=?1 AND status='ACTIVE' AND EXISTS (SELECT 1 FROM signatures g WHERE g.task_id=tasks.id AND g.envelope_id=?1)").bind(envelopeId),
    db.prepare(`UPDATE tasks SET status='ACTIVE' WHERE id=(SELECT id FROM tasks WHERE envelope_id=?1 AND status='PENDING' ORDER BY routing_order LIMIT 1)
      AND EXISTS (SELECT 1 FROM envelopes WHERE id=?1 AND status='IN_PROGRESS') AND NOT EXISTS (SELECT 1 FROM tasks WHERE envelope_id=?1 AND status='ACTIVE')
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.envelope_id=?1 AND t.status='SIGNED' AND NOT EXISTS (SELECT 1 FROM signatures g WHERE g.task_id=t.id AND g.status='DONE'))`).bind(envelopeId),
    db.prepare(`UPDATE envelopes SET status='FINALIZING' WHERE id=?1 AND status='IN_PROGRESS' AND EXISTS (SELECT 1 FROM tasks WHERE envelope_id=?1)
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.envelope_id=?1 AND (t.status<>'SIGNED' OR NOT EXISTS (SELECT 1 FROM signatures g WHERE g.task_id=t.id AND g.status='DONE')))`).bind(envelopeId),
  ];
}

/**
 * Where the signature's input PDF is: the envelope's source, or the previous signature's output,
 * which must be linked by the event hash and drawn the same way (the same kind, the same placed fields).
 */
async function inputObjectKey(db: D1Database, row: SignatureRow, render: SignatureRender): Promise<string> {
  if (row.sequence === 1) {
    const source = await db.prepare('SELECT object_key FROM artifacts WHERE envelope_id=? AND id=? AND sha256=?').bind(row.envelope_id, row.input_artifact_id, row.input_sha256).first<{ object_key: string }>();
    if (!source) throw new Error('Initial artifact mismatch');
    return source.object_key;
  }
  const prior = await db.prepare('SELECT status,event_hash,output_artifact_id,output_sha256,render_json FROM signatures WHERE envelope_id=? AND sequence=?').bind(row.envelope_id, row.sequence - 1)
    .first<Pick<SignatureRow, 'status' | 'event_hash' | 'output_artifact_id' | 'output_sha256' | 'render_json'>>();
  if (!prior || prior.status !== 'DONE' || prior.event_hash !== row.previous_hash || prior.output_artifact_id !== row.input_artifact_id || prior.output_sha256 !== row.input_sha256) throw new Error('Event chain mismatch');
  const before = JSON.parse(prior.render_json) as Partial<FieldsRender>;
  if (before.kind !== render.kind || (render.kind === 'fields' && canonicalJson(before.template) !== canonicalJson(render.template))) throw new Error('Template snapshot mismatch');
  return artifactObjectKey(row.envelope_id, row.input_artifact_id);
}

/** A block on the shared signature page: the name and the signing time, eight blocks to a page. */
async function drawSignaturePage(pdf: PDFDocument, render: AppendedPageRender): Promise<void> {
  await assertRenderableRecipientNames([render.name]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = render.slot === 0 ? pdf.addPage(SIGNATURE_PAGE_SIZE) : pdf.getPage(pdf.getPageCount() - 1);
  if (render.slot === 0) page.drawText('Electronic signature', { x: 50, y: page.getHeight() - 70, size: 18, font });
  const y = page.getHeight() - 105 - render.slot * 80;
  page.drawText(signatureNameLine(render.name), { x: SIGNATURE_PAGE_MARGIN, y, size: SIGNATURE_NAME_FONT_SIZE, font });
  page.drawText(`Time (UTC): ${render.signedAt}`, { x: 50, y: y - 25, size: 12, font });
}

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Each field's stored image at its recorded place; the image must be what the renderer makes of the value. */
async function drawFields(pdf: PDFDocument, bucket: R2Bucket, row: SignatureRow, render: FieldsRender): Promise<void> {
  validateFieldsPdf(pdf);
  for (const field of render.fields) {
    const renderer = fieldRenderer(field.type);
    if (await digestHex(await renderer.render(field.value)) !== field.imageSha256) throw new Error('Image does not match its value');
    const object = await bucket.get(fieldImageKey(row.envelope_id, row.id, field.id));
    if (!object) throw new Error('Missing image');
    const image = new Uint8Array(await object.arrayBuffer());
    if (await digestHex(image) !== field.imageSha256) throw new Error('Image mismatch');
    const png = await pdf.embedPng(image), page = pdf.getPage(field.page - 1), g = renderer.geometry(page, field, image);
    if (!sameBox(g, field.geometry)) throw new Error('Geometry mismatch');
    page.drawImage(png, { x: g.x, y: page.getHeight() - g.y - g.height, width: g.width, height: g.height });
  }
}
