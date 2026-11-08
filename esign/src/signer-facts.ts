/**
 * Evidence of a signer's authority. The host may say, per recipient, the signer's title and the
 * company they sign for, and name the document. The signing page shows them; signing for a company
 * needs a title and the signer's confirmation that they may bind it, and the intent statement
 * names the document and the company. All of it is recorded on the SIGNED audit event.
 */

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
  const sender = await db.prepare('SELECT name, email, organization FROM envelope_senders WHERE envelope_id = ?').bind(envelopeId).first<{ name: string; email: string | null; organization: string | null }>();
  const named = await db.prepare('SELECT n.task_id, n.named_by FROM task_named_by n JOIN tasks t ON t.id = n.task_id WHERE t.envelope_id = ?').bind(envelopeId).all<{ task_id: string; named_by: string }>();
  return {
    sender: sender ? { name: sender.name, ...(sender.email ? { email: sender.email } : {}), ...(sender.organization ? { organization: sender.organization } : {}) } : null,
    namedBy: new Map(named.results.map((r) => [r.task_id, r.named_by])),
  };
}

/** A signer's own title as typed on the page: trimmed, bounded, or 'invalid'. */
export const parseSignerTitle = (value: unknown) => text(value, MAX_TITLE);

/** The host's facts about the task's signer, and the document's name. */
export async function signerContext(db: D1Database, taskId: string): Promise<{ facts: SignerFacts; documentName: string | null }> {
  const row = await db.prepare('SELECT f.title, f.on_behalf_of, d.document_name FROM tasks t LEFT JOIN task_signer_facts f ON f.task_id = t.id LEFT JOIN envelope_documents d ON d.envelope_id = t.envelope_id WHERE t.id = ?')
    .bind(taskId).first<{ title: string | null; on_behalf_of: string | null; document_name: string | null }>();
  return {
    facts: { ...(row?.title ? { title: row.title } : {}), ...(row?.on_behalf_of ? { onBehalfOf: row.on_behalf_of } : {}) },
    documentName: row?.document_name ?? null,
  };
}

/** The sentence the signer adopts: it names the document and the company being bound. */
export function intentStatement(documentName: string | null, onBehalfOf: string | undefined): string {
  return `I intend this to be my signature on ${documentName ?? 'this document'}${onBehalfOf ? ` on behalf of ${onBehalfOf}` : ''}.`;
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
