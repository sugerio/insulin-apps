import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/synthetic-seal-cli.ts',import.meta.url));
test('sealing CLI rejects missing opt-in and arbitrary data arguments before any operation',()=>{
  for(const [env,args] of [[{},['start']],[{ESIGN_SYNTHETIC_SEAL:'YES'},['start','envelope-id']],[{ESIGN_SYNTHETIC_SEAL:'YES'},['envelope','private.pdf']],[{ESIGN_SYNTHETIC_SEAL:'YES'},['resume','/tmp/arbitrary-envelope']]] as const) {
    const result=spawnSync(process.execPath,[script,...args],{env:{...process.env,ESIGN_SYNTHETIC_SEAL:'',...env},encoding:'utf8',timeout:15000});
    assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/verified/i);assert.match(result.stderr,/opt-in required|invalid arguments|invalid workspace/i);
  }
});
