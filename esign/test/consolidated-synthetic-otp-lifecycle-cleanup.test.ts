import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readdir,realpath,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('rejected staged path does not leave a lifecycle temporary directory',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'lifecycle-cleanup-test-'));
 try {
  const temp=join(root,'temp'), target=join(root,'target'), staged=join(root,'staged');
  await mkdir(temp); await mkdir(target); await symlink(target,staged);
  const env={...process.env,TMPDIR:temp,TMP:temp,TEMP:temp,ESIGN_STAGED_DIR:staged};
  delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test','--test-name-pattern=staged lifetime quota','test/consolidated-synthetic-otp-lifecycle-workerd.test.ts'],{
   encoding:'utf8',env,timeout:30000
  });
  assert.equal(result.status,1,`${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout,/symlink:/);
  assert.deepEqual(await readdir(temp),[]);
 } finally {await rm(root,{recursive:true,force:true});}
});
