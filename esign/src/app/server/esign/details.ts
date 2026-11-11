/**
 * Optional facts about an envelope or a task, kept as JSON in `envelopes.details_json` and
 * `tasks.details_json` so that a new fact needs no new table or column. A fact a query filters
 * on is a real column instead (`tasks.expires_at`). Reading keeps only the known keys with the
 * expected types, so a malformed or unknown value is ignored rather than trusted.
 */
import type { DocumentVersion, Sender, SignerFacts } from './signer-facts.ts';
import { storedMetadata, type Metadata } from './metadata.ts';

/** What the host said about the envelope, and its metadata (metadata.ts). */
export type EnvelopeDetails = { documentName?: string; documentVersion?: DocumentVersion; sender?: Sender; metadata?: Metadata };
/** What the host said about a task's signer, and what it says happens once they sign. */
export type TaskDetails = SignerFacts & { namedBy?: string; afterSigning?: string[] };

const object = (raw: string | null | undefined): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};
const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
const defined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export function envelopeDetails(raw: string | null | undefined): EnvelopeDetails {
  const value = object(raw), sender = object(JSON.stringify(value.sender ?? {})), version = object(JSON.stringify(value.documentVersion ?? {}));
  const name = text(sender.name), label = text(version.label);
  return defined({
    documentName: text(value.documentName),
    documentVersion: label ? defined({ label, publishedAt: text(version.publishedAt) }) : undefined,
    sender: name ? defined({ name, email: text(sender.email), organization: text(sender.organization) }) : undefined,
    metadata: Object.keys(storedMetadata(value.metadata)).length ? storedMetadata(value.metadata) : undefined,
  });
}

export function taskDetails(raw: string | null | undefined): TaskDetails {
  const value = object(raw);
  const after = Array.isArray(value.afterSigning) ? value.afterSigning.filter((line): line is string => typeof line === 'string' && line !== '') : [];
  return defined({ title: text(value.title), onBehalfOf: text(value.onBehalfOf), namedBy: text(value.namedBy), afterSigning: after.length ? after : undefined });
}
