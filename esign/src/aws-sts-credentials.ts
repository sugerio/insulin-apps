import { SignatureV4 } from '@smithy/signature-v4';

/**
 * Temporary AWS credentials for the Worker. A Cloudflare Worker has no AWS role of its own, so
 * it holds the long-term key of an IAM user whose only permission is sts:AssumeRole on one
 * role, and assumes that role for an hour at a time. The role is what may use the KMS key.
 */

export type LongTermCredentials = { accessKeyId: string; secretAccessKey: string };
export type TemporaryCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };

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
