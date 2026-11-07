const maxBytes = 5 * 1024 * 1024;
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Create-only R2 building block; callers must separately guard D1 authority and object immutability. */
export async function putCandidatePreparationObject(bucket: R2Bucket, key: string, input: Uint8Array, expectedHash: string): Promise<string> {
  if (!key || key.length > 1024 || input.byteLength < 1 || input.byteLength > maxBytes || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid preparation object');
  // Copy before hashing and writing so the caller cannot change the input across awaits.
  const bytes = new Uint8Array(input);
  if (await sha256(bytes) !== expectedHash) throw new Error('Preparation hash mismatch');
  await bucket.put(key, bytes, {onlyIf: {etagDoesNotMatch: '*'}});
  const stored = await bucket.get(key);
  if (!stored || stored.size !== bytes.byteLength || stored.size > maxBytes) throw new Error('Preparation object conflict');
  const actual = new Uint8Array(await stored.arrayBuffer());
  if (actual.byteLength !== bytes.byteLength || await sha256(actual) !== expectedHash) throw new Error('Preparation object conflict');
  return expectedHash;
}
