// The one switch, ESIGN_ENV (src/app/server/esign/environment.ts): what dev and prod each allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentOf, prodProblems, signingEnabled, testSealKey } from '../src/app/server/esign/environment.ts';
import { embedderAllowed, frameAncestors } from '../src/app/server/esign/signing-page.ts';
import { MailRelayError, mailerFor, relayConfig } from '../src/app/server/esign/mail.ts';
import { mailRelay } from './helpers/mail-relay.ts';

const KEY = 'k'.repeat(32);
const TEST_MAIL = {};
const KMS_KEY_ARN = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000';
const PROD = { ESIGN_ENV: 'prod', OTP_KEY: KEY, SUGER_MAIL_URL: 'https://mail.example.test/v1/send', SUGER_APP_TOKEN: 'synthetic-app-token', KMS_KEY_ARN };

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
    [{ OTP_KEY: '' }, /ESIGN_OTP_KEY/], [{ SUGER_MAIL_URL: undefined }, /mail relay/], [{ SUGER_APP_TOKEN: '' }, /mail relay/],
    [{ TEST_MAIL }, /test mailbox is bound/], [{ KMS_KEY_ARN: '' }, /ESIGN_KMS_KEY_ARN/],
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

test('the relay is used only at an https address with its token, and refusals are errors, never a send', async () => {
  const relay = mailRelay();
  assert.ok(relayConfig(relay.env));
  for (const change of [{ SUGER_MAIL_URL: '' }, { SUGER_APP_TOKEN: '' }, { SUGER_MAIL_URL: 'http://mail.example.test/send' }, { SUGER_MAIL_URL: 'not a url' }]) {
    assert.equal(relayConfig({ ...relay.env, ...change }), null, JSON.stringify(change));
    assert.equal(mailerFor({ ...relay.env, ...change }, 'org-a'), null);
  }
  assert.ok(relayConfig({ ...relay.env, SUGER_MAIL_URL: 'http://127.0.0.1:8787/send' }), 'plain http on loopback, for local development');
  assert.equal(mailerFor(relay.env, ''), null, 'mail is always for an organization');
  await mailerFor({ ...relay.env, ESIGN_ENV: 'prod' }, 'org-a')!.send('ana@partner.example', 'Hello', 'Body');
  assert.deepEqual(relay.sent.at(-1)!.body, { to: 'ana@partner.example', subject: 'Hello', text: 'Body' });
  assert.equal(relay.sent.at(-1)!.headers.get('x-suger-organization-id'), 'org-a');
  await mailerFor(relay.env, 'org-a')!.send('ana@partner.example', 'Hello', 'Body');
  assert.match(relay.sent.at(-1)!.body.text, /^Body\n\nSent by an E-sign test deployment\./, 'the preview marks what it sends');
  await assert.rejects(mailerFor(relay.env, 'org-a')!.send('not an address', 'Hello', 'Body'), /Invalid recipient/);
  for (const status of [502, 503, 429, 200, 400]) {
    const refusing = mailRelay(() => status);
    await assert.rejects(mailerFor(refusing.env, 'org-a')!.send('ana@partner.example', 'Hello', 'Body'), (error: unknown) => error instanceof MailRelayError && error.status === status, String(status));
  }
});

test('prod lets only https origins embed the signing page', () => {
  const raw = 'https://console.example http://localhost:3000';
  assert.deepEqual(frameAncestors(raw), ['https://console.example', 'http://localhost:3000']);
  assert.deepEqual(frameAncestors(raw, true), ['https://console.example']);
});

test('a framed page opens a session only for the app itself or an origin allowed to embed it', () => {
  const own = 'https://esign.example.test', allowed = ['https://console.example.test'];
  assert.equal(embedderAllowed({ embedded: false }, own, allowed), true, 'not framed');
  assert.equal(embedderAllowed({}, own, allowed), true, 'an older page that does not say');
  assert.equal(embedderAllowed({ embedded: true, embedder: 'https://console.example.test' }, own, allowed), true);
  assert.equal(embedderAllowed({ embedded: true, embedder: own }, own, allowed), true, 'the app frames itself (the member page)');
  for (const embedder of ['https://evil.example.test', '', undefined, 7, 'https://console.example.test/']) {
    assert.equal(embedderAllowed({ embedded: true, embedder }, own, allowed), false, String(embedder));
  }
});
