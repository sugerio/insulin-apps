import { test } from 'node:test';
import assert from 'node:assert/strict';
const worker = await import('../src/worker.ts').catch(() => ({ default: undefined }));

test('health is available but unimplemented signing routes are closed', async () => {
  assert.ok(worker.default, 'worker is not implemented');
  const health = await worker.default.fetch(new Request('http://localhost/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'esign', mode: 'experimental' });
  const signing = await worker.default.fetch(new Request('http://localhost/v1/signing-sessions/a/tasks/b/sign', { method: 'POST' }));
  assert.equal(signing.status, 404);
});
