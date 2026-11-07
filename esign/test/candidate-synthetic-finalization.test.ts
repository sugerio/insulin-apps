import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as synthetic from '../src/synchronous-positioned-v3-tsa-test.ts';

test('candidate synthetic finalization exposes a private injected test composition',()=>{
 assert.equal(typeof (synthetic as Record<string,unknown>).createCandidateSyntheticTsaTestFinalizer,'function');
});
