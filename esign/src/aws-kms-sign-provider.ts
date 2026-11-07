import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { p256DerToP1363 } from './p256-der-signature.ts';
import type { KmsDigestProvider } from './worker-kms-evidence.ts';

type TemporaryCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
type Config = { region: string; keyArn: string; credentials: TemporaryCredentials; fetch: typeof fetch };
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;
const MAX_RESPONSE_BYTES = 4096;
const HOUR = 3600_000;

async function boundedResponse(response: Response): Promise<Uint8Array> {
  if (response.status !== 200 || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(part.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the primary failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Unmounted candidate: credentials, key ARN and SPKI pin must be independently trusted by the caller. */
export function createAwsKmsSignProvider(config: Config): KmsDigestProvider {
  const region = config?.region, arn = config?.keyArn, credentials = config?.credentials, fetchRequest = config?.fetch;
  const match = typeof arn === 'string' && /^arn:aws:kms:([a-z]{2}-[a-z]+-\d):\d{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(arn);
  const expiration = credentials?.expiration instanceof Date ? credentials.expiration.getTime() : NaN;
  const validTime = () => Number.isFinite(expiration) && expiration > Date.now() + 60_000 && expiration <= Date.now() + 12 * HOUR;
  if (!match || match[1] !== region || typeof fetchRequest !== 'function' ||
      !/^ASIA[A-Z0-9]{16}$/.test(credentials?.accessKeyId ?? '') ||
      typeof credentials?.secretAccessKey !== 'string' || !credentials.secretAccessKey || credentials.secretAccessKey.length > 1024 ||
      typeof credentials.sessionToken !== 'string' || !credentials.sessionToken || credentials.sessionToken.length > 16_384 || !validTime()) throw new Error('Invalid KMS configuration');
  const keyArn = arn as string;
  const identity = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken };
  const hostname = `kms.${region}.amazonaws.com`;
  const client = new KMSClient({ region, credentials: identity, maxAttempts: 1, requestHandler: {
    async handle(request: { protocol: string; hostname: string; port?: number; path: string; method: string; query?: Record<string, unknown>; headers: Record<string, string>; body?: string }) {
      if (request.protocol !== 'https:' || request.hostname !== hostname || request.port !== undefined || request.path !== '/' || request.method !== 'POST' || (request.query && Object.keys(request.query).length)) throw new Error();
      const response = await fetchRequest(new Request(`https://${hostname}/`, { method: 'POST', headers: request.headers, body: request.body, redirect: 'manual' }));
      const body = await boundedResponse(response);
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const signature = (parsed as Record<string, unknown>).Signature;
      if (typeof signature !== 'string' || signature.length > 100 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature) || btoa(atob(signature)) !== signature) throw new Error();
      return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body } };
    }
  } });
  return { async signDigest(digest) {
    try {
      if (!validTime() || !(digest instanceof Uint8Array) || !(bufferGetter.call(digest) instanceof ArrayBuffer) || lengthGetter.call(digest) !== 32) throw new Error();
      const result = await client.send(new SignCommand({ KeyId: keyArn, Message: new Uint8Array(digest), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }));
      if (result.KeyId !== keyArn || result.SigningAlgorithm !== 'ECDSA_SHA_256' || !(result.Signature instanceof Uint8Array)) throw new Error();
      return p256DerToP1363(result.Signature);
    } catch { throw new Error('KMS signing failed'); }
  } };
}
