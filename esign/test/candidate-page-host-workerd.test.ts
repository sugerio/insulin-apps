import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';

test('worker-first candidate host routes real generated assets through workerd', {timeout:60000},async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'candidate-workerd-'));
 let mf:Miniflare|undefined;
 try {
  const output=join(dir,'build');
  const recipient='https://recipient.example.test',editor='https://editor.example.test';
  const build=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:recipient,VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:editor}});
  assert.equal(build.status,0,build.stderr);
  // An existing but unlisted file demonstrates that the asset router cannot bypass the Worker.
  await writeFile(join(output,'client','demo.html'),'demo must not be served');
  const options={modules:true,script:await readFile(join(output,'worker.mjs'),'utf8'),compatibilityDate:'2025-01-01',assets:{directory:join(output,'client'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},bindings:{HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:recipient,EDITOR_GATEWAY_ORIGIN:editor}};
  mf=new Miniflare(options);
  for(const path of ['/candidate.html','/candidate-editor.html',...(await readdir(join(output,'client','assets'))).map(n=>'/assets/'+n)]) {
   const response=await mf.dispatchFetch('https://pages.example.test'+path,{headers:{cookie:'session=secret',authorization:'Bearer secret'}});
   assert.equal(response.status,200,path+' '+await response.clone().text());
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(join(output,'client',path)));
   assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
   assert.ok(!JSON.stringify([...response.headers]).includes('secret'));
  }
  for(const path of ['/','/demo.html','/index.html','/assets/not-generated.js','/candidate.html?x=1']) assert.equal((await mf.dispatchFetch('https://pages.example.test'+path)).status,404,path);
  await mf.dispose();mf=undefined;
  mf=new Miniflare({...options,bindings:{...options.bindings,RECIPIENT_GATEWAY_ORIGIN:recipient+':443'}});
  assert.equal((await mf.dispatchFetch('https://pages.example.test/candidate.html')).status,503);
 } finally {await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
