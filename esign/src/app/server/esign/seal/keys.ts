/**
 * The seal keys Esign trusts: the public half of every key that has sealed envelopes, with the
 * time it was in use. This list, not the deployment's configuration, is what a seal is verified
 * against, so trusting a key takes a reviewed change to this file, and whoever can change the
 * deployment's secrets can't make a seal of their own key verify.
 *
 * The private half of the current key is the Worker's `ESIGN_SEAL_KEY` binding, a Cloudflare
 * `secret_key` the Worker sees as a non-extractable ECDSA P-256 signing key (config.ts). It is
 * put there by `scripts/put-seal-key.mjs`, which prints the entry to add here.
 *
 * Rotating: add the new key's entry (no `until`) and deploy, put the new private key with the
 * script, then give the old entry its `until`. Never remove an entry: the seals it made would
 * stop verifying. A seal verifies only if its timestamp falls within its key's `from`..`until`,
 * so a retired key that leaks can't seal anything new that verifies.
 */
export type SealKey = {
  /** SHA-256 of the SubjectPublicKeyInfo, hex: the key's fingerprint, shown on certificates. */
  id: string;
  /** The SubjectPublicKeyInfo (DER), base64. */
  spki: string;
  /** From when the key may have sealed, ISO 8601: the time it was made. */
  from: string;
  /** Until when, ISO 8601; absent for the current key. */
  until?: string;
};

export const SEAL_KEYS: readonly SealKey[] = [
  {
    // The first seal key, put on insulin-apps-esign with scripts/put-seal-key.mjs.
    id: '1ba5307352412d37bc32b516dc6b00fb787198efa4b164076e6232a7587d449b',
    spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGzfr9ysfRzD8OZGdiO1xB97ppTsIYVJjFuqDnQJRkoMLKLMj1zyerHv9FTdoZMYcl+dMm0D2bqYve6NgxsZzWw==',
    from: '2026-11-11T08:06:53.424Z',
  },
];

const time = (iso: string | undefined) => (iso === undefined ? undefined : Date.parse(iso));

/** The key that seals now: the one entry without `until`, once its `from` has passed; null if there is none. */
export function currentSealKey(keys: readonly SealKey[], now: number = Date.now()): SealKey | null {
  const current = keys.filter(key => key.until === undefined);
  if (current.length !== 1) return null;
  const from = time(current[0].from);
  return from !== undefined && Number.isFinite(from) && from <= now ? current[0] : null;
}

/** The trusted key with this public key that was in use at `at`, or null. */
export function trustedSealKey(keys: readonly SealKey[], spki: string, at: number): SealKey | null {
  const key = keys.find(candidate => candidate.spki === spki);
  if (!key) return null;
  const from = time(key.from), until = time(key.until);
  if (from === undefined || !Number.isFinite(from) || at < from) return null;
  if (until !== undefined && (!Number.isFinite(until) || at > until)) return null;
  return key;
}
