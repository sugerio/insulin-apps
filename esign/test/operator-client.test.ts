import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

test('synthetic operator private client regression', () => {
  const result = spawnSync('python3', ['test/operator-client.test.py'], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'scripts' },
  });
  assert.equal(result.status, 0, result.stderr);
});
