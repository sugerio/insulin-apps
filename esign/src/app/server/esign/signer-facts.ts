/**
 * Evidence of a signer's authority. The host may say, per recipient, the signer's title and the
 * company they sign for, and name the document. The signing page shows them; signing for a company
 * needs a title and the signer's confirmation that they may bind it, and the intent statement
 * names the document and the company. All of it is recorded on the SIGNED audit event.
 */
import { envelopeDetails, taskDetails } from './details.ts';

const MAX_TITLE = 128;
const MAX_ORGANIZATION = 200;
const MAX_DOCUMENT_NAME = 200;

export type SignerFacts = { title?: string; onBehalfOf?: string };

const text = (value: unknown, max: number): string | null | 'invalid' => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return 'invalid';
  return trimmed || null;
};

/** A recipient's title and company from the create request, or 'invalid'. */
export function parseSignerFacts(recipient: { title?: unknown; onBehalfOf?: unknown }): SignerFacts | 'invalid' {
  const title = text(recipient.title, MAX_TITLE), onBehalfOf = text(recipient.onBehalfOf, MAX_ORGANIZATION);
  if (title === 'invalid' || onBehalfOf === 'invalid') return 'invalid';
  return { ...(title ? { title } : {}), ...(onBehalfOf ? { onBehalfOf } : {}) };
}

/** The document's name from the create request: null when absent, or 'invalid'. */
export const parseDocumentName = (value: unknown) => text(value, MAX_DOCUMENT_NAME);

const MAX_VERSION_LABEL = 16;
const MAX_AFTER_SIGNING = 3;
const MAX_AFTER_SIGNING_LINE = 200;

/** Which version of the document is signed, as the host names it ("v3"), and when it was published. */
export type DocumentVersion = { label: string; publishedAt?: string };

/** The document's version from the create request: null when absent, or 'invalid'. */
export function parseDocumentVersion(value: unknown): DocumentVersion | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as { label?: unknown; publishedAt?: unknown };
  const label = text(v.label, MAX_VERSION_LABEL);
  if (label === 'invalid' || !label) return 'invalid';
  if (v.publishedAt === undefined || v.publishedAt === null) return { label };
  if (typeof v.publishedAt !== 'string' || Number.isNaN(Date.parse(v.publishedAt))) return 'invalid';
  return { label, publishedAt: new Date(v.publishedAt).toISOString() };
}

/**
 * What the host says happens once this signer signs (at most three lines), from the create
 * request: null when absent, or 'invalid'. Shown on the signing page only; never evidence.
 */
export function parseAfterSigning(value: unknown): string[] | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_AFTER_SIGNING) return 'invalid';
  const lines: string[] = [];
  for (const line of value) {
    const parsed = text(line, MAX_AFTER_SIGNING_LINE);
    if (parsed === 'invalid' || !parsed) return 'invalid';
    lines.push(parsed);
  }
  return lines.length ? lines : null;
}

/** "Mutual NDA (v3)": the document's name with its version, as the signer agrees to it. */
export function versionedName(documentName: string | null | undefined, version: DocumentVersion | null | undefined): string | null {
  if (!documentName) return null;
  return version ? `${documentName} (${version.label})` : documentName;
}

const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_NAMED_BY = 300;
const MAX_AUTH_METHOD = 40;
const MAX_AUTH_PROVIDER = 80;
const MAX_DOMAIN = 253;

/** Who sent the envelope, as the host says. */
export type Sender = { name: string; email?: string; organization?: string };

/** The envelope's sender from the create request: null when absent, or 'invalid'. */
export function parseSender(value: unknown): Sender | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as { name?: unknown; email?: unknown; organization?: unknown };
  const name = text(v.name, MAX_NAME), email = text(v.email, MAX_EMAIL), organization = text(v.organization, MAX_ORGANIZATION);
  if (name === 'invalid' || email === 'invalid' || organization === 'invalid' || !name) return 'invalid';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'invalid';
  return { name, ...(email ? { email } : {}), ...(organization ? { organization } : {}) };
}

/** Who named the signer, as the host words it (e.g. "Pedro Alves (applicant), accepted Oct 23"). */
export const parseNamedBy = (value: unknown) => text(value, MAX_NAMED_BY);

/**
 * How the host signed the recipient in before asking for a signing link, as the host says. E-sign
 * cannot check it: it is recorded, and shown, as the host's statement.
 */
export type HostAuthentication = { method: string; provider?: string; domain?: string; signedInAt?: string };

