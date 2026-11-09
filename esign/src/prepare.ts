/**
 * Preparing an envelope when it is created (POST /v1/envelopes): its id is derived from the
 * creation request, and the template's source is copied once to the envelope's own initial
 * document (D0). A retried creation (same tenant, same Idempotency-Key) gets the same id and so
 * finds the envelope (src/worker.ts compares its request_sha256) or, after a failed attempt,
 * reuses that copy instead of making a second one.
 */

const hex = (bytes: Uint8Array) => Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: ArrayBuffer) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

/** The R2 key of an envelope's initial document. */
export const initialDocumentKey = (envelopeId: string) => `envelopes/${envelopeId}/d0.pdf`;

/**
 * The id of the envelope a creation request makes: the first 16 bytes of the SHA-256 of
 * ["esign-envelope-id-v1", tenant id, Idempotency-Key] (as JSON), shaped as a version 8 UUID.
 */
export async function envelopeIdFor(tenantId: string, idempotencyKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['esign-envelope-id-v1', tenantId, idempotencyKey]))));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** An earlier attempt stored different bytes as this envelope's initial document. */
export class InitialDocumentConflict extends Error {}

/**
 * Copies the template's source object to the envelope's initial document key, unless an earlier
 * attempt already stored the same bytes there. Returns the artifact row to insert with the envelope.
 */
export async function storeInitialDocument(bucket: R2Bucket, sourceKey: string, envelopeId: string): Promise<{ id: string; objectKey: string; sha256: string }> {
  const source = await bucket.get(sourceKey);
  if (!source) throw new Error('Source artifact missing');
  const bytes = await source.arrayBuffer();
  const hash = await sha256(bytes);
  const key = initialDocumentKey(envelopeId);
  const stored = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' } });
  if (!stored) {
    const previous = await bucket.get(key);
    if (!previous) throw new Error('Initial document unavailable');
    if (await sha256(await previous.arrayBuffer()) !== hash) throw new InitialDocumentConflict('Initial document conflict');
  }
  return { id: `d0:${envelopeId}`, objectKey: key, sha256: hash };
}
