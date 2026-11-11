import { currentSealKey, type SealKey } from './keys.ts';
import { isSealSigningKey, signEvidence } from './signing.ts';
import { DIGICERT_MISSING_ACCURACY_MS, DIGICERT_TSA_POLICY, DIGICERT_TSA_ISSUERS, DIGICERT_TSA_URL, digicertRoots } from './tsa.ts';
import type { ManagedEvidenceConfig, SealTrust } from './managed.ts';

/**
 * Which seal completes envelopes. With the seal key bound, the managed seal (a signature with
 * that key + an RFC 3161 timestamp):
 *   SEAL_KEY               the Worker's ESIGN_SEAL_KEY binding: a Cloudflare secret_key, a
 *                          non-extractable ECDSA P-256 signing key (signing.ts isSealSigningKey),
 *   SEAL_KEYS              the trusted keys, from keys.ts (the router passes SEAL_KEYS; tests their own).
 * The timestamp authority's trust is fixed in tsa.ts.
 * A bound key that isn't a usable seal key, or no current entry in keys.ts, is an error, never a
 * silent fallback. Without the binding: the HMAC test seal, in dev only (environment.ts
 * testSealKey); prod requires the binding (prodProblems), so it never seals any other way.
 */
export type SealEnv = { SEAL_KEY?: unknown; SEAL_KEYS?: readonly SealKey[] };

const unb64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

/** The trusted seal keys (keys.ts) and timestamp authority: all that verifying a stored seal needs; no private key. */
export function sealTrustFromEnv(env: SealEnv): SealTrust {
  return { keys: env.SEAL_KEYS ?? [], tsa: tsaTrust() };
}

// Fixed in code (tsa.ts) like the seal keys: the deployment's configuration can't add a trusted timestamp authority.
const tsaTrust = () => ({ url: DIGICERT_TSA_URL, roots: digicertRoots(), policies: [DIGICERT_TSA_POLICY], issuerSpkiSha256: [...DIGICERT_TSA_ISSUERS], missingAccuracyMs: DIGICERT_MISSING_ACCURACY_MS });

export async function managedEvidenceFromEnv(env: SealEnv, fetcher: typeof fetch = request => fetch(request)): Promise<ManagedEvidenceConfig | null> {
  if (env.SEAL_KEY === undefined || env.SEAL_KEY === null) return null;
  const key = env.SEAL_KEY;
  if (!isSealSigningKey(key)) throw new Error('ESIGN_SEAL_KEY is not a non-extractable ECDSA P-256 signing key');
  const keys = env.SEAL_KEYS ?? [];
  const current = currentSealKey(keys);
  if (!current) throw new Error('No current seal key in seal/keys.ts');
  const spki = unb64(current.spki);
  const tsa = tsaTrust();
  return {
    sealer: { keyId: current.id, publicKeySpki: spki, tsa, fetch: fetcher, signEvidence: input => signEvidence(input, spki, key) },
    trust: { keys, tsa },
  };
}
