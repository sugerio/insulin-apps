import { canonicalJson } from './canonical-json.ts';
import { fieldRenderer, type Box } from './field-renderers.ts';
import { positionedV3Fields } from './positioned-v3-snapshot.ts';
import type { TemplateField } from './template-fields.ts';

/**
 * The stored form of a signature (table `signatures`, migrations/0007_signatures.sql).
 *
 * A row is written once, when the signer signs, and its facts never change after that (database
 * triggers refuse it). Its PDF is rendered afterwards, from the row alone: `status` is PENDING
 * until then and DONE once `output_artifact_id` and `output_sha256` name the signed PDF.
 *
 * - `facts_json`: who signed, when, and how they were identified (SignatureFacts).
 * - `render_json`: what is drawn on the PDF and where (SignatureRender): either a block on the
 *   shared signature page appended to a document without fields, or the values of the signer's
 *   own placed fields with the hash and position of each rendered image.
 * - `event_hash`: SHA-256 of the canonical JSON of {previousHash, envelopeId, sequence,
 *   inputSha256, facts, render}; `previous_hash` is the event hash of the signature before it in
 *   the same envelope (NULL for the first), so the signatures of an envelope form a hash chain.
 */

export type SignatureRow = {
  id: string; envelope_id: string; task_id: string; sequence: number; status: 'PENDING' | 'DONE';
  input_artifact_id: string; input_sha256: string; output_artifact_id: string | null; output_sha256: string | null;
  previous_hash: string | null; event_hash: string; facts_json: string; render_json: string;
  attempts: number; last_error: string | null;
};

export type SignatureFacts = {
  version: 1;
  signatureId: string;
  taskId: string;
  role: string;
  recipientName: string;
  /** The task's email (immutable, migration 0027): the address the one-time code was sent to and verified for. */
  recipientEmail: string;
  /** SHA-256 of the recipient page session token the signer signed with. */
  sessionHash: string;
  /** When that session entered the emailed code (access_sessions.otp_verified_at). */
  otpVerifiedAt: number;
  /** When the signer consented and the signature was accepted (epoch ms, server clock). */
  consentedAt: number;
  inputArtifactId: string;
  /** The consent disclosure the signer agreed to. */
  disclosure?: { version: string; sha256: string };
  /** The title and company the signer signed with, when there were any. */
  authority?: { title?: string; onBehalfOf?: string; authorityConfirmed?: boolean; intentSha256?: string };
};

/** Fieldless documents: one block on the shared signature page, eight blocks to a page. */
export type AppendedPageRender = {
  version: 1;
  kind: 'appended-page';
  renderer: typeof APPENDED_PAGE_RENDERER;
  /** Pages of the input PDF. */
  inputPageCount: number;
  /** Block on the signature page (0 to 7); 0 starts a new page with its heading. */
  slot: number;
  name: string;
  /** The signing time as printed (ISO 8601, UTC). */
  signedAt: string;
};

export type RenderedField = {
  id: string; type: string; role: string; page: number;
  /** The field's box on its page, normalized with a top-left origin. */
  rect: Box;
  /** What the field shows: the typed signature, the title, or the signing date. */
  value: string;
  renderer: { name: string; sha256: string };
  imageSha256: string;
  /** Where the image is drawn, in PDF points with a top-left origin. */
  geometry: Box;
};

/** Documents with placed fields: the signer's own fields, each drawn at its place. */
export type FieldsRender = {
  version: 1;
  kind: 'fields';
  inputPageCount: number;
  role: string;
  /** Every placed field of the document at signing, all signers' (each signature checks it is unchanged). */
  template: TemplateField[];
  fields: RenderedField[];
};

export type SignatureRender = AppendedPageRender | FieldsRender;

export const APPENDED_PAGE_RENDERER = 'helvetica-signature-page-v1';
export const SIGNATURE_PAGE_SLOTS = 8;

const HEX64 = /^[a-f0-9]{64}$/;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const digestHex = async (data: Uint8Array | ArrayBuffer | string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? Uint8Array.from(data) : data));

/** The signed PDF of a signature, as an artifact id and the R2 key it is stored under. */
export const outputArtifactId = (signatureId: string) => `signed:${signatureId}`;
export const artifactObjectKey = (envelopeId: string, artifactId: string) => `envelopes/${envelopeId}/${artifactId}.pdf`;

/** The UTC calendar date a Date signed field shows for a signature accepted at `at`. */
export function signingDate(at: number): string {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid signing time');
  return new Date(at).toISOString().slice(0, 10);
}

export type ChainLink = { previousHash: string | null; envelopeId: string; sequence: number; inputSha256: string };

