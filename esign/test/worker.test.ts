import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/platform.ts';
import app from '../src/app/server/esign/app.ts';

test('health answers without disclosing configuration, and signing routes are closed until signing is configured', async () => {
  const health = await app.fetch(new Request('http://localhost/api/health'), {} as never);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'esign' });
  for (const ESIGN_ENV of ['prod', 'dev']) {
    const signing = await app.fetch(new Request('http://localhost/api/public/signing/current', { headers: { authorization: `Bearer ${'0'.repeat(64)}` } }), { ESIGN_ENV } as never);
    assert.equal(signing.status, 404, ESIGN_ENV);
  }
  const unknown = await app.fetch(new Request('http://localhost/v1/signing-sessions/a/tasks/b/sign', { method: 'POST' }), {} as never);
  assert.equal(unknown.status, 404, 'the old routes are gone');
});
