import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { SignatureV4 } from '@smithy/signature-v4';

/**
 * The KMS half of the managed seal (managed.ts, config.ts): the exact message the seal signs,
 * the KMS `Sign` call that signs its digest (checked against the pinned public key), the DER to
 * P1363 conversion of the signature, and the assumed-role AWS credentials the call uses.
 */

export type TemporaryCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;

// --- The signed message ------------------------------------------------------------------------
// The domain separator is part of every stored seal's signed message. Its text predates the
// managed seal and is kept as is, because changing it would break verification of existing seals.
const DOMAIN = new TextEncoder().encode('esign-worker-evidence-candidate-v1\0');
const MAX_INPUT_BYTES = 1024 * 1024;
const isUnsharedBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && typedArrayBuffer.call(value) instanceof ArrayBuffer;

/** The exact bytes an evidence signature covers: the domain separator, then the input. */
export function evidenceMessage(input: Uint8Array): Uint8Array {
  const message = new Uint8Array(DOMAIN.length + input.length);
  message.set(DOMAIN);
  message.set(input, DOMAIN.length);
  return message;
}

/** Provider signs a SHA-256 digest with ECDSA P-256 and returns IEEE P1363 r||s (64 bytes), not DER. */
export interface KmsDigestProvider {
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * Has `provider` (createAwsKmsSignProvider below) sign evidenceMessage(input) and returns the signature
 * only once it verifies against `pinnedSpki`, the configured public key (KMS_PUBLIC_KEY). Inputs
 * are copied first, so a caller cannot change them while the signature is pending.
 */
export async function signKmsEvidence(input: Uint8Array, pinnedSpki: Uint8Array, provider: KmsDigestProvider): Promise<{ signature: Uint8Array }> {
  if (!isUnsharedBytes(input) || !isUnsharedBytes(pinnedSpki) || !provider || typeof provider.signDigest !== 'function') throw new Error('Invalid KMS signing input');
  const inputLength = typedArrayLength.call(input) as number;
  const spkiLength = typedArrayLength.call(pinnedSpki) as number;
  if (inputLength === 0 || inputLength > MAX_INPUT_BYTES || spkiLength === 0 || spkiLength > 1024) throw new Error('Invalid KMS signing input');
  const message = new Uint8Array(DOMAIN.length + inputLength);
  message.set(DOMAIN);
  message.set(input, DOMAIN.length);
  const spki = new Uint8Array(pinnedSpki);
  try {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
    const returned = await provider.signDigest(digest);
    if (!isUnsharedBytes(returned) || typedArrayLength.call(returned) !== 64) throw new Error();
    const signature = new Uint8Array(returned);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message)) throw new Error();
    return { signature };
  } catch {
    throw new Error('KMS signing failed');
  }
}

// --- The KMS Sign call -------------------------------------------------------------------------
type Config = { region: string; keyArn: string; credentials: TemporaryCredentials; fetch: typeof fetch };
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

/**
 * The managed seal's KMS signer (config.ts): calls KMS `Sign` (ECDSA_SHA_256 over a digest)
 * with the key `keyArn` and the assumed-role credentials (cachedRoleCredentials below), sending the
 * request only to the region's KMS endpoint through `fetch`, and returns the signature as P1363.
 * The key ARN and credentials are trusted configuration; signKmsEvidence (above)
 * checks each signature against the pinned public key.
 */
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
      if (!validTime() || !(digest instanceof Uint8Array) || !(typedArrayBuffer.call(digest) instanceof ArrayBuffer) || typedArrayLength.call(digest) !== 32) throw new Error();
      const result = await client.send(new SignCommand({ KeyId: keyArn, Message: new Uint8Array(digest), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }));
      if (result.KeyId !== keyArn || result.SigningAlgorithm !== 'ECDSA_SHA_256' || !(result.Signature instanceof Uint8Array)) throw new Error();
      return p256DerToP1363(result.Signature);
    } catch { throw new Error('KMS signing failed'); }
  } };
}

// --- DER to P1363 ------------------------------------------------------------------------------
const ORDER = Uint8Array.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'.match(/../g)!, byte => parseInt(byte, 16));

