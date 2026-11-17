import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { PDFDocument } from 'pdf-lib';
import type { Env } from './app.ts';
import type { BlobStore } from './blob-store.ts';
import { validateFieldsPdf } from './fields.ts';
import { requireRole } from './ownership.ts';
import { draftDocumentKey } from './prepare.ts';

/**
 * An envelope whose document is uploaded with it, not taken from a template (template_id null): "Upload and send". It
 * starts as a draft (app.ts, saveDraft) naming its signers and their roles; its PDF is uploaded here, as the envelope's
 * initial document (D0, the artifact every envelope is signed from); the field editor places its fields on it
 * (editor-routes.ts, an editing session with `envelopeId`), into the envelope's roles_json and fields_json; and sending
 * it checks all of that as a template's would be (app.ts, sendEnvelope). Its document and fields change only while it
 * is a draft.
 */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** The id of an envelope's initial document, the artifact its first signer signs. */
export const initialDocumentId = (envelopeId: string) => `d0:${envelopeId}`;

/** The roles a draft's request names, in signing order: its recipients' `role`s, when every one is a usable name. */
export function draftRoles(draftJson: string | null): string[] | null {
  let request: { recipients?: unknown } = {};
  try { request = JSON.parse(draftJson ?? '{}') as { recipients?: unknown }; } catch { return null; }
  if (!Array.isArray(request.recipients) || !request.recipients.length || request.recipients.length > 20) return null;
  const roles = request.recipients.map((r: { role?: unknown } | null) => r?.role);
  if (!roles.every((r): r is string => typeof r === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r))) return null;
  return new Set(roles.map((r) => r.toLowerCase())).size === roles.length ? roles : null;
}

/** Each role's signer name, as a draft's request has it so far: shown in the editor beside the role. */
export function draftRoleLabels(draftJson: string | null): Record<string, string> {
  try {
    const request = JSON.parse(draftJson ?? '{}') as { recipients?: { role?: unknown; name?: unknown }[] };
    return Object.fromEntries((request.recipients ?? []).filter((r) => typeof r?.role === 'string' && typeof r?.name === 'string' && r.name.trim()).map((r) => [r.role as string, (r.name as string).trim().slice(0, 100)]));
  } catch { return {}; }
}

/** An uploaded envelope's document, as stored (D0), or null when none was uploaded yet. */
export async function envelopeDocument(db: D1Database, bucket: BlobStore, envelopeId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const row = await db.prepare('SELECT object_key FROM artifacts WHERE id = ? AND envelope_id = ?').bind(initialDocumentId(envelopeId), envelopeId).first<{ object_key: string }>();
  const object = row && await bucket.get(row.object_key);
  return object && object.size <= MAX_DOCUMENT_BYTES ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Once a draft is sent, the initial documents it no longer has (replaced uploads, a try that failed halfway). */
export async function deleteReplacedDocuments(bucket: BlobStore, envelopeId: string, keep: string): Promise<void> {
  const { objects } = await bucket.list({ prefix: `envelopes/${envelopeId}/d0` });
  const replaced = objects.map((o) => o.key).filter((key) => key !== keep);
  if (replaced.length) await bucket.delete(replaced);
}

/** Deletes everything an envelope's draft stored under its key (its uploaded document): when the draft is discarded. */
export async function deleteDraftObjects(bucket: BlobStore, envelopeId: string): Promise<void> {
  const { objects } = await bucket.list({ prefix: `envelopes/${envelopeId}/` });
  if (objects.length) await bucket.delete(objects.map((o) => o.key));
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');

export function mountEnvelopeDocumentRoutes(app: Hono<Env>) {
  // Uploads, or replaces, the PDF of an envelope draft with no template: its editors, admins and owner. A PDF that
  // can't carry placed fields is refused at once (fields.ts). Replacing it clears the fields placed on the one before.
  app.post('/api/envelopes/:id/document', bodyLimit({ maxSize: MAX_DOCUMENT_BYTES }), async (context) => {
    const id = context.req.param('id'), tenantId = context.get('tenantId'), db = context.env.DB;
    const refused = await requireRole(context, 'envelope', id, 'editor');
    if (refused) return refused;
    const envelope = await db.prepare('SELECT status, template_id FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ status: string; template_id: string | null }>();
    if (envelope?.status !== 'DRAFT' || envelope.template_id !== null) return context.json({ error: 'not_an_upload_draft' }, 409);
    if (context.req.header('content-type') !== 'application/pdf') return context.json({ error: 'invalid_file' }, 422);
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await context.req.arrayBuffer());
    if (bytes.length < 5 || bytes.length > MAX_DOCUMENT_BYTES || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return context.json({ error: 'invalid_file' }, 422);
    let pages: number;
    try {
      const pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false });
      pages = pdf.getPageCount();
      if (!pages || pages > 100) throw new Error('pages');
      validateFieldsPdf(pdf);
    } catch { return context.json({ error: 'unsupported_pdf' }, 422); }
    const hash = await sha256(bytes), key = draftDocumentKey(id, hash);
    // Each document is written once, under its own key (the same bytes, the same key), and becomes the draft's only
    // while it is a draft whose document is still the one read here: an upload that loses a race with a send, or with
    // another upload, never touches the document the envelope has. The one it replaces stays until the draft is sent or
    // discarded, for a send that has read it already.
    const current = await db.prepare('SELECT object_key FROM artifacts WHERE id = ? AND envelope_id = ? AND object_key IS NOT NULL').bind(initialDocumentId(id), id).first<{ object_key: string }>();
    await context.env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, onlyIf: { etagDoesNotMatch: '*' } });
    const [stored] = await db.batch([
      db.prepare(`UPDATE envelopes SET roles_json = NULL, fields_json = NULL WHERE id = ? AND tenant_id = ? AND status = 'DRAFT' AND template_id IS NULL
        AND (SELECT a.object_key FROM artifacts a WHERE a.id = ? AND a.envelope_id = envelopes.id) IS ?`).bind(id, tenantId, initialDocumentId(id), current?.object_key ?? null),
      db.prepare(`INSERT INTO artifacts (id, envelope_id, object_key, sha256) SELECT ?, ?, ?, ? WHERE changes() = 1
        ON CONFLICT (id) DO UPDATE SET object_key = excluded.object_key, sha256 = excluded.sha256`).bind(initialDocumentId(id), id, key, hash),
    ]);
    if (stored!.meta.changes !== 1) {
      if (!await db.prepare('SELECT 1 FROM artifacts WHERE object_key = ?').bind(key).first()) await context.env.ARTIFACTS.delete(key);
      return context.json({ error: 'not_an_upload_draft' }, 409);
    }
    return context.json({ id, pages, sha256: hash }, 201);
  });
}
