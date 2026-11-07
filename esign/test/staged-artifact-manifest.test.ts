import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateStagedManifest} from './staged-artifact-manifest.ts';

const hash='a'.repeat(64);
const assets=['candidate.html','candidate-editor.html','assets/app.js'];
const paths=['wrangler.json','build/consolidated-worker.mjs','build/worker.mjs',...assets.map(p=>'build/client/'+p)];
const manifest=(entries:string[])=>entries.map(p=>`${hash}  ${p}`).join('\n')+'\n';

test('staged manifest requires the exact worker, config and served asset set',()=>{
 assert.equal(validateStagedManifest(manifest(paths),assets).size,paths.length);
 for(const missing of paths) assert.throws(()=>validateStagedManifest(manifest(paths.filter(p=>p!==missing)),assets),missing);
 for(const extra of ['build/client/assets/extra.js','other.txt','build/client/../worker.mjs']) assert.throws(()=>validateStagedManifest(manifest([...paths,extra]),assets),extra);
 assert.throws(()=>validateStagedManifest(manifest([...paths,paths[0]]),assets));
 assert.throws(()=>validateStagedManifest(manifest(paths).replace(hash,'invalid'),assets));
 assert.throws(()=>validateStagedManifest(manifest(paths),[...assets,'assets/missing.js']));
});

import {mkdtemp,mkdir,writeFile,symlink,rm,realpath,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateStagedPaths} from './staged-artifact-manifest.ts';

test('staged paths reject symlinks in root, parents, required files and client tree',async()=>{
 const temp=await mkdtemp(join(await realpath(tmpdir()),'staged-paths-'));
 try {
  const root=join(temp,'parent','stage');
  await mkdir(join(root,'build/client/assets'),{recursive:true});
  for(const path of ['SHA256.txt',...paths]) await writeFile(join(root,path),'fixture');
  await validateStagedPaths(root);
  for(const path of ['SHA256.txt','wrangler.json','build/consolidated-worker.mjs','build/worker.mjs','build/client','build/client/assets','build/client/assets/app.js','build']) {
   const target=join(root,path), saved=target+'.saved';
   await rename(target,saved); await symlink(saved,target);
   try {await assert.rejects(validateStagedPaths(root),/symlink/,path);} finally {await rm(target); await rename(saved,target);}
  }
  await symlink(root,join(temp,'stage-link'));
  await assert.rejects(validateStagedPaths(join(temp,'stage-link')),/symlink/);
  await symlink(join(temp,'parent'),join(temp,'parent-link'));
  await assert.rejects(validateStagedPaths(join(temp,'parent-link','stage')),/symlink/);
 } finally {await rm(temp,{recursive:true,force:true});}
});
