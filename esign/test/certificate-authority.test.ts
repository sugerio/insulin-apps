// The certificate's audit trail names the title and the company a signer signed for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorityFact, describeDevice, signerAuthority } from '../src/app/server/esign/delivery-pdf.ts';

test('a signature for a company shows the title, the company and that authority was confirmed', () => {
  assert.equal(authorityFact({ title: 'Partner Manager', onBehalfOf: 'Northbeam Consulting', authorityConfirmed: true }), 'as Partner Manager, on behalf of Northbeam Consulting (authority confirmed)');
  assert.equal(authorityFact({ title: 'CFO' }), 'as CFO');
});

test('older signatures, and other events, add nothing (their stored PDFs stay reproducible)', () => {
  assert.equal(authorityFact({ signatureId: 's', consentDisclosureVersion: '2026-11-07' }), '');
  assert.equal(authorityFact(null), '');
});

test("each signer's events name the title and company of their own SIGNED event", () => {
  const event = (taskId: string, type: string, detail: Record<string, unknown> | null) => ({ id: 1, envelopeId: 'e', taskId, type, occurredAt: 0, ip: null, userAgent: null, detail });
  const events = [
    event('t1', 'OTP_VERIFIED', null),
    event('t1', 'SIGNED', { title: 'Partner Manager', onBehalfOf: 'Northbeam', authorityConfirmed: true }),
    event('t2', 'SIGNED', { title: 'CFO', onBehalfOf: 'Harness', authorityConfirmed: true }),
  ];
  assert.equal(signerAuthority(events, 't1'), 'as Partner Manager, on behalf of Northbeam (authority confirmed)');
  assert.equal(signerAuthority(events, 't2'), 'as CFO, on behalf of Harness (authority confirmed)');
  assert.equal(signerAuthority(events, 't3'), '');
  assert.equal(signerAuthority(events, undefined), '');
});

test('a browser reads as its name, major version and system; anything else as itself, shortened', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome 141 on macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge 141 on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Firefox 144 on Windows'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari 18 on iOS 18'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome 141 on iOS 18'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome 141 on Android 15'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome 141 on ChromeOS'],
    ['Mozilla/5.0 (Synthetic signer)', 'Mozilla/5.0 (Synthetic signer)'],
    ['node', 'node'],
  ];
  for (const [userAgent, expected] of cases) assert.equal(describeDevice(userAgent), expected, userAgent);
  assert.equal(describeDevice('x'.repeat(200)), `${'x'.repeat(79)}...`);
});
