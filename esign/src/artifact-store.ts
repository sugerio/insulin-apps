/** Conditional creation prevents accidental overwrite; it is not WORM retention. */
type Bucket = {
  put(key: string, value: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string } }): Promise<unknown | null>;
};

export async function putArtifact(bucket: Bucket, key: string, bytes: Uint8Array): Promise<{ sha256: string }> {
  const snapshot = Uint8Array.from(bytes);
  const hash = await crypto.subtle.digest('SHA-256', snapshot);
  const sha256 = Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
  const stored = await bucket.put(key, snapshot, { onlyIf: { etagDoesNotMatch: '*' } });
  if (stored === null) throw new Error('Artifact already exists');
  return { sha256 };
}
