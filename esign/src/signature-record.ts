import { PDFDocument } from 'pdf-lib';
import { canonicalJson } from './canonical-json.ts';
import { fieldImageKey, fieldRenderer } from './field-renderers.ts';
import { signaturePreviewHash } from './positioned-signature-preview.ts';
import { validatePositionedPdf, validatePositionedPlacement } from './positioned-template.ts';
import { capturePositionedV3, InvalidPositionedV3Input } from './positioned-v3-snapshot.ts';
import { assertRenderableRecipientNames } from './recipient-name.ts';
import { processSignature } from './signature-processing.ts';
import {
  APPENDED_PAGE_RENDERER, SIGNATURE_PAGE_SLOTS, artifactObjectKey, digestHex, signatureEventHash, verifySignatureRecord,
  type FieldsRender, type RenderedField, type SignatureFacts, type SignatureRender, type SignatureRow, type VerifiedSignature,
} from './signatures.ts';

/**
 * Accepting a signature: the one write that records it (table `signatures`, see signatures.ts).
 * Its PDF is rendered later (signature-processing.ts), from what is saved here only.
 */

/** The signing page previewed another date than today's (UTC) on the server: refresh and sign again. */
export class DateChanged extends Error {}
/** A preview the signer saw no longer matches what would be drawn. */
export class PreviewChanged extends Error {}

export type SignCommand = {
  token: string; origin: string; now: number; artifactId: string; artifactHash: string;
  /** The signer agreed to the consent disclosure. */
  consent: boolean;
  /** The signer's values for their own fields by field id; absent for a document without fields. */
  values?: unknown;
  /** Preview receipts the page was given: Signature fields, Title fields. */
  signaturePreviews?: unknown; textPreviews?: unknown;
  /** The date the page previewed for each Date signed field (YYYY-MM-DD). */
  datePreviews?: unknown;
  disclosure?: SignatureFacts['disclosure'];
  authority?: SignatureFacts['authority'];
};

