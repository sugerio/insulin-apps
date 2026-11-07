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
