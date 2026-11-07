import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadFixedSyntheticFixture} from '../scripts/synthetic-seal-fixed.ts';
import {createManifest,verifyManifest} from '../scripts/synthetic-seal-manifest.ts';

test('resume uses only the hash-pinned locally generated synthetic fixture',async()=>{
  const fixture=await loadFixedSyntheticFixture();
  const manifest=createManifest(fixture,'a'.repeat(64));
  assert.equal(verifyManifest(manifest,fixture.artifacts,'a'.repeat(64)),true);
  await assert.rejects((loadFixedSyntheticFixture as (...args:unknown[])=>Promise<unknown>)({envelopeId:'existing'}));
});
