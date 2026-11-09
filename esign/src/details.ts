/**
 * Optional facts about an envelope or a task, kept as JSON in `envelopes.details_json` and
 * `tasks.details_json` so that a new fact needs no new table or column. A fact a query filters
 * on is a real column instead (`tasks.expires_at`). Reading keeps only the known keys with the
 * expected types, so a malformed or unknown value is ignored rather than trusted.
 */
import type { Sender, SignerFacts } from './signer-facts.ts';

/** What the host said about the envelope, and the certificate layout it was created with. */
export type EnvelopeDetails = { documentName?: string; sender?: Sender; certificateVersion?: number };
/** What the host said about a task's signer. */
export type TaskDetails = SignerFacts & { namedBy?: string };

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
  const value = object(raw), sender = object(JSON.stringify(value.sender ?? {}));
  const name = text(sender.name);
  return defined({
    documentName: text(value.documentName),
    sender: name ? defined({ name, email: text(sender.email), organization: text(sender.organization) }) : undefined,
    certificateVersion: Number.isInteger(value.certificateVersion) ? value.certificateVersion as number : undefined,
  });
}

export function taskDetails(raw: string | null | undefined): TaskDetails {
  const value = object(raw);
  return defined({ title: text(value.title), onBehalfOf: text(value.onBehalfOf), namedBy: text(value.namedBy) });
}
