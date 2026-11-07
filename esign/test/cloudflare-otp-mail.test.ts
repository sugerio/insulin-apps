import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflareOtpMailer } from '../src/cloudflare-otp-mail.ts';

test('Cloudflare OTP mail requires explicit configuration and a binding', () => {
  assert.throws(() => createCloudflareOtpMailer({}));
  assert.throws(() => createCloudflareOtpMailer({ enabled: 'true', from: 'sign@example.com' }));
  assert.throws(() => createCloudflareOtpMailer({ enabled: 'false', from: 'sign@example.com', binding: { send: async () => ({}) } }));
  assert.throws(() => createCloudflareOtpMailer({ enabled: 'true', from: 'bad\r\nBcc: x@example.com', binding: { send: async () => ({}) } }));
});

test('rejects trailing line terminators in sender, recipient and OTP', async () => {
  const messages: unknown[] = [];
  const binding = { send: async (message: unknown) => { messages.push(message); return {}; } };
  for (const ending of ['\n', '\r\n']) {
    assert.throws(() => createCloudflareOtpMailer({ enabled: 'true', from: `sign@example.com${ending}`, binding }));
    const send = createCloudflareOtpMailer({ enabled: 'true', from: 'sign@example.com', binding });
    await assert.rejects(() => send(`ana@example.com${ending}`, '123456'));
    await assert.rejects(() => send('ana@example.com', `123456${ending}`));
  }
  assert.deepEqual(messages, []);
});

test('sends only the intended plain-text OTP and suppresses provider errors', async () => {
  const messages: unknown[] = [];
  const send = createCloudflareOtpMailer({ enabled: 'true', from: 'sign@example.com', binding: { send: async message => { messages.push(message); return {}; } } });
  assert.equal(await send('ana@example.com', '123456'), undefined);
  assert.deepEqual(messages, [{ from: 'sign@example.com', to: 'ana@example.com', subject: 'Your signing verification code', text: 'Your signing verification code is 123456. It expires in 5 minutes.' }]);
  await assert.rejects(() => send('ana@example.com\r\nBcc: x@example.com', '123456'));
  await assert.rejects(() => send('ana@example.com', 'bad'));
  assert.equal(messages.length, 1);
  const failing = createCloudflareOtpMailer({ enabled: 'true', from: 'sign@example.com', binding: { send: async () => { throw new Error('123456 ana@example.com'); } } });
  await assert.rejects(() => failing('ana@example.com', '123456'), { message: 'Email delivery failed' });
});
