// The certificate's audit trail names the title and the company a signer signed for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorityFact, signerAuthority } from '../src/app/server/esign/delivery-pdf.ts';

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
