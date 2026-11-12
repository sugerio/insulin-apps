// The trusted seal keys (seal/keys.ts): which one seals now, which one a seal may be verified with, and that the
// list the app ships is well formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SEAL_KEYS, currentSealKey, trustedSealKey, type SealKey } from '../src/app/server/esign/seal/keys.ts';

const HOUR = 3600_000;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const key = (spki: string, from: number, until?: number): SealKey => ({ id: spki.padEnd(64, '0'), spki, from: new Date(from).toISOString(), ...(until === undefined ? {} : { until: new Date(until).toISOString() }) });

test('the current key is the one entry without an end, once it has started', () => {
  const retired = key('a', NOW - 10 * HOUR, NOW - 5 * HOUR), current = key('b', NOW - 5 * HOUR);
  assert.equal(currentSealKey([retired, current], NOW), current);
  assert.equal(currentSealKey([], NOW), null);
  assert.equal(currentSealKey([retired], NOW), null, 'only retired keys');
  assert.equal(currentSealKey([key('c', NOW + HOUR)], NOW), null, 'not started yet: its seals would not verify');
  assert.equal(currentSealKey([current, key('d', NOW - HOUR)], NOW), null, 'two current keys are a mistake, not a choice');
  assert.equal(currentSealKey([{ ...current, from: 'not a time' }], NOW), null);
});

test('a key is trusted only for timestamps within its time in use', () => {
  const keys = [key('a', NOW - 10 * HOUR, NOW - 5 * HOUR), key('b', NOW - 5 * HOUR)];
  assert.equal(trustedSealKey(keys, 'a', NOW - 6 * HOUR)?.spki, 'a');
  assert.equal(trustedSealKey(keys, 'a', NOW - 5 * HOUR)?.spki, 'a', 'its end is inclusive');
  assert.equal(trustedSealKey(keys, 'a', NOW - HOUR), null, 'a retired key seals nothing new');
  assert.equal(trustedSealKey(keys, 'a', NOW - 11 * HOUR), null, 'nor anything before it was made');
  assert.equal(trustedSealKey(keys, 'b', NOW + 100 * HOUR)?.spki, 'b', 'the current key has no end');
  assert.equal(trustedSealKey(keys, 'c', NOW), null, 'an unlisted key');
});

test('the shipped keys are well formed: fingerprints match, times parse and follow, at most one current', async () => {
  const ids = new Set<string>();
  for (const entry of SEAL_KEYS) {
    const spki = Buffer.from(entry.spki, 'base64');
    assert.equal(spki.toString('base64'), entry.spki, 'canonical base64');
    assert.equal(entry.id, createHash('sha256').update(spki).digest('hex'), 'the id is the SHA-256 of the public key');
    await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const from = Date.parse(entry.from);
    assert.ok(Number.isFinite(from), entry.from);
    if (entry.until !== undefined) assert.ok(Date.parse(entry.until) > from, entry.until);
    assert.ok(!ids.has(entry.id), 'listed once');
    ids.add(entry.id);
  }
  assert.ok(SEAL_KEYS.filter(entry => entry.until === undefined).length <= 1);
});
