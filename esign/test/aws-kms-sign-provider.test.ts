import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createAwsKmsSignProvider } from '../src/seal/kms.ts';
import { signKmsEvidence } from '../src/seal/kms.ts';
import { TEMPORARY_KEY_ID } from './helpers/synthetic-aws.ts';

const arn = 'arn:aws:kms:us-east-1:000000000000:key/11111111-1111-4111-8111-111111111111';
const credentials = { accessKeyId: TEMPORARY_KEY_ID, secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiration: new Date(Date.now() + 3600_000) };
const input = new TextEncoder().encode('synthetic evidence');
const signedMessage = Buffer.concat([Buffer.from('esign-worker-evidence-candidate-v1\0'), input]);
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ type: 'spki', format: 'der' });
const signature = sign('sha256', signedMessage, privateKey);
const reply = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({ KeyId: arn, SigningAlgorithm: 'ECDSA_SHA_256', Signature: signature.toString('base64'), ...overrides }), { headers: { 'Content-Type': 'application/x-amz-json-1.1' } });
const config = (fetch: typeof globalThis.fetch) => ({ region: 'us-east-1', keyArn: arn, credentials, fetch });

test('sends only bounded digest via injected signed AWS request and locally verifies KMS result', async () => {
  let calls = 0;
  const provider = createAwsKmsSignProvider(config(async (request: Request) => {
    calls++;
    assert.equal(request.url, 'https://kms.us-east-1.amazonaws.com/');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'manual');
    assert.match(request.headers.get('authorization')!, /^AWS4-HMAC-SHA256 /);
    assert.ok(request.headers.get('x-amz-security-token') === credentials.sessionToken, 'session token mismatch');
    assert.equal(request.headers.get('x-amz-target'), 'TrentService.Sign');
    const body = await request.json() as Record<string, string>;
    assert.equal(body.KeyId, arn);
    assert.equal(body.MessageType, 'DIGEST');
    assert.equal(body.SigningAlgorithm, 'ECDSA_SHA_256');
    assert.ok(body.Message === createHash('sha256').update(signedMessage).digest('base64'), 'digest mismatch');
    assert.deepEqual(Object.keys(body).sort(), ['KeyId', 'Message', 'MessageType', 'SigningAlgorithm']);
    return reply();
  }));
  const result = await signKmsEvidence(input, spki, provider);
  assert.equal(result.signature.length, 64);
  assert.equal(calls, 1);
});

test('independently verifies fixed-time SigV4 and rejects tampering offline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-02T03:04:05Z') });
  const fixedCredentials = { ...credentials, expiration: new Date('2026-01-02T04:04:05Z') };
  const hash = (data: string) => createHash('sha256').update(data).digest('hex');
  const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
  const verify = async (request: Request) => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.href !== 'https://kms.us-east-1.amazonaws.com/') return false;
    const auth = request.headers.get('authorization') ?? '';
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8}\/[^/]+\/[^/]+\/aws4_request), SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!match || match[1] !== fixedCredentials.accessKeyId || match[2] !== '20260102/us-east-1/kms/aws4_request') return false;
    const names = match[3].split(';');
    if (new Set(names).size !== names.length || names.join(';') !== [...names].sort().join(';')) return false;
    for (const name of ['host', 'content-length', 'content-type', 'x-amz-date', 'x-amz-security-token', 'x-amz-target', 'x-amz-content-sha256']) if (!names.includes(name)) return false;
    if (request.headers.get('host') !== url.host || request.headers.get('x-amz-date') !== '20260102T030405Z' || request.headers.get('x-amz-security-token') !== fixedCredentials.sessionToken || request.headers.get('x-amz-target') !== 'TrentService.Sign' || request.headers.get('content-type') !== 'application/x-amz-json-1.1') return false;
    const body = await request.clone().text();
    if (request.headers.get('content-length') !== String(Buffer.byteLength(body)) || request.headers.get('x-amz-content-sha256') !== hash(body)) return false;
    const canonicalHeaders: string[] = [];
    for (const name of names) { const value = request.headers.get(name); if (value === null) return false; canonicalHeaders.push(`${name}:${value.trim().replace(/\s+/g, ' ')}\n`); }
    const canonical = `${request.method}\n/\n\n${canonicalHeaders.join('')}\n${match[3]}\n${hash(body)}`;
    const stringToSign = `AWS4-HMAC-SHA256\n20260102T030405Z\n${match[2]}\n${hash(canonical)}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${fixedCredentials.secretAccessKey}`, '20260102'), 'us-east-1'), 'kms'), 'aws4_request');
    return timingSafeEqual(hmac(signingKey, stringToSign), Buffer.from(match[4], 'hex'));
  };
  let calls = 0;
  const provider = createAwsKmsSignProvider({ ...config(async request => {
    calls++;
    const original = request as Request;
    assert.ok(await verify(original), 'independent SigV4 verifier rejected the request');
    const body = await original.clone().text();
    const parsed = JSON.parse(body);
    assert.ok(parsed.KeyId === arn && parsed.MessageType === 'DIGEST' && parsed.SigningAlgorithm === 'ECDSA_SHA_256' && parsed.Message === createHash('sha256').update(signedMessage).digest('base64'), 'incorrect request body');
    const alter = (name: string, value: string) => { const headers = new Headers(original.headers); headers.set(name, value); return new Request(original.clone(), { headers }); };
    const auth = original.headers.get('authorization')!;
    const tampered = [
      alter('authorization', auth.replace('/us-east-1/kms/', '/us-west-2/kms/')),
      alter('authorization', auth.replace('/kms/aws4_request', '/s3/aws4_request')),
      alter('authorization', auth.replace('/20260102/', '/20260103/')),
      alter('authorization', auth.replace(/Signature=[0-9a-f]{64}$/, `Signature=${'0'.repeat(64)}`)),
      alter('authorization', auth.replace('x-amz-target;', '')),
      alter('x-amz-security-token', 'wrong-synthetic-session'),
      alter('x-amz-date', '20260102T030406Z'),
      alter('x-amz-target', 'TrentService.NotSign'),
      alter('host', 'kms.us-west-2.amazonaws.com'),
      alter('amz-sdk-request', 'attempt=9; max=9')
    ];
    const changedBody = body.replace('DIGEST', 'DIGESt');
    const bodyHeaders = new Headers(original.headers);
    bodyHeaders.set('x-amz-content-sha256', hash(changedBody));
    tampered.push(new Request(original.url, { method: 'POST', headers: bodyHeaders, body: changedBody }));
    tampered.push(new Request(`${original.url}?extra=1`, { method: 'POST', headers: original.headers, body }));
    for (const changed of tampered) assert.equal(await verify(changed), false, 'tampered SigV4 request accepted');
    return reply();
  }), credentials: fixedCredentials });
  await signKmsEvidence(input, spki, provider);
  assert.equal(calls, 1);
});

