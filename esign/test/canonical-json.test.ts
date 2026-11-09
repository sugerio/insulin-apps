import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/canonical-json.ts';
import { signatureEventHash } from '../src/signatures.ts';

test('canonical JSON sorts object keys at every depth and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
  // Keys sort by UTF-16 code units, as Array.prototype.sort does.
  assert.equal(canonicalJson({ b: 0, B: 0, é: 0, a: 0 }), '{"B":0,"a":0,"b":0,"é":0}');
});

test('canonical JSON writes strings and numbers as plain JSON and round-trips', () => {
  assert.equal(canonicalJson('line\n"quoted"\u0001'), JSON.stringify('line\n"quoted"\u0001'));
  assert.equal(canonicalJson('Zoë 李'), '"Zoë 李"');
  for (const n of [0, -1, 1.5, 0.1 + 0.2, 1e21, 5e-7, 123.456, Number.MAX_SAFE_INTEGER]) assert.equal(canonicalJson(n), JSON.stringify(n));
  assert.equal(canonicalJson(-0), '0');
  const value = { geometry: { x: 59.99999999999999, y: 80, width: 103.125, height: 30 }, text: 'Ana' };
  assert.equal(canonicalJson(JSON.parse(canonicalJson(value))), canonicalJson(value));
});

test('canonical JSON refuses values that do not round-trip', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, () => 1, Symbol('s'), 1n, new Date(0), new Map(), { a: undefined }, [1, undefined], { a: { b: NaN } }]) {
    assert.throws(() => canonicalJson(value), `${String(value)} must be refused`);
  }
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
});

test('the event hash is the SHA-256 of the canonical chain link, input, facts and render', async () => {
  const link = { previousHash: null, envelopeId: 'env', sequence: 1, inputSha256: 'a'.repeat(64) };
  const facts = { version: 1, consentedAt: 2, recipientName: 'Ana' }, render = { version: 1, kind: 'appended-page', slot: 0 };
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    `{"envelopeId":"env","facts":{"consentedAt":2,"recipientName":"Ana","version":1},"inputSha256":"${'a'.repeat(64)}","previousHash":null,"render":{"kind":"appended-page","slot":0,"version":1},"sequence":1}`,
  ))).toString('hex');
  assert.equal(await signatureEventHash(link, facts, render), expected);
  // Key order does not matter; every value does.
  assert.equal(await signatureEventHash(link, { recipientName: 'Ana', consentedAt: 2, version: 1 }, render), expected);
  for (const [l, f, r] of [
    [{ ...link, previousHash: 'b'.repeat(64) }, facts, render],
    [{ ...link, sequence: 2 }, facts, render],
    [{ ...link, envelopeId: 'other' }, facts, render],
    [{ ...link, inputSha256: 'c'.repeat(64) }, facts, render],
    [link, { ...facts, consentedAt: 3 }, render],
    [link, facts, { ...render, slot: 1 }],
  ] as const) assert.notEqual(await signatureEventHash(l, f, r), expected);
});