type Signer = { envelope_id: string; task_id: string; role: string; recipient_name: string; recipient_email: string; verified_at: number; roles_json: string; fields_json: string };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export async function recordSignature(db: D1Database, bucket: R2Bucket, cmd: SignCommand): Promise<string> {
  if (cmd.consent !== true || !/^[a-f0-9]{64}$/.test(cmd.token) || !Number.isSafeInteger(cmd.now)) throw new Error('Invalid signing request');
  const sessionHash = await digestHex(cmd.token);
  const signer = await db.prepare(`SELECT s.envelope_id,t.id AS task_id,t.role,t.recipient_name,t.recipient_email,v.verified_at,p.roles_json,p.fields_json
    FROM recipient_page_sessions s JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id
    JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id
    JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
    WHERE s.token_hash=?`).bind(sessionHash).first<Signer>();
  if (!signer) throw new Error('Unverified session');

  // The chain so far: the new signature signs the latest one's rendered PDF, or the source.
  const latest = await db.prepare('SELECT * FROM signatures WHERE envelope_id=? ORDER BY sequence DESC LIMIT 1').bind(signer.envelope_id).first<SignatureRow>();
  const sequence = (latest?.sequence ?? 0) + 1, previousHash = latest?.event_hash ?? null;
  let prior: VerifiedSignature | null = null, inputKey: string | undefined;
  if (latest) {
    if (latest.status !== 'DONE' || latest.output_artifact_id !== cmd.artifactId || latest.output_sha256 !== cmd.artifactHash) throw new Error('Stale input');
    prior = await verifySignatureRecord(latest);
    inputKey = artifactObjectKey(signer.envelope_id, cmd.artifactId);
  } else {
    inputKey = (await db.prepare('SELECT object_key FROM artifacts WHERE envelope_id=? AND id=? AND sha256=?').bind(signer.envelope_id, cmd.artifactId, cmd.artifactHash).first<{ object_key: string }>())?.object_key;
  }
  if (!inputKey) throw new Error('Stale input');
  const object = await bucket.get(inputKey);
  if (!object) throw new Error('Input missing');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await digestHex(bytes) !== cmd.artifactHash) throw new Error('Input mismatch');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });

  const signatureId = crypto.randomUUID();
  const facts: SignatureFacts = {
    version: 1, signatureId, taskId: signer.task_id, role: signer.role, recipientName: signer.recipient_name, recipientEmail: signer.recipient_email,
    sessionHash, otpVerifiedAt: signer.verified_at, consentedAt: cmd.now, inputArtifactId: cmd.artifactId,
    ...(cmd.disclosure ? { disclosure: { version: cmd.disclosure.version, sha256: cmd.disclosure.sha256 } } : {}),
    ...(cmd.authority && Object.keys(cmd.authority).length ? { authority: cmd.authority } : {}),
  };
  const placed: unknown = JSON.parse(signer.fields_json);
  if (!Array.isArray(placed)) throw new Error('Invalid fields');
  const { render, recipients } = placed.length
    ? { render: await fieldsRender(bucket, signer, pdf, prior, signatureId, cmd), recipients: null }
    : await appendedPageRender(db, signer, pdf, prior, cmd);
  const eventHash = await signatureEventHash({ previousHash, envelopeId: signer.envelope_id, sequence, inputSha256: cmd.artifactHash }, facts, render);

  // The commit point: one INSERT that adds the signature only while everything read above still
  // holds (a single statement is atomic). The session, its verified code, the task's turn, the
  // envelope IN_PROGRESS (so a void or an expiry cannot race it) and the template are as read,
  // nobody signed in between, and the input is the current one. UNIQUE (task_id) and
  // UNIQUE (envelope_id, sequence) back this up. Images stored in R2 above are unreachable until
  // this row names them; a request that fails here leaves them as harmless orphans.
  const input = sequence === 1
    ? { sql: 'EXISTS (SELECT 1 FROM artifacts WHERE envelope_id=e.id AND id=? AND sha256=? AND object_key=?)', binds: [cmd.artifactId, cmd.artifactHash, inputKey] }
    : { sql: `EXISTS (SELECT 1 FROM signatures WHERE envelope_id=e.id AND sequence=? AND status='DONE' AND output_artifact_id=? AND output_sha256=? AND event_hash=?)`, binds: [sequence - 1, cmd.artifactId, cmd.artifactHash, previousHash] };
  // A document without fields: every signer's name was checked to fit the signature page, so the
  // envelope's tasks and names must be exactly those checked.
  const names = recipients
    ? { sql: `AND (SELECT COUNT(*) FROM tasks WHERE envelope_id=e.id)=json_array_length(?)
        AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.envelope_id=e.id AND NOT EXISTS (SELECT 1 FROM json_each(?) j
          WHERE json_extract(j.value,'$[0]')=x.id AND json_extract(j.value,'$[1]')=x.recipient_name))`, binds: Array(2).fill(JSON.stringify(recipients.map(r => [r.id, r.recipient_name]))) }
    : { sql: '', binds: [] };
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO signatures (id,envelope_id,task_id,sequence,status,input_artifact_id,input_sha256,previous_hash,event_hash,facts_json,render_json)
      SELECT ?,e.id,t.id,?,'PENDING',?,?,?,?,?,? FROM recipient_page_sessions s
      JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
      JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id
      JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
      WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND v.verified_at=? AND v.verified_at<=? AND t.recipient_email=? COLLATE BINARY
      AND e.id=? AND t.id=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.role=? AND t.recipient_name=? AND p.roles_json=? AND p.fields_json=?
      AND COALESCE((SELECT MAX(sequence) FROM signatures WHERE envelope_id=e.id),0)=?
      AND (SELECT event_hash FROM signatures WHERE envelope_id=e.id ORDER BY sequence DESC LIMIT 1) IS ?
      AND ${input.sql} ${names.sql}`)
      .bind(signatureId, sequence, cmd.artifactId, cmd.artifactHash, previousHash, eventHash, canonicalJson(facts), canonicalJson(render),
        sessionHash, cmd.origin, cmd.now, signer.verified_at, cmd.now, signer.recipient_email,
        signer.envelope_id, signer.task_id, signer.role, signer.recipient_name, signer.roles_json, signer.fields_json, sequence - 1, previousHash,
        ...input.binds, ...names.binds),
    // After the commit point, idempotent: the task is signed once its signature exists. It rides in
    // the same batch; completion (envelope-completion.ts) also marks the task of any signature
    // that exists, so a signature whose task is still ACTIVE cannot get stuck.
    db.prepare("UPDATE tasks SET status='SIGNED' WHERE id=? AND status='ACTIVE' AND EXISTS (SELECT 1 FROM signatures WHERE id=? AND task_id=?)").bind(signer.task_id, signatureId, signer.task_id),
  ]);
  if (inserted.meta.changes !== 1) throw new Error('Signature not accepted');
  return signatureId;
}

/** A document without fields: the signer's block on the shared signature page. */
async function appendedPageRender(db: D1Database, signer: Signer, pdf: PDFDocument, prior: VerifiedSignature | null, cmd: SignCommand): Promise<{ render: SignatureRender; recipients: { id: string; recipient_name: string }[] }> {
  if (cmd.values !== undefined) throw new Error('Unexpected fields');
  // Every signer's name must fit the signature page, so a later signer cannot be left unable to sign.
  const recipients = (await db.prepare('SELECT id, recipient_name FROM tasks WHERE envelope_id=?').bind(signer.envelope_id).all<{ id: string; recipient_name: string }>()).results;
  await assertRenderableRecipientNames(recipients.map(recipient => recipient.recipient_name));
  if (prior && prior.render.kind !== 'appended-page') throw new Error('Mixed signature kinds');
  const before = prior?.render.kind === 'appended-page' ? prior.render : null;
  // Eight blocks to a page: block 0 starts a new page.
  const slot = before ? (before.slot + 1) % SIGNATURE_PAGE_SLOTS : 0;
  const expectedPages = before ? before.inputPageCount + (before.slot === 0 ? 1 : 0) : null;
  if (pdf.getPageCount() < 1 || (expectedPages !== null && pdf.getPageCount() !== expectedPages)) throw new Error('Input layout mismatch');
  return {
    render: { version: 1, kind: 'appended-page', renderer: APPENDED_PAGE_RENDERER, inputPageCount: pdf.getPageCount(), slot, name: signer.recipient_name, signedAt: new Date(cmd.now).toISOString() },
    recipients,
  };
}

/** A document with placed fields: each of the signer's fields, rendered now and stored before the record. */
async function fieldsRender(bucket: R2Bucket, signer: Signer, pdf: PDFDocument, prior: VerifiedSignature | null, signatureId: string, cmd: SignCommand): Promise<FieldsRender> {
  validatePositionedPdf(pdf);
  const roles: unknown = JSON.parse(signer.roles_json);
  if (!Array.isArray(roles) || roles.some(role => typeof role !== 'string')) throw new Error('Invalid roles');
  const draft = capturePositionedV3(JSON.parse(signer.fields_json), roles, pdf.getPageCount(), signer.role, cmd.now, cmd.values);
  // Every signer signs against the same placed fields.
  if (prior && (prior.render.kind !== 'fields' || canonicalJson(prior.render.template) !== canonicalJson(draft.templateFields))) throw new Error('Template snapshot changed');
  validatePositionedPlacement(pdf, draft.templateFields);
  for (const [previews, type] of [[cmd.signaturePreviews, 'Signature'], [cmd.textPreviews, 'Title'], [cmd.datePreviews, 'Date signed']] as const) {
    if (isObject(previews) && Object.keys(previews).some(id => !draft.fields.some(f => f.id === id && f.type === type))) throw new InvalidPositionedV3Input('Unexpected preview');
  }
  const fields: RenderedField[] = [], images: { key: string; image: Uint8Array }[] = [];
  for (const field of draft.fields) {
    const placed = draft.templateFields.find(f => f.id === field.id)!, renderer = fieldRenderer(field.type), page = pdf.getPage(field.page - 1);
    if (field.type === 'Date signed') {
      // The date is the server's (UTC); a page that showed another date must refresh its preview.
      const shown = isObject(cmd.datePreviews) ? cmd.datePreviews[field.id] : undefined;
      if (typeof shown !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(shown)) throw new InvalidPositionedV3Input('Missing date preview');
      if (shown !== field.text) throw new DateChanged('The date changed');
    }
    const image = await renderer.render(field.text), geometry = renderer.geometry(page, placed, image), imageSha256 = await digestHex(image);
    renderer.check(page, placed, image, geometry, draft.templateFields);
    // Signature and Title: the page showed exactly this image at this place, on this document.
    const receipts = field.type === 'Signature' ? cmd.signaturePreviews : field.type === 'Title' ? cmd.textPreviews : null;
    if (receipts !== null && (!isObject(receipts) || receipts[field.id] !== await signaturePreviewHash(cmd.artifactHash, signer.roles_json, signer.fields_json, field.id, field.text, imageSha256, geometry))) throw new PreviewChanged(`${field.type} preview changed`);
    fields.push({ id: field.id, type: field.type, role: placed.role, page: field.page, rect: placed.rect, value: field.text, renderer: { name: renderer.name, sha256: renderer.sha256 }, imageSha256, geometry });
    images.push({ key: fieldImageKey(signer.envelope_id, signatureId, field.id), image });
  }
  // The images go to R2 before the record; one never overwrites another.
  for (const { key, image } of images) {
    const stored = await bucket.put(key, image, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/png' } });
    if (!stored) throw new Error('Image collision');
  }
  return { version: 1, kind: 'fields', inputPageCount: pdf.getPageCount(), role: signer.role, template: draft.templateFields, fields };
}

/**
 * A lost response retried: the same session sending the same request again gets the signature it
 * already made, or null when there is none (or the request differs from it in any way).
 */
export async function retrySignature(db: D1Database, bucket: R2Bucket, cmd: Omit<SignCommand, 'consent'>): Promise<string | null> {
  try {
    if (!/^[a-f0-9]{64}$/.test(cmd.token) || !Number.isSafeInteger(cmd.now)) return null;
    const sessionHash = await digestHex(cmd.token);
    const found = await db.prepare(`SELECT g.*,t.role AS task_role,v.verified_at AS verified_at,v.recipient_email AS verified_email FROM recipient_page_sessions s
      JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
      JOIN signatures g ON g.task_id=t.id AND g.envelope_id=t.envelope_id
      JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
      WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND g.input_artifact_id=? AND g.input_sha256=?`)
      .bind(sessionHash, cmd.origin, cmd.now, cmd.artifactId, cmd.artifactHash).first<SignatureRow & { task_role: string; verified_at: number; verified_email: string }>();
    if (!found) return null;
    const { facts, render } = await verifySignatureRecord(found);
    if (facts.sessionHash !== sessionHash || facts.role !== found.task_role || facts.otpVerifiedAt !== found.verified_at || facts.recipientEmail !== found.verified_email) return null;
    if (render.kind === 'appended-page') {
      if (cmd.values !== undefined) return null;
    } else {
      // Exactly the values signed: the same fields, the same text, and the dates that were drawn.
      const same = (supplied: unknown, expected: Record<string, string>) => {
        const given = supplied ?? {};
        return isObject(given) && Object.keys(given).length === Object.keys(expected).length && Object.entries(expected).every(([id, value]) => Object.hasOwn(given, id) && given[id] === value);
      };
      const entries = (dates: boolean) => Object.fromEntries(render.fields.filter(f => (f.type === 'Date signed') === dates).map(f => [f.id, f.value]));
      if (!isObject(cmd.values) || !same(cmd.values, entries(false)) || !same(cmd.datePreviews, entries(true))) return null;
    }
    // Answered only while the signature still renders from what was saved (and, once rendered,
    // to the PDF stored): its input, images and record. Nothing is written here.
    await processSignature(db, bucket, found.id, { write: false });
    return found.id;
  } catch { return null; }
}