test('rejects incorrect identity, algorithm, DER, HTTP and provider failures without leaking details', async () => {
  for (const response of [reply({ KeyId: arn.replace('000000000000', '111111111111') }), reply({ SigningAlgorithm: 'ECDSA_SHA_384' }), reply({ Signature: 'MAA=' }), reply({ Signature: 'not-base64!!' }), new Response('synthetic-secret', { status: 403 }), new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }), new Response('x'.repeat(4097))]) {
    const provider = createAwsKmsSignProvider(config(async () => response));
    await assert.rejects(() => provider.signDigest(new Uint8Array(32)), { message: 'KMS signing failed' });
  }
  const provider = createAwsKmsSignProvider(config(async () => { throw new Error('synthetic-secret synthetic-session digest'); }));
  await assert.rejects(() => provider.signDigest(new Uint8Array(32)), { message: 'KMS signing failed' });
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' });
  await assert.rejects(() => signKmsEvidence(input, other, createAwsKmsSignProvider(config(async () => reply()))), { message: 'KMS signing failed' });
});

test('requires bounded temporary credential metadata and matching explicit key ARN and region', async () => {
  let calls = 0; const fetch = async () => { calls++; return reply(); };
  for (const values of [
    { credentials: { ...credentials, accessKeyId: 'AKIAEXAMPLE1234567890' } },
    { credentials: { ...credentials, sessionToken: '' } },
    { credentials: { ...credentials, expiration: new Date(Date.now() - 1000) } },
    { credentials: { ...credentials, expiration: new Date(Date.now() + 13 * 3600_000) } },
    { region: 'us-west-2' }, { keyArn: arn.replace(':key/', ':alias/') }, { keyArn: arn.replace('arn:aws:', 'arn:aws-cn:') }
  ]) assert.throws(() => createAwsKmsSignProvider({ ...config(fetch), ...values }));
  const provider = createAwsKmsSignProvider(config(fetch));
  await assert.rejects(() => provider.signDigest(new Uint8Array(31)));
  class Forged extends Uint8Array { override get buffer(): ArrayBuffer { return new ArrayBuffer(32); } override get length(): number { return 32; } }
  await assert.rejects(() => provider.signDigest(new Forged(new SharedArrayBuffer(32))));
  await assert.rejects(() => provider.signDigest(new Forged(31)));
  assert.equal(calls, 0);
});

test('browser-bundled provider signs in workerd with an injected response and no network', async () => {
  const source = `import {createAwsKmsSignProvider, signKmsEvidence} from './src/seal/kms.ts';
export default {async fetch(){let calls=0;const provider=createAwsKmsSignProvider({region:'us-east-1',keyArn:${JSON.stringify(arn)},credentials:{accessKeyId:${JSON.stringify(TEMPORARY_KEY_ID)},secretAccessKey:'synthetic-secret',sessionToken:'synthetic-session',expiration:new Date(Date.now()+3600000)},fetch:async req=>{calls++;if(req.url!=='https://kms.us-east-1.amazonaws.com/'||req.redirect!=='manual')throw Error('invalid');return new Response(${JSON.stringify(JSON.stringify({ KeyId: arn, SigningAlgorithm: 'ECDSA_SHA_256', Signature: signature.toString('base64') }))},{headers:{'content-type':'application/x-amz-json-1.1'}})}});try {const result=await signKmsEvidence(new Uint8Array(${JSON.stringify([...input])}),new Uint8Array(${JSON.stringify([...spki])}),provider);return Response.json({calls,length:result.signature.length});} catch(e) {return Response.json({error:e.message,calls},{status:500});}}};`;
  const built = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text });
  try { const response = await mf.dispatchFetch('http://local.test/'); assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { calls: 1, length: 64 }); } finally { await mf.dispose(); }
});
