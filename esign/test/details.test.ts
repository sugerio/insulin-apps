import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelopeDetails, taskDetails } from '../src/details.ts';

test('envelope details keep only known facts with the expected types', () => {
  assert.deepEqual(envelopeDetails(JSON.stringify({
    documentName: 'Services agreement', certificateVersion: 2,
    sender: { name: 'Lee Sender', email: 'lee@example.com', organization: 'Example Co', extra: 'x' }, unknown: true,
  })), { documentName: 'Services agreement', certificateVersion: 2, sender: { name: 'Lee Sender', email: 'lee@example.com', organization: 'Example Co' } });
  assert.deepEqual(envelopeDetails(JSON.stringify({ sender: { email: 'no-name@example.com' }, certificateVersion: '2', documentName: '' })), {});
  for (const raw of [null, undefined, '', 'not json', '[]', '"text"', '42']) assert.deepEqual(envelopeDetails(raw), {});
});

test('task details keep only the title, the company and who named the signer', () => {
  assert.deepEqual(taskDetails(JSON.stringify({ title: 'Director', onBehalfOf: 'Example Co', namedBy: 'Lee Sender', other: 1 })),
    { title: 'Director', onBehalfOf: 'Example Co', namedBy: 'Lee Sender' });
  assert.deepEqual(taskDetails(JSON.stringify({ title: 7, onBehalfOf: null })), {});
  assert.deepEqual(taskDetails('{bad'), {});
});