/** The host's account of the recipient's sign-in from a recipient-view request: null, or 'invalid'. */
export function parseHostAuthentication(value: unknown): HostAuthentication | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as { method?: unknown; provider?: unknown; domain?: unknown; signedInAt?: unknown };
  const method = text(v.method, MAX_AUTH_METHOD), provider = text(v.provider, MAX_AUTH_PROVIDER), domain = text(v.domain, MAX_DOMAIN);
  if (method === 'invalid' || provider === 'invalid' || domain === 'invalid' || !method || !/^[A-Z][A-Z_]*$/.test(method)) return 'invalid';
  let signedInAt: string | undefined;
  if (v.signedInAt !== undefined && v.signedInAt !== null) {
    if (typeof v.signedInAt !== 'string' || Number.isNaN(Date.parse(v.signedInAt))) return 'invalid';
    signedInAt = new Date(v.signedInAt).toISOString();
  }
  return { method, ...(provider ? { provider } : {}), ...(domain ? { domain } : {}), ...(signedInAt ? { signedInAt } : {}) };
}

/** "Google Workspace sign-in (northbeam.io), stated by the sender's system" for a certificate. */
export function describeHostAuthentication(auth: HostAuthentication): string {
  const how = auth.provider ?? auth.method.replace(/_/g, ' ').toLowerCase();
  return `${how} sign-in${auth.domain ? ` (${auth.domain})` : ''}${auth.signedInAt ? ` at ${auth.signedInAt.replace('.000Z', 'Z')}` : ''}, stated by the sender's system`;
}

/** The sender of an envelope and who named one of its signers, when the host said. */
export async function sendFacts(db: D1Database, envelopeId: string): Promise<{ sender: Sender | null; namedBy: Map<string, string> }> {
  const envelope = await db.prepare('SELECT details_json FROM envelopes WHERE id = ?').bind(envelopeId).first<{ details_json: string }>();
  const tasks = await db.prepare('SELECT id, details_json FROM tasks WHERE envelope_id = ?').bind(envelopeId).all<{ id: string; details_json: string }>();
  return {
    sender: envelopeDetails(envelope?.details_json).sender ?? null,
    namedBy: new Map(tasks.results.flatMap((t) => { const named = taskDetails(t.details_json).namedBy; return named ? [[t.id, named] as const] : []; })),
  };
}

/** A signer's own title as typed on the page: trimmed, bounded, or 'invalid'. */
export const parseSignerTitle = (value: unknown) => text(value, MAX_TITLE);

/** What the signing page shows about the task's signer and the document, as the host said it. */
export type SignerContext = {
  facts: SignerFacts;
  documentName: string | null;
  documentVersion: DocumentVersion | null;
  sender: Sender | null;
  afterSigning: string[];
};

/** The host's facts about the task's signer, the document and its sender. */
export async function signerContext(db: D1Database, taskId: string): Promise<SignerContext> {
  const row = await db.prepare('SELECT t.details_json AS task, e.details_json AS envelope FROM tasks t JOIN envelopes e ON e.id = t.envelope_id WHERE t.id = ?')
    .bind(taskId).first<{ task: string; envelope: string }>();
  const { title, onBehalfOf, afterSigning } = taskDetails(row?.task);
  const envelope = envelopeDetails(row?.envelope);
  return {
    facts: { ...(title ? { title } : {}), ...(onBehalfOf ? { onBehalfOf } : {}) },
    documentName: envelope.documentName ?? null,
    documentVersion: envelope.documentVersion ?? null,
    sender: envelope.sender ?? null,
    afterSigning: afterSigning ?? [],
  };
}

/**
 * The one sentence the signer agrees to: consent to electronic records and signatures, and the
 * intent to sign this document (named with its version) for the company being bound. Its SHA-256
 * is recorded on the SIGNED audit event.
 */
export function consentStatement(documentName: string | null, version: DocumentVersion | null, onBehalfOf: string | undefined): string {
  const name = versionedName(documentName, version);
  return `I agree to use electronic records and signatures, and I intend this to be my signature on ${name ? `the ${name}` : 'this document'}${onBehalfOf ? ` on behalf of ${onBehalfOf}` : ''}.`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

/** The host's sign-in from the last signing link a task's recipient was given (null when it said none). */
export async function lastHostAuthentication(db: D1Database, envelopeId: string, taskId: string): Promise<HostAuthentication | null> {
  const row = await db.prepare("SELECT detail_json FROM audit_events WHERE envelope_id = ? AND task_id = ? AND type = 'RECIPIENT_VIEW_ISSUED' ORDER BY id DESC LIMIT 1")
    .bind(envelopeId, taskId).first<{ detail_json: string | null }>();
  if (!row?.detail_json) return null;
  try {
    const auth = parseHostAuthentication((JSON.parse(row.detail_json) as { hostAuthentication?: unknown }).hostAuthentication);
    return auth === 'invalid' ? null : auth;
  } catch { return null; }
}
