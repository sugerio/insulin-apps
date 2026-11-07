import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { createSyntheticFixture } from '../scripts/synthetic-seal-fixture.ts';

const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');

test('fixed synthetic fixture uses the actual signing chain and freezes the delivery bytes', async () => {
  const fixture=await createSyntheticFixture();
  assert.equal(fixture.signatures.length,2);
  assert.deepEqual(fixture.signatures.map(s=>s.recipient_name),['Ana','Marcus']);
  assert.equal(fixture.signatures[0].input_sha256,hash(fixture.artifacts[0]));
  assert.equal(fixture.signatures[0].sha256,hash(fixture.artifacts[1]));
  assert.equal(fixture.signatures[1].input_sha256,hash(fixture.artifacts[1]));
  assert.equal(fixture.signatures[1].sha256,hash(fixture.artifacts[2]));
  assert.ok((await PDFDocument.load(fixture.artifacts[3])).getPageCount()>2);
  let previous='';
  for(const row of fixture.signatures) {
    assert.ok(row.otp_verified_at && row.consented_at);
    assert.equal(row.previous_hash,previous);
    assert.equal(row.event_hash,hash(JSON.stringify(['esign-signature-event-v1',fixture.envelopeId,row.sequence,previous,row.id,row.task_id,row.recipient_name,row.input_artifact_id,row.input_sha256,row.otp_verified_at,row.consented_at])));
    previous=row.event_hash;
  }
});

test('fixture refuses any caller supplied input', async () => {
  await assert.rejects((createSyntheticFixture as (...args:unknown[])=>Promise<unknown>)({envelopeId:'existing'}),/no input/i);
  await assert.rejects((createSyntheticFixture as (...args:unknown[])=>Promise<unknown>)(Buffer.from('private')),/no input/i);
});
