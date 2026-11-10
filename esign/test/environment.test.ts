// The one switch, ESIGN_ENV (src/environment.ts): what dev and prod each allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentOf, prodProblems, signingEnabled, testSealKey } from '../src/environment.ts';
import { frameAncestors } from '../src/signing-page.ts';
import { mailerFor, recipientMailer, sinkMailer } from '../src/otp-mail-sink.ts';

const KEY = 'k'.repeat(32);
const TEST_MAIL = {} as R2Bucket;
const SEND_EMAIL = { send: async () => ({}) };
const KMS_KEY_ARN = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000';
const PROD = { ESIGN_ENV: 'prod', OTP_KEY: KEY, SEND_EMAIL, MAIL_FROM: 'sign@sender.example', KMS_KEY_ARN };

test('only "prod" is prod; unset or anything else is dev', () => {
  assert.equal(environmentOf({ ESIGN_ENV: 'prod' }), 'prod');
  for (const value of [undefined, '', 'dev', 'PROD', 'production']) assert.equal(environmentOf({ ESIGN_ENV: value }), 'dev', String(value));
});

test('dev signs with the code pepper and a test mailbox; prod with its whole configuration', () => {
  assert.equal(signingEnabled({ OTP_KEY: KEY, TEST_MAIL }), true);
  assert.equal(signingEnabled({ OTP_KEY: KEY }), false, 'dev keeps every code in the test mailbox');
  assert.equal(signingEnabled({ OTP_KEY: 'short', TEST_MAIL }), false);
  assert.equal(signingEnabled(PROD), true);
  assert.deepEqual(prodProblems(PROD), []);
  assert.deepEqual(prodProblems({ OTP_KEY: KEY }), [], 'dev is lenient');
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ OTP_KEY: '' }, /OTP_KEY/], [{ SEND_EMAIL: undefined }, /SEND_EMAIL/], [{ MAIL_FROM: 'nope' }, /MAIL_FROM/],
    [{ MAIL_SINK: 'inbox@sink.example' }, /MAIL_SINK is set/], [{ TEST_MAIL }, /TEST_MAIL bucket is bound/], [{ KMS_KEY_ARN: '' }, /KMS_KEY_ARN/],
  ];
  for (const [change, problem] of cases) {
    const env = { ...PROD, ...change };
    assert.equal(signingEnabled(env), false, problem.source);
    assert.match(prodProblems(env).join('; '), problem);
  }
});

test('the HMAC test seal is dev only, whatever prod is given', () => {
  assert.ok(testSealKey({ TEST_SEAL_KEY: KEY }));
  assert.equal(testSealKey({ TEST_SEAL_KEY: 'short' }), null);
  assert.equal(testSealKey({ ...PROD, TEST_SEAL_KEY: KEY }), null);
});

test('dev with a sink mails the sink, prod mails recipients, and neither falls back to the other', async () => {
  const sent: { to: string; subject: string }[] = [];
  const binding = { send: async (m: { to: string; subject: string }) => { sent.push(m); } };
  const dev = { SEND_EMAIL: binding, MAIL_FROM: 'sign@sender.example', MAIL_SINK: 'inbox@sink.example' };
  assert.ok(sinkMailer(dev));
  assert.equal(recipientMailer(dev), null);
  await mailerFor(dev)!.send('ana@partner.example', 'Hello', 'Body');
  assert.equal(sent.at(-1)!.to, 'inbox@sink.example');
  assert.match(sent.at(-1)!.subject, /^\[E-sign dev\] Hello \(for ana@partner\.example\)$/);
  const prod = { ...dev, ESIGN_ENV: 'prod' };
  assert.equal(sinkMailer(prod), null, 'prod never uses a sink, even one configured');
  await mailerFor(prod)!.send('ana@partner.example', 'Hello', 'Body');
  assert.deepEqual({ to: sent.at(-1)!.to, subject: sent.at(-1)!.subject }, { to: 'ana@partner.example', subject: 'Hello' });
  await assert.rejects(mailerFor(prod)!.send('not an address', 'Hello', 'Body'), /Invalid recipient/);
  assert.equal(mailerFor({ ESIGN_ENV: 'prod', MAIL_FROM: 'sign@sender.example' }), null, 'no binding, no mail');
});

test('dev without a sink mails recipients, marked as dev; a named but unusable sink mails nobody', async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  const binding = { send: async (m: { to: string; subject: string; text: string }) => { sent.push(m); } };
  const dev = { SEND_EMAIL: binding, MAIL_FROM: 'sign@sender.example' };
  assert.equal(sinkMailer(dev), null);
  await mailerFor(dev)!.send('ana@partner.example', 'Hello', 'Body');
  assert.deepEqual({ to: sent.at(-1)!.to, subject: sent.at(-1)!.subject }, { to: 'ana@partner.example', subject: 'Hello' });
  assert.match(sent.at(-1)!.text, /^Body\n\nSent by the E-sign dev environment\./);
  await assert.rejects(mailerFor(dev)!.send('not an address', 'Hello', 'Body'), /Invalid recipient/);
  assert.equal(mailerFor({ ...dev, MAIL_SINK: 'not an address' }), null, 'a sink that is set but unusable never falls back to recipients');
  assert.equal(recipientMailer({ ...dev, MAIL_SINK: 'inbox@sink.example' }), null);
});

test('prod lets only https origins embed the signing page', () => {
  const raw = 'https://console.example http://localhost:3000';
  assert.deepEqual(frameAncestors(raw), ['https://console.example', 'http://localhost:3000']);
  assert.deepEqual(frameAncestors(raw, true), ['https://console.example']);
});
