import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realSyntheticDependencies} from '../scripts/synthetic-seal-remote.ts';

test('real adapter rejects non-fixed KMS commands before executing AWS CLI',async()=>{
 const deps=await realSyntheticDependencies();
 for(const args of [[],['get-public-key','--key-id','alias/other'],['get-public-key','--key-id','alias/esign-local-test-signing','--endpoint-url','http://evil.test'],['sign','--key-id','alias/esign-local-test-signing','--message','fileb:///tmp/other','--message-type','DIGEST','--signing-algorithm','ECDSA_SHA_256']]) {
  await assert.rejects(deps.aws(args),/Invalid KMS command/);
 }
});
