import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { p256DerToP1363 } from '../src/p256-der-signature.ts';

const der = (r: number[], s: number[]) => Uint8Array.from([0x30, r.length + s.length + 4, 2, r.length, ...r, 2, s.length, ...s]);
const order = Array.from(Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex'));
const minusOne = [...order]; minusOne[31]--;

test('converts real locally generated P-256 DER signatures for WebCrypto verification', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const data = new TextEncoder().encode('synthetic evidence');
  for (let i = 0; i < 20; i++) {
    const signature = sign('sha256', data, privateKey);
    const result = p256DerToP1363(signature);
    assert.equal(result.length, 64);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, result, data), true);
    result[0] ^= 1;
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, result, data), false);
  }
});

test('accepts scalar boundaries and canonical sign padding', () => {
  const result = p256DerToP1363(der([1], [0, ...minusOne]));
  assert.deepEqual([...result.slice(0, 32)], [...Array(31).fill(0), 1]);
  assert.deepEqual([...result.slice(32)], minusOne);
  assert.equal(p256DerToP1363(der([0, 0x80], [1]))[30], 0);
  assert.equal(p256DerToP1363(der([0, 0x80], [1]))[31], 0x80);
});

test('rejects malformed DER, nonminimal/negative/zero and out-of-range scalars', () => {
  const valid = der([1], [1]);
  const invalid = [
    [], [0x30, 0], [...valid, 0], [0x31, ...valid.slice(1)], [0x30, 0x81, 6, ...valid.slice(2)],
    [0x30, 0x80, ...valid.slice(2), 0, 0], [0x30, 5, ...valid.slice(2)], [0x30, 7, ...valid.slice(2)],
    [0x30, 6, 3, ...valid.slice(3)], [0x30, 6, 2, 0, 2, 2, 1, 1], [0x30, 6, 2, 0x81, 1, 1, 2, 1, 1],
    [0x30, 6, 2, 1, 1, 2, 2, 1], der([0], [1]), der([1], [0]), der([0x80], [1]), der([1], [0xff]),
    der([0, 1], [1]), der([1], [0, 0, 0x80]), der([0, ...order], [1]), der([1], [0, ...order]),
    der([0, ...Array(32).fill(0xff)], [1]), der([1, ...Array(32).fill(0)], [1]),
    der([0, 0x80, ...Array(32).fill(0)], [1]),
    [0x30, 9, 2, 1, 1, 2, 1, 1, 2, 1, 1]
  ];
  for (const bytes of invalid) assert.throws(() => p256DerToP1363(Uint8Array.from(bytes)), `accepted ${Buffer.from(bytes).toString('hex')}`);
});

test('rejects P-384 DER signatures with oversized scalars', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const signature = sign('sha384', new Uint8Array([1]), privateKey);
  assert.throws(() => p256DerToP1363(signature));
});

test('uses actual typed-array length for ordinary subclass views', () => {
  class Forged extends Uint8Array { override get length(): number { return 999; } }
  const value = new Forged(der([1], [1]));
  assert.equal(p256DerToP1363(value).length, 64);
});

test('rejects shared-backed DER even when a subclass forges buffer or length', () => {
  class Forged extends Uint8Array { override get buffer(): ArrayBuffer { return new ArrayBuffer(1); } override get length(): number { return 8; } }
  const data = der([1], [1]); const value = new Forged(new SharedArrayBuffer(data.length)); value.set(data);
  assert.throws(() => p256DerToP1363(value));
});
