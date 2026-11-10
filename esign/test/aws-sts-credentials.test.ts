import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assumeRole, cachedRoleCredentials } from '../src/app/server/esign/seal/kms.ts';
import { LONG_TERM_KEY_ID, TEMPORARY_KEY_ID } from './helpers/synthetic-aws.ts';

const BASE = { accessKeyId: LONG_TERM_KEY_ID, secretAccessKey: 'synthetic-secret-key' };
const ROLE = 'arn:aws:iam::123456789012:role/esign-dev-signer';
const xml = (expiration: string) => `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${TEMPORARY_KEY_ID}</AccessKeyId><SecretAccessKey>temp-secret</SecretAccessKey><SessionToken>temp-token</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`;

test('assumes the role with a SigV4-signed STS request and returns its temporary credentials', async () => {
  let seen: Request | undefined, body = '';
  const fetcher = (async (request: Request) => { seen = request; body = await request.text(); return new Response(xml('2026-11-07T10:00:00Z'), { status: 200 }); }) as typeof fetch;
  const credentials = await assumeRole(BASE, ROLE, 'us-west-2', 'esign-dev-worker', fetcher);
  assert.deepEqual(credentials, { accessKeyId: TEMPORARY_KEY_ID, secretAccessKey: 'temp-secret', sessionToken: 'temp-token', expiration: new Date('2026-11-07T10:00:00Z') });
  assert.equal(seen?.url, 'https://sts.us-west-2.amazonaws.com/');
  assert.equal(seen?.method, 'POST');
  assert.ok((seen?.headers.get('authorization') ?? '').startsWith(`AWS4-HMAC-SHA256 Credential=${LONG_TERM_KEY_ID}/`));
  assert.match(seen?.headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=[A-Z0-9]{20}\/\d{8}\/us-west-2\/sts\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$/);
  assert.equal(new URLSearchParams(body).get('Action'), 'AssumeRole');
  assert.equal(new URLSearchParams(body).get('RoleArn'), ROLE);
  assert.equal(new URLSearchParams(body).get('DurationSeconds'), '3600');
});

test('refuses bad configuration and STS failures', async () => {
  const ok = (async () => new Response(xml('2026-11-07T10:00:00Z'))) as typeof fetch;
  await assert.rejects(assumeRole({ ...BASE, accessKeyId: TEMPORARY_KEY_ID }, ROLE, 'us-west-2', 'esign-dev-worker', ok), /Invalid STS configuration/, 'the long-term key is an IAM user key');
  await assert.rejects(assumeRole(BASE, 'arn:aws:iam::123456789012:user/x', 'us-west-2', 'esign-dev-worker', ok), /Invalid STS configuration/);
  await assert.rejects(assumeRole(BASE, ROLE, 'us-west-2', 'esign-dev-worker', (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as typeof fetch), /STS AssumeRole failed \(403\)/);
  await assert.rejects(assumeRole(BASE, ROLE, 'us-west-2', 'esign-dev-worker', (async () => new Response('<x/>')) as typeof fetch), /Invalid STS response/);
});

test('reuses credentials until five minutes before they expire, with one call at a time', async () => {
  let calls = 0, clock = Date.parse('2026-11-07T09:00:00Z');
  const fetcher = (async () => { calls++; return new Response(xml(new Date(clock + 3600_000).toISOString())); }) as typeof fetch;
  const get = cachedRoleCredentials(BASE, ROLE, 'us-west-2', 'esign-dev-worker', fetcher, () => clock);
  await Promise.all([get(), get(), get()]);
  assert.equal(calls, 1);
  clock += 50 * 60 * 1000; await get(); assert.equal(calls, 1);
  clock += 6 * 60 * 1000; await get(); assert.equal(calls, 2);
});
