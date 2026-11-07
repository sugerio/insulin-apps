import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

test('rollout runbook records the reviewed upload standard and its limits', () => {
  const runbook = readFileSync('DEPLOYMENT-RUNBOOK.md', 'utf8').split('### Future isolated synthetic rollout:')[1];
  assert.ok(runbook);
  for (const phrase of [
    '--no-bundle', 'SOURCE-SHA256.txt', 'ALL-SHA256.txt',
    'does not independently prove remote executable bytes',
    'requires remote executable-byte verification', 'served public asset bytes',
    'version metadata', 'script settings', 'zero outstanding challenges',
    'versions secret', '--secrets-file', 'no mail', 'management key',
  ]) assert.ok(runbook.includes(phrase), `missing: ${phrase}`);
  assert.doesNotMatch(runbook, /Establish and review a provider-supported byte-retrieval comparison or stop/);
});
