import { createAwsKmsSignProvider } from './aws-kms-sign-provider.ts';
import { signKmsEvidence } from './worker-kms-evidence.ts';
import { cachedRoleCredentials, type TemporaryCredentials } from './aws-sts-credentials.ts';
import { DIGICERT_MISSING_ACCURACY_MS, DIGICERT_TSA_POLICY, DIGICERT_TSA_SIGNERS, DIGICERT_TSA_URL, digicertRoots } from './tsa-trust.ts';
import type { ManagedEvidenceConfig } from './managed-evidence.ts';

/**
 * Which seal completes envelopes. With KMS_KEY_ARN set, the managed seal (KMS + TSA), with
 *   KMS_KEY_ARN            the P-256 SIGN_VERIFY key,
 *   KMS_PUBLIC_KEY         its SubjectPublicKeyInfo, base64 (pinned: a signature must verify with it),
 *   AWS_ROLE_ARN           the role allowed to sign with the key,
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (secrets) an IAM user that may only assume that role,
 *   KMS_TRUSTED_KEY_SHA256 optional earlier keys' SPKI SHA-256s, still trusted to verify old seals,
 *   TSA_SIGNER_SPKI_SHA256 optional extra DigiCert signer pins, for when DigiCert rotates.
 * A managed seal configuration that is incomplete is an error, never a silent fallback. Without
 * KMS_KEY_ARN: the HMAC test seal, in dev only (environment.ts testSealKey); prod requires
 * KMS_KEY_ARN (prodProblems), so it never seals any other way.
 */
export type SealEnv = {
  KMS_KEY_ARN?: string; KMS_PUBLIC_KEY?: string; KMS_TRUSTED_KEY_SHA256?: string;
  AWS_ROLE_ARN?: string; AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string; TSA_SIGNER_SPKI_SHA256?: string;
};

const KEY_ARN = /^arn:aws:kms:([a-z]{2}-[a-z]+-\d):\d{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashes = (value: string | undefined) => {
  const items = (value ?? '').split(/[\s,]+/).filter(Boolean);
  if (items.some(x => !/^[0-9a-f]{64}$/.test(x))) throw new Error('Invalid SHA-256 list');
  return items;
};
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

// Assumed-role credentials live as long as the Worker isolate; one cache per IAM user and role.
const credentialCaches = new Map<string, () => Promise<TemporaryCredentials>>();

export async function managedEvidenceFromEnv(env: SealEnv, fetcher: typeof fetch = request => fetch(request)): Promise<ManagedEvidenceConfig | null> {
  if (!env.KMS_KEY_ARN) return null;
  const keyArn = env.KMS_KEY_ARN ?? '', match = KEY_ARN.exec(keyArn);
  let spki: Uint8Array;
  try { spki = Uint8Array.from(atob(env.KMS_PUBLIC_KEY ?? ''), c => c.charCodeAt(0)); } catch { spki = new Uint8Array(); }
  const { AWS_ROLE_ARN: roleArn, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!match || spki.length < 64 || spki.length > 256 || !roleArn || !accessKeyId || !secretAccessKey) throw new Error('The managed seal (KMS_KEY_ARN) is not fully configured');
  const region = match[1];
  const cacheKey = `${accessKeyId}|${roleArn}|${region}`;
  let credentials = credentialCaches.get(cacheKey);
  if (!credentials) { credentials = cachedRoleCredentials({ accessKeyId, secretAccessKey }, roleArn, region, 'esign-worker', fetcher); credentialCaches.set(cacheKey, credentials); }
  const getCredentials = credentials;
  const tsa = { url: DIGICERT_TSA_URL, roots: digicertRoots(), policies: [DIGICERT_TSA_POLICY], signerSpkiSha256: [...DIGICERT_TSA_SIGNERS, ...hashes(env.TSA_SIGNER_SPKI_SHA256)], missingAccuracyMs: DIGICERT_MISSING_ACCURACY_MS };
  return {
    sealer: {
      keyArn, publicKeySpki: spki, tsa, fetch: fetcher,
      async signEvidence(input) {
        const provider = createAwsKmsSignProvider({ region, keyArn, credentials: await getCredentials(), fetch: fetcher });
        return (await signKmsEvidence(input, spki, provider)).signature;
      },
    },
    trust: { publicKeySha256: [hex(await crypto.subtle.digest('SHA-256', Uint8Array.from(spki))), ...hashes(env.KMS_TRUSTED_KEY_SHA256)], tsa },
  };
}
