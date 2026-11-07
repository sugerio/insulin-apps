import { test } from 'node:test';
import assert from 'node:assert/strict';
import { internalEmailDomain, isInternalAddress } from '../src/internal-demo-sink-policy.ts';

test('the internal demo admits only addresses exactly at the configured domain, and nobody without one', () => {
  const env = { INTERNAL_DEMO_EMAIL_DOMAIN: 'internal.example' };
  assert.equal(isInternalAddress(env, 'ana@internal.example'), true);
  for (const bad of ['ana@sub.internal.example', 'ana@internal.example.test', 'Ana Signer <ana@internal.example>', 'ana@other.example', '@internal.example', 42])
    assert.equal(isInternalAddress(env, bad), false, String(bad));
  for (const domain of [undefined, '', 'internal', 'internal.example/', 'INTERNAL.example ', '*.example']) {
    assert.equal(internalEmailDomain({ INTERNAL_DEMO_EMAIL_DOMAIN: domain }), null, String(domain));
    assert.equal(isInternalAddress({ INTERNAL_DEMO_EMAIL_DOMAIN: domain }, 'ana@internal.example'), false, String(domain));
  }
});