/** SHA-256 of the canonical JSON of the chain link, the input and the two JSON documents. */
export async function signatureEventHash(link: ChainLink, facts: unknown, render: unknown): Promise<string> {
  return digestHex(canonicalJson({ previousHash: link.previousHash, envelopeId: link.envelopeId, sequence: link.sequence, inputSha256: link.inputSha256, facts, render }));
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isBox = (value: unknown): value is Box => isObject(value) && ['x', 'y', 'width', 'height'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]));
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function parseFacts(value: unknown): SignatureFacts {
  if (!isObject(value) || value.version !== 1) throw new Error('Unsupported signature facts');
  const f = value as SignatureFacts;
  if (![f.signatureId, f.taskId, f.role, f.recipientName, f.recipientEmail, f.inputArtifactId].every(isString) || !HEX64.test(String(f.sessionHash))
    || !isTime(f.otpVerifiedAt) || !isTime(f.consentedAt) || f.otpVerifiedAt > f.consentedAt) throw new Error('Invalid signature facts');
  if (f.disclosure !== undefined && (!isObject(f.disclosure) || !isString(f.disclosure.version) || !HEX64.test(String(f.disclosure.sha256)))) throw new Error('Invalid signature facts');
  if (f.authority !== undefined && !isObject(f.authority)) throw new Error('Invalid signature facts');
  return f;
}

/** Checks a stored render document against the facts; a renderer that has changed since fails closed. */
export function parseRender(value: unknown, facts: SignatureFacts): SignatureRender {
  if (!isObject(value) || value.version !== 1) throw new Error('Unsupported signature rendering');
  const pages = value.inputPageCount;
  // A source has at most 100 pages; signature pages appended to it add to that.
  if (!Number.isSafeInteger(pages) || (pages as number) < 1 || (pages as number) > 1000) throw new Error('Invalid input page count');
  if (value.kind === 'appended-page') {
    const r = value as AppendedPageRender;
    if (r.renderer !== APPENDED_PAGE_RENDERER || !Number.isSafeInteger(r.slot) || r.slot < 0 || r.slot >= SIGNATURE_PAGE_SLOTS
      || r.name !== facts.recipientName || r.signedAt !== new Date(facts.consentedAt).toISOString()) throw new Error('Invalid signature page rendering');
    return r;
  }
  if (value.kind !== 'fields') throw new Error('Unsupported signature rendering');
  const r = value as FieldsRender;
  if (r.role !== facts.role || !Array.isArray(r.template) || !Array.isArray(r.fields)) throw new Error('Invalid field rendering');
  const roles = [...new Set(r.template.map(f => (f as { role?: unknown })?.role))];
  if (roles.some(role => !isString(role))) throw new Error('Invalid field rendering');
  const template = positionedV3Fields(r.template, roles as string[], r.inputPageCount);
  if (canonicalJson(template) !== canonicalJson(r.template)) throw new Error('Invalid field rendering');
  const owned = template.filter(f => f.role === r.role), seen = new Set<string>(), date = signingDate(facts.consentedAt);
  for (const field of r.fields) {
    if (!isObject(field) || !isString(field.id) || seen.has(field.id) || !isString(field.value) || !HEX64.test(String(field.imageSha256)) || !isBox(field.geometry) || !isBox(field.rect)) throw new Error('Invalid rendered field');
    const placed = owned.find(f => f.id === field.id);
    if (!placed || placed.type !== field.type || placed.role !== field.role || placed.page !== field.page || !sameBox(placed.rect, field.rect)) throw new Error('Rendered field is not the placed field');
    const renderer = fieldRenderer(field.type);
    if (!isObject(field.renderer) || field.renderer.name !== renderer.name || field.renderer.sha256 !== renderer.sha256) throw new Error('Renderer changed');
    if (field.type === 'Date signed' && field.value !== date) throw new Error('Invalid signing date');
    seen.add(field.id);
  }
  if (owned.some(f => (f.required || f.type === 'Date signed') && !seen.has(f.id))) throw new Error('Missing rendered field');
  return r;
}

export type VerifiedSignature = { row: SignatureRow; facts: SignatureFacts; render: SignatureRender };

/** Parses a stored signature and checks its event hash; throws when anything does not hold. */
export async function verifySignatureRecord(row: SignatureRow): Promise<VerifiedSignature> {
  const rawFacts: unknown = JSON.parse(row.facts_json), rawRender: unknown = JSON.parse(row.render_json);
  const facts = parseFacts(rawFacts), render = parseRender(rawRender, facts);
  if (facts.signatureId !== row.id || facts.taskId !== row.task_id || facts.inputArtifactId !== row.input_artifact_id || (row.sequence === 1) !== (row.previous_hash === null)) throw new Error('Signature facts mismatch');
  const eventHash = await signatureEventHash({ previousHash: row.previous_hash, envelopeId: row.envelope_id, sequence: row.sequence, inputSha256: row.input_sha256 }, rawFacts, rawRender);
  if (eventHash !== row.event_hash) throw new Error('Event hash mismatch');
  return { row, facts, render };
}

/** The signatures of an envelope, in signing order. */
export async function envelopeSignatures(db: D1Database, envelopeId: string): Promise<SignatureRow[]> {
  return (await db.prepare('SELECT * FROM signatures WHERE envelope_id=? ORDER BY sequence').bind(envelopeId).all<SignatureRow>()).results;
}
