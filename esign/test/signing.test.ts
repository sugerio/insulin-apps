import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/signing.ts';

test('a signer can only sign the current artifact assigned to them', () => {
  const task = { recipientId: 'ana', status: 'ACTIVE' as const, inputArtifactId: 'd0' };
  assert.deepEqual(sign(task, { recipientId: 'ana', inputArtifactId: 'd0', otpVerified: true, consentAccepted: true }), { ...task, status: 'SIGNED' });
  assert.throws(() => sign(task, { recipientId: 'marcus', inputArtifactId: 'd0', otpVerified: true, consentAccepted: true }));
  assert.throws(() => sign(task, { recipientId: 'ana', inputArtifactId: 'old', otpVerified: true, consentAccepted: true }));
  assert.throws(() => sign(task, { recipientId: 'ana', inputArtifactId: 'd0', otpVerified: false, consentAccepted: true }));
  assert.throws(() => sign(task, { recipientId: 'ana', inputArtifactId: 'd0', otpVerified: true, consentAccepted: false }));
  assert.throws(() => sign({ ...task, status: 'SIGNED' }, { recipientId: 'ana', inputArtifactId: 'd0', otpVerified: true, consentAccepted: true }));
});