/** Strict DER ECDSA signature to P-256 P1363 encoding. Conversion does not verify the signature. */
export function p256DerToP1363(input: Uint8Array): Uint8Array {
  const invalid = (): never => { throw new Error('Invalid P-256 DER signature'); };
  if (!(input instanceof Uint8Array) || !(typedArrayBuffer.call(input) instanceof ArrayBuffer)) return invalid();
  const length = typedArrayLength.call(input) as number;
  if (length < 8 || length > 72) return invalid();
  const bytes = new Uint8Array(input);
  if (bytes[0] !== 0x30 || bytes[1] !== length - 2) return invalid();
  let offset = 2;
  const readScalar = (): Uint8Array => {
    if (bytes[offset++] !== 2) return invalid();
    const size = bytes[offset++];
    if (!size || size > 33 || offset + size > bytes.length) return invalid();
    const first = bytes[offset];
    if (first & 0x80 || (size > 1 && first === 0 && !(bytes[offset + 1] & 0x80))) return invalid();
    const skip = first === 0 ? 1 : 0;
    const n = size - skip;
    if (n === 0 || n > 32) return invalid();
    const scalar = new Uint8Array(32);
    scalar.set(bytes.subarray(offset + skip, offset + size), 32 - n);
    offset += size;
    let nonzero = false, comparison = 0;
    for (let i = 0; i < 32; i++) {
      nonzero ||= scalar[i] !== 0;
      if (!comparison && scalar[i] !== ORDER[i]) comparison = scalar[i] < ORDER[i] ? -1 : 1;
    }
    if (!nonzero || comparison >= 0) return invalid();
    return scalar;
  };
  const r = readScalar(), s = readScalar();
  if (offset !== bytes.length) return invalid();
  const result = new Uint8Array(64);
  result.set(r); result.set(s, 32);
  return result;
}

// --- Assumed-role credentials (STS) ------------------------------------------------------------
/**
 * Temporary AWS credentials for the Worker. A Cloudflare Worker has no AWS role of its own, so
 * it holds the long-term key of an IAM user whose only permission is sts:AssumeRole on one
 * role, and assumes that role for an hour at a time. The role is what may use the KMS key.
 */

export type LongTermCredentials = { accessKeyId: string; secretAccessKey: string };

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]{1,64}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const SESSION_SECONDS = 3600;
/** Renew this long before expiry, so a credential never expires mid-request. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** SHA-256 and HMAC-SHA256 on WebCrypto, in the shape SignatureV4 expects. */
class Sha256 {
  private readonly secret?: Uint8Array;
  private readonly chunks: Uint8Array[] = [];
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    if (secret !== undefined) this.secret = Sha256.bytes(secret);
  }
  private static bytes(value: string | ArrayBuffer | ArrayBufferView): Uint8Array {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void { this.chunks.push(Uint8Array.from(Sha256.bytes(data))); }
  async digest(): Promise<Uint8Array> {
    const data = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) { data.set(chunk, offset); offset += chunk.length; }
    if (!this.secret) return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  }
  reset(): void { this.chunks.length = 0; }
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1] ?? '';

/** One STS AssumeRole call, signed with SigV4. */
export async function assumeRole(base: LongTermCredentials, roleArn: string, region: string, sessionName: string, fetcher: typeof fetch): Promise<TemporaryCredentials> {
  if (!ROLE_ARN.test(roleArn) || !REGION.test(region) || !/^AKIA[A-Z0-9]{16}$/.test(base.accessKeyId) || !base.secretAccessKey || !/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(sessionName)) throw new Error('Invalid STS configuration');
  const hostname = `sts.${region}.amazonaws.com`;
  const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: roleArn, RoleSessionName: sessionName, DurationSeconds: String(SESSION_SECONDS) }).toString();
  const signer = new SignatureV4({ service: 'sts', region, credentials: base, sha256: Sha256 });
  const signed = await signer.sign({ method: 'POST', protocol: 'https:', hostname, path: '/', headers: { host: hostname, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body });
  const response = await fetcher(new Request(`https://${hostname}/`, { method: 'POST', headers: signed.headers as Record<string, string>, body, redirect: 'manual' }));
  const xml = await response.text();
  if (response.status !== 200 || xml.length > 16384) throw new Error(`STS AssumeRole failed (${response.status})`);
  const credentials = { accessKeyId: tag(xml, 'AccessKeyId'), secretAccessKey: tag(xml, 'SecretAccessKey'), sessionToken: tag(xml, 'SessionToken'), expiration: new Date(tag(xml, 'Expiration')) };
  if (!/^ASIA[A-Z0-9]{16}$/.test(credentials.accessKeyId) || !credentials.secretAccessKey || !credentials.sessionToken || Number.isNaN(credentials.expiration.getTime())) throw new Error('Invalid STS response');
  return credentials;
}

/** Assumed-role credentials, reused across requests of one Worker isolate until shortly before they expire. */
export function cachedRoleCredentials(base: LongTermCredentials, roleArn: string, region: string, sessionName: string, fetcher: typeof fetch, now: () => number = Date.now): () => Promise<TemporaryCredentials> {
  let current: TemporaryCredentials | null = null;
  let pending: Promise<TemporaryCredentials> | null = null;
  return async () => {
    if (current && current.expiration.getTime() - RENEW_BEFORE_MS > now()) return current;
    pending ??= assumeRole(base, roleArn, region, sessionName, fetcher).then(c => { current = c; return c; }).finally(() => { pending = null; });
    return pending;
  };
}
