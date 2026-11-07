/** Opt-in, synthetic-only AWS CLI probe; never accepts document or envelope data. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { awsProfile } from './aws-profile.ts';

export const SYNTHETIC_MESSAGE = Buffer.from('esign local synthetic KMS test v1\n');
type AwsResponse = Record<string, unknown>;
type AwsCall = (args: string[]) => Promise<AwsResponse>;
const key = 'alias/esign-local-test-signing';
const algorithm = 'ECDSA_SHA_256';

export async function runSyntheticKmsCheck(aws: AwsCall): Promise<void> {
  const publicResponse = await aws(['get-public-key', '--key-id', key]);
  if (publicResponse.KeySpec !== 'ECC_NIST_P256' || publicResponse.KeyUsage !== 'SIGN_VERIFY' ||
      !Array.isArray(publicResponse.SigningAlgorithms) || !publicResponse.SigningAlgorithms.includes(algorithm) ||
      typeof publicResponse.KeyId !== 'string' || typeof publicResponse.PublicKey !== 'string') throw new Error('Unexpected KMS public key metadata');
  const publicKey = createPublicKey({ key: Buffer.from(publicResponse.PublicKey, 'base64'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Unexpected public key type');
  const dir = await mkdtemp(join(tmpdir(), 'esign-kms-synthetic-'));
  try {
    const digestPath = join(dir, 'digest');
    await writeFile(digestPath, createHash('sha256').update(SYNTHETIC_MESSAGE).digest(), { mode: 0o600 });
    const response = await aws(['sign', '--key-id', key, '--message', `fileb://${digestPath}`, '--message-type', 'DIGEST', '--signing-algorithm', algorithm]);
    if (response.KeyId !== publicResponse.KeyId || response.SigningAlgorithm !== algorithm || typeof response.Signature !== 'string' ||
        !verify('sha256', SYNTHETIC_MESSAGE, publicKey, Buffer.from(response.Signature, 'base64'))) throw new Error('KMS signature verification failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const exec = promisify(execFile);
  await runSyntheticKmsCheck(async args => {
    // Do not print CLI output or errors: responses include account-specific key IDs.
    const { stdout } = await exec('aws', ['kms', ...args, '--profile', awsProfile(), '--region', 'us-west-2', '--output', 'json', '--no-cli-pager'], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout) as AwsResponse;
  });
  console.log('Synthetic KMS SHA-256 digest signature verified with the retrieved public key. No envelope or D3 was sealed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Synthetic KMS check failed; verify local SSO session, key permissions and connectivity.'); process.exitCode = 1; });
}
