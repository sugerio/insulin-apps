import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenR2RetentionRules } from '../src/r2-retention-screen.ts';

const requirements = { prefix: 'envelopes/', minimumAgeSeconds: 86400 };
const rule = (prefix = 'envelopes/', age = 86400) => ({ enabled: true, prefix, condition: { type: 'Age', maxAgeSeconds: age } });

test('offline screening only reports unverified candidates, never protection', () => {
  for (const rules of [[rule()], [rule('')], [{ enabled: true, condition: { type: 'Indefinite' } }]]) {
    assert.deepEqual(screenR2RetentionRules({ rules }, requirements), { result: 'unverified-candidate' });
  }
});

test('overlapping rules use longest retention, not longest prefix', () => {
  for (const rules of [
    [rule('', 86400), rule('envelopes/tenant/', 60)],
    [rule('envelopes/tenant/', 60), rule('', 86400)],
    [rule('envelopes/', 86400), rule('envelopes/', 60)],
    [{ enabled: true, condition: { type: 'Indefinite' } }, rule('envelopes/tenant/', 60)],
    [rule('envelopes/', 86400), rule('unrelated/', 60)],
  ]) assert.deepEqual(screenR2RetentionRules({ rules }, requirements), { result: 'unverified-candidate' });
  for (const rules of [
    [rule('envelopes/', 60), rule('envelopes/tenant/', 86400)],
    [rule('unrelated/', 86400), rule('envelopes/', 60)],
    [rule('envelopes/', 60), { ...rule('', 86400), enabled: false }],
  ]) assert.deepEqual(screenR2RetentionRules({ rules }, requirements), { result: 'rejected' });
});

test('missing, inadequate, disabled, malformed and unsupported policies fail closed', () => {
  for (const config of [null, {}, { rules: [] }, { rules: [rule('envelopes/a')] }, { rules: [rule('envelopes/', 86399)] }, { rules: [{ ...rule(), enabled: false }] }, { rules: [{ ...rule(), enabled: 'true' }] }, { rules: [{ ...rule(), condition: { type: 'Date', date: '2099-01-01' } }] }, { rules: [rule(), {}] }, { rules: true }]) {
    assert.deepEqual(screenR2RetentionRules(config, requirements), { result: 'rejected' });
  }
  for (const req of [{ prefix: '', minimumAgeSeconds: 1 }, { prefix: 'envelopes/', minimumAgeSeconds: 0 }, { prefix: 'envelopes/', minimumAgeSeconds: NaN }]) {
    assert.deepEqual(screenR2RetentionRules({ rules: [rule()] }, req), { result: 'rejected' });
  }
});
